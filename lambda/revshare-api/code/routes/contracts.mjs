import { listContracts, getContract, putContract, deleteContract, listPartners, ulid,
         getLastUpload, putLastUpload, putUploadDoc, getUploadDoc } from '../db.mjs';
import * as dbModule from '../db.mjs';
import { normalizeContractRow, buildImportPlan, uploadDocFrom,
         contractWrites } from '../contracts.mjs';

// Fields a client may write. `sheetTerms` is import-preview data and is not stored;
// share terms live on the partner's rule, never on the contract row.
const WRITABLE = [
  // `entityId` points at an ENTITY record (2026-09-29). `counterParty` is KEPT beside it and is
  // never rewritten: a contract with no entityId still reads its own string, so nothing that
  // exists today changes until someone deliberately links it.
  'entityId',
  'merchantName', 'merchantType', 'counterParty', 'partnerId', 'installedUnits',
  'units', 'startDate', 'endDate', 'terminationNoticeDays',
  'autoRenewal', 'contractLink', 'notes',
  // Contact details are entered in the app, not imported — the source workbook has no
  // contact columns, so the importer never sets these and a re-import never clears them.
  'contactName', 'contactPhone', 'contactEmail',
  // Who at ChargeSpot owns the relationship. Comes in with the weekly merchant upload.
  'salesPerson',
  // Branch count, from the weekly upload's store rows per merchant label.
  'branchCount',
  // Where the payout is sent, plus the finance contact it is advised to — Merchant view's
  // "Finance Information" group. Entered in the app only: no upload file carries bank columns,
  // so an import can never overwrite or clear these. TH-only in the UI for now (the grid group
  // is guarded on REGION); the fields are region-neutral, so mirroring this list into the SG
  // repo is all Singapore needs.
  'bankName', 'bankAccountName', 'bankAccountNumber',
  'financeContactName', 'financeContactEmail',
  // The contract is the payout entity now: it owns the rule, how it aggregates, whether it
  // is paid at all, and in which currency. These were PARTNER fields until 2026-08-07.
  'rule', 'aggregationMode', 'noPayout', 'currency',
  // Manual archive, set when a contract ends. `archivedAt` is stamped server-side, not
  // taken from the client.
  'archived',
  // Order-report names assigned to this merchant from a run's unmatched list. Third and last
  // matching pass — see indexOrderAliases in payout.mjs. Each matching alias ADDS a store row
  // to this contract, so it counts as a machine for flat_per_machine / per-machine MG.
  'orderAliases',
];

function pick(body) {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  return out;
}

export async function listContractsRoute() {
  const items = await listContracts();
  items.sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  return resp(200, items);
}

// What the last weekly merchant upload contained. Read by the Merchant view so it can mark the
// contracts that file did NOT mention — an import never deletes, so without this they are
// invisible.
export async function lastUploadRoute() {
  return resp(200, await getLastUpload() || { at: null, names: [] });
}

// The Reconcile tab's other half. Separate from lastUploadRoute above because that one is read
// on every Merchant view paint for the ⦿ marks and must stay a single small DynamoDB read —
// this one fetches an S3 object and is wanted only when the tab is open. Returns a literal JSON
// `null` (not an empty body — `resp`'s null-means-204-empty-body shortcut doesn't apply here)
// when there is no stored document: a pointer recorded before this feature carries no `s3Key`,
// and that is a normal state for the frontend to treat as "no field-level data yet", not an error.
export async function lastUploadRowsRoute() {
  const ptr = await getLastUpload();
  const doc = ptr?.s3Key ? await getUploadDoc(ptr.s3Key) : null;
  return { statusCode: 200, body: JSON.stringify(doc) };
}

export async function createContractRoute(event) {
  const body = JSON.parse(event.body || '{}');
  if (!String(body.merchantName || '').trim()) {
    return resp(400, { error: 'missing_fields', required: ['merchantName'] });
  }
  const contract = { contractId: ulid(), partnerId: null, units: {}, notes: '', ...pick(body) };
  return resp(201, await putContract(contract));
}

