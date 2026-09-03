import { listContracts, getContract, putContract, deleteContract, listPartners, ulid,
         getLastUpload, putLastUpload } from '../db.mjs';
import { normalizeContractRow, buildImportPlan } from '../contracts.mjs';

// Fields a client may write. `sheetTerms` is import-preview data and is not stored;
// share terms live on the partner's rule, never on the contract row.
const WRITABLE = [
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

  // Bounded concurrency — 208 rows would otherwise open 208 sockets at once.
  const all = [...plan.creates.map(c => ({ ...c, contractId: ulid() })), ...plan.updates];
  for (let i = 0; i < all.length; i += 10) {
    await Promise.all(all.slice(i, i + 10).map(putContract));
  }

  // Only the weekly batch upload is a statement about the WHOLE merchant list. The old sheet
  // importer and the CLI carry partial lists, so letting them record would mark every merchant
  // they happened to omit as missing. Opt in explicitly rather than inferring it from the shape.
  let lastUpload = null;
  if (body.recordUpload) {
    lastUpload = await putLastUpload(normalized.map(r => r.merchantName).filter(Boolean));
  }

  return resp(200, {
    lastUpload,
    created: plan.creates.length,
    updated: plan.updates.length,
    linked: all.filter(c => c.partnerId).length,
    unmatched: plan.unmatched,
  });
}

function resp(statusCode, body) {
  return { statusCode, body: body === null ? '' : JSON.stringify(body) };
}