export async function updateContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const body = JSON.parse(event.body || '{}');
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  const next = { ...existing, ...pick(body), contractId: id };
  // Stamp the archive date here rather than trusting a client clock, and only on the
  // transition — re-saving an already-archived row must not move the date.
  if (next.archived && !existing.archived) next.archivedAt = new Date().toISOString();
  if (!next.archived) delete next.archivedAt;
  return resp(200, await putContract(next));
}

export async function deleteContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteContract(id);
  return resp(204, null);
}

// POST /registry — write the store registry from the two uploaded files (2026-09-29).
//
// The registry used to be a side effect of running a payout: `applyMerchantRoster` upserted a row
// per roster shop. That meant a shop was unknown to the app until a run had been done, and a
// merchant that came and went left rows nothing ever corrected. Shop names come from the FILES,
// so the files write them.
//
// ADDITIVE, and narrowly so:
//   • a shop already in the registry keeps its merchantId, its externalId and its notes
//   • only `contractId`, `machineModel` and `externalId` can be refreshed, and only from a value
//     the file actually carries — a blank never clears one
//   • a shop the files do not mention is NEVER touched and never deleted: merchants come and go,
//     and the registry is not the place to decide one has gone
export async function putRegistryRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const shops = Array.isArray(body.shops) ? body.shops : [];
  if (!shops.length) return resp(400, { error: 'no_shops' });

  const [existing, contracts] = await Promise.all([dbModule.listMerchants(), listContracts()]);
  const live = new Set(contracts.filter(c => !c.archived).map(c => c.contractId));
  const byName = new Map();
  for (const m of existing) {
    const k = String(m.name ?? '').toLowerCase().trim();
    if (!k) continue;
    // Prefer the row that already points at a live contract — a store name commonly has several.
    const have = byName.get(k);
    if (!have || (!live.has(have.contractId) && live.has(m.contractId))) byName.set(k, m);
  }

  const rows = [];
  let created = 0, updated = 0, unchanged = 0;
  for (const shop of shops) {
    const name = String(shop.name ?? '').trim();
    const contractId = String(shop.contractId ?? '').trim();
    if (!name || !contractId || !live.has(contractId)) continue;
    const k = name.toLowerCase();
    const ex = byName.get(k);
    const row = {
      merchantId: ex?.merchantId || ulid(),
      createdAt: ex?.createdAt,
      name,
      contractId,
      partnerId: ex?.partnerId ?? null,
      machineModel: shop.machineModel || ex?.machineModel || null,
      externalId: shop.externalId || ex?.externalId || null,
      notes: ex?.notes || '',
    };
    if (!ex) { created++; rows.push(row); continue; }
    const same = ex.contractId === row.contractId
      && (ex.machineModel || null) === row.machineModel
      && (ex.externalId || null) === row.externalId;
    if (same) { unchanged++; continue; }
    updated++; rows.push(row);
  }
  if (rows.length) await dbModule.putMerchantsBatch(rows);
  return resp(200, { created, updated, unchanged, written: rows.length });
}

// POST /roster — store the parsed Businessmen list so a run does not ask for it again
// (2026-09-29). Rows, not counts: the engine counts roster rows and a row is a STATION, while
// `units` counts cabinets. Storing counts here would have paid BTS 412,000 instead of 144,000.
//
// A REVIEW does not store it, for the same reason a review writes no merchant row: nothing you
// have not applied should become what the next run is computed from.
export async function putRosterRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const merchants = Array.isArray(body.merchants) ? body.merchants : [];
  if (!merchants.length) return resp(400, { error: 'no_merchants' });

  // Remembering the file is ONE act, so the brand list it contained is recorded here too — that
  // is what the Merchant view's ⦿ marks compare against. It creates and changes no merchant:
  // `putLastUpload` writes a single CONFIG row of names, nothing else.
  let lastUpload = null;
  if (Array.isArray(body.names) && body.names.length) {
    lastUpload = await putLastUpload(body.names.filter(Boolean), { by: event.auth?.email || null });
  }
  const rec = await dbModule.putRoster({
    merchants,
    excluded: Array.isArray(body.excluded) ? body.excluded : [],
    machines: Array.isArray(body.machines) ? body.machines : [],
    machinesAt: body.machinesAt || null,
    machineStoreCount: body.machineStoreCount ?? null,
    by: event.auth?.email || null,
  });
  return resp(200, { ...rec, lastUpload });
}

// GET /roster — the pointer only, so a screen can say when the merchant list was last refreshed.
export async function getRosterRoute() {
  return resp(200, (await dbModule.getRosterMeta()) || { at: null });
}

export async function importContractsRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) return resp(400, { error: 'no_rows' });

  // `header` is header row 2 of the sheet. Columns 0-22 are read by position as always;
  // anything appended from 23 on is addressed by name from this row (see contracts.mjs).
  const header = Array.isArray(body.header) ? body.header : null;
  const groups = Array.isArray(body.groups) ? body.groups : null;   // row 1: the grid's categories
  const normalized = rawRows.map(r => normalizeContractRow(r, header, groups)).filter(Boolean);
  const [existing, partners] = await Promise.all([listContracts(), listPartners()]);
  const plan = buildImportPlan(normalized, existing, partners, body.links || {});

  // A review-only upload (`dryRun`) writes NO merchant rows — see contractWrites. Everything
  // else still happens: the file is parsed, the plan is built, and the upload is recorded, so
  // the Reconcile tab can say what differs without anything having changed underneath you.
  const dryRun = body.dryRun === true;
  const all = contractWrites(plan, { dryRun, newId: ulid });
  // Bounded concurrency — 208 rows would otherwise open 208 sockets at once.
  for (let i = 0; i < all.length; i += 10) {
    await Promise.all(all.slice(i, i + 10).map(putContract));
  }

  // Only the weekly batch upload is a statement about the WHOLE merchant list. The old sheet
  // importer and the CLI carry partial lists, so letting them record would mark every merchant
  // they happened to omit as missing. Opt in explicitly rather than inferring it from the shape.
  let lastUpload = null;
  if (body.recordUpload) {
    const doc = uploadDocFrom(normalized, {
      by: event.auth?.email || body.by || null,
      machineMisses: body.machineMisses || null,
    });
    const { key } = await putUploadDoc(doc);
    lastUpload = await putLastUpload(normalized.map(r => r.merchantName).filter(Boolean), {
      s3Key: key,
      // Named the same way the RESPONSE is, and for the same reason: a review that records
      // `created: 25` is a stored claim that 25 merchants were added, which is how the 21 Sep
      // review-only upload came to look applied while every contract kept its old updatedAt.
      // The stored record outlives the response, so it is the one that most needs to be honest.
      counts: dryRun
        ? { brands: doc.brands.length, dryRun: true,
            wouldCreate: plan.creates.length, wouldUpdate: plan.updates.length }
        : { brands: doc.brands.length,
            created: plan.creates.length, updated: plan.updates.length },
    });
  }

  // Named `would*` on a review so a caller cannot read a plan as an accomplished fact. A real
  // import keeps `created`/`updated`, which every existing caller already reads.
  return resp(200, dryRun
    ? { lastUpload, dryRun: true, wouldCreate: plan.creates.length,
        wouldUpdate: plan.updates.length, unmatched: plan.unmatched }
    : { lastUpload, created: plan.creates.length, updated: plan.updates.length,
        linked: all.filter(c => c.partnerId).length, unmatched: plan.unmatched });
}

function resp(statusCode, body) {
  return { statusCode, body: body === null ? '' : JSON.stringify(body) };
}
