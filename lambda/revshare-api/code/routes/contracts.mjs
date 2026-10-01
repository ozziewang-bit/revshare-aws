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
  const machines = Array.isArray(body.machines) ? body.machines : [];
  if (!merchants.length && !machines.length) return resp(400, { error: 'no_rows' });

  // A MACHINE-ONLY UPLOAD IS A REAL THING (2026-10-01). The two files are refreshed
  // independently — the machine list changes as machines are deployed, the merchant list as
  // merchants sign up — and this route used to reject anything without merchants, so uploading
  // the machine list on its own stored NOTHING and said nothing. The merchant half is carried
  // through from what is already recorded, with its own read time, so refreshing one file never
  // silently ages or discards the other.
  // Always read what is already recorded: whichever half this upload does NOT carry is carried
  // through from it, with its own read time.
  const prev = await dbModule.getRosterRows();
  const prevMeta = await dbModule.getRosterMeta();
  if (!merchants.length && !(prev && (prev.merchants || []).length)) {
    return resp(409, { error: 'no_merchant_list',
      message: 'There is no merchant list on record yet, so a machine list has nothing to '
             + 'attach to. Upload the merchant list first — the two can go up together.' });
  }

  // Remembering the file is ONE act, so the brand list it contained is recorded here too — that
  // is what the Merchant view's ⦿ marks compare against. It creates and changes no merchant:
  // `putLastUpload` writes a single CONFIG row of names, nothing else.
  let lastUpload = null;
  if (Array.isArray(body.names) && body.names.length) {
    lastUpload = await putLastUpload(body.names.filter(Boolean), { by: event.auth?.email || null });
  }
  const hasMerchants = merchants.length > 0;
  const hasMachines = machines.length > 0;
  const rec = await dbModule.putRoster({
    merchants: hasMerchants ? merchants : (prev.merchants || []),
    excluded: hasMerchants ? (Array.isArray(body.excluded) ? body.excluded : [])
                           : (prev.excluded || []),
    machines: hasMachines ? machines : ((prev && prev.machines) || []),
    // Each half keeps the time ITS file was read. Refreshing one must never restamp the other,
    // or a machine upload would make a three-day-old merchant list look like today's.
    at: hasMerchants ? null : (prevMeta?.at || null),
    machinesAt: hasMachines ? (body.machinesAt || new Date().toISOString())
                            : (prevMeta?.machinesAt || null),
    machineStoreCount: hasMachines ? (body.machineStoreCount ?? null)
                                   : (prevMeta?.machineStoreCount ?? null),
    machinesUnbound: hasMachines ? (body.machinesUnbound ?? null) : null,
    by: event.auth?.email || null,
  });
  return resp(200, { ...rec, lastUpload });
}

// GET /roster — the pointer only, so a screen can say when the merchant list was last refreshed.
export async function getRosterRoute() {
  return resp(200, (await dbModule.getRosterMeta()) || { at: null });
}

// ── Branches and machines come from the FILE (2026-10-01) ────────────────────────────────────
// The user's model, stated plainly: "if my files says 5, then it is 5". Merchant INFORMATION —
// brand, branches, machine counts, contacts — is read from the weekly upload and never edited.
// The grid was showing `branchCount`/`units` stored on the CONTRACT instead, which are only as
// fresh as the last import that happened to touch them: `Central` read 10 branches and 10 LL40
// while the file had 5 of each, a leftover from before that brand was split per mall.
//
// This serves the FILE's own counts, aggregated per `Merchant label`, so the grid can show them
// without anything being written. Nothing here modifies a contract — the stored columns stay
// exactly as they are, and remain the fallback for a brand the latest file does not mention.
//
// A roster row is a STATION. Counting rows per model is therefore the same unit the payout
// counts (§1h) — a 4-cabinet BTS station is one here and one there, and the two cannot disagree.
// The machine list's cabinet counts are a different number and are reported separately.
export function brandsFromRoster(merchants, machines) {
  const brands = new Map();
  for (const r of merchants || []) {
    const label = String(r.partnerName || '').trim();
    if (!label) continue;
    const key = label.toLowerCase();
    if (!brands.has(key)) brands.set(key, { label, shops: new Set(), units: {} });
    const b = brands.get(key);
    const shop = String(r.name || '').trim();
    if (shop) b.shops.add(shop.toLowerCase());
    const model = String(r.model || '').trim();
    if (model) b.units[model] = (b.units[model] || 0) + 1;
  }

  // The machine list, when the upload kept its rows, gives CABINETS per shop. Attached per brand
  // by shop name, which is the only identifier the two files share.
  const cabinetsOf = new Map();
  for (const m of machines || []) {
    const shop = String(m.store || '').trim().toLowerCase();
    if (shop) cabinetsOf.set(shop, m.counts || {});
  }
  const out = {};
  for (const [key, b] of brands) {
    let cabinets = null;
    if (cabinetsOf.size) {
      cabinets = {};
      for (const shop of b.shops) {
        for (const [model, n] of Object.entries(cabinetsOf.get(shop) || {})) {
          cabinets[model] = (cabinets[model] || 0) + (Number(n) || 0);
        }
      }
    }
    // The merchant NAMES too (C5, 2026-10-01): the run view marks a merchant the latest file no
    // longer carries, and that can only be answered by the file's own list. ~100 KB for 2,380
    // merchants across 303 brands, against a comparison that already crosses the wire.
    out[key] = { label: b.label, branches: b.shops.size, units: b.units, cabinets,
                 merchantNames: [...b.shops] };
  }
  return out;
}

// ── The shops behind a branch count (2026-10-01) ─────────────────────────────────────────────
// Clicking the Branch number in the Merchant view opens the shops it counts. Straight from the
// uploaded file, which is what that number already comes from: the Thai name, the English name,
// the Merchant label the brand is grouped under, and the machine.
//
// The non-Approved rows come too, kept apart. A branch count is Approved-only, so a shop held
// back by its review state is missing from the list with no explanation unless it is named —
// and "where is that shop?" is exactly the question this view exists to answer.
export function shopsOfBrand(doc, brand) {
  const key = s => String(s || '').trim().toLowerCase();
  const want = key(brand);
  if (!want) return { shops: [], heldBack: [] };

  const shops = [], seen = new Set();
  for (const r of (doc && doc.merchants) || []) {
    if (key(r.partnerName) !== want) continue;
    const k = key(r.name);
    if (!k || seen.has(k)) continue;        // a shop with two stations is ONE branch
    seen.add(k);
    shops.push({
      name: String(r.name || '').trim(),
      nameEn: String(r.nameEn || '').trim(),
      label: String(r.partnerName || '').trim(),
      model: r.model || null,
      externalId: String(r.externalId || '').trim() || null,
    });
  }
  // Stations beyond the first are counted here rather than dropped: the branch count is shops,
  // the unit count is stations, and showing one without the other invites the wrong subtraction.
  const stations = ((doc && doc.merchants) || []).filter(r => key(r.partnerName) === want).length;

  const heldBack = [];
  for (const r of (doc && doc.excluded) || []) {
    if (key(r.label) !== want) continue;
    heldBack.push({ name: String(r.name || '').trim(), reviewState: r.reviewState || null });
  }
  shops.sort((a, b) => a.name.localeCompare(b.name));
  return { shops, heldBack, stations };
}

export async function rosterShopsRoute(event) {
  const brand = event?.queryStringParameters?.brand;
  if (!brand) return resp(400, { error: 'missing_brand' });
  const [meta, doc] = await Promise.all([dbModule.getRosterMeta(), dbModule.getRosterRows()]);
  return resp(200, { at: meta?.at || null, brand, ...shopsOfBrand(doc, brand) });
}

// ── A shop whose registry row points at the wrong merchant (2026-10-01) ──────────────────────
// The store registry maps shop -> contract. It is how `Assign→` decides which merchant an order
// belongs to, and it OUTLIVES the thing it points at: a brand split in two, a shop that changed
// hands, a merchant deleted — the old row stays. Measured 1 Oct: 6,770 rows for 2,540 shops, 33
// shop ids claimed by more than one contract.
//
// The file is the answer. Where it names a brand and the registry names a DIFFERENT live
// merchant for the same shop, that is a real disagreement someone has to settle.
//
// Reported only when BOTH sides name a merchant that still exists. A row pointing at a deleted
// or archived contract is a stale link, not a competing answer — counting those would bury the
// handful that matter under a list about merchants that are not there any more. That is the same
// rule `matchMachineStores` applies on the upload, deliberately: two screens, one definition.
//
// This reads the STORED roster, so it needs no file to be uploaded — which is the whole point of
// it being here rather than only in the machine-list flow.
export function shopConflicts(rosterMerchants, registry, contracts) {
  const key = s => String(s || '').toLowerCase().trim();
  const live = new Map();                       // contractId -> contract, live only
  const liveByName = new Map();                 // merchantName -> contractId, live only
  for (const c of contracts || []) {
    if (!c || c.archived || !c.contractId) continue;
    live.set(c.contractId, c);
    const k = key(c.merchantName);
    if (k && !liveByName.has(k)) liveByName.set(k, c.contractId);
  }

  // The registry's answer per shop, preferring a live link over a dead one — a shop routinely has
  // several rows, and letting a dangling pointer speak for it is how a shop appears to have moved
  // away from a merchant that two of its three rows still name.
  const regOf = new Map(), rowsOf = new Map();
  for (const m of registry || []) {
    const k = key(m.name);
    if (!k) continue;
    rowsOf.set(k, (rowsOf.get(k) || 0) + 1);
    if (!m.contractId) continue;
    const have = regOf.get(k);
    if (!have || (!live.has(have) && live.has(m.contractId))) regOf.set(k, m.contractId);
  }

  const out = [];
  const seen = new Set();
  for (const r of rosterMerchants || []) {
    const shop = String(r.name || '').trim();
    const k = key(shop);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const fileCid = liveByName.get(key(r.partnerName));
    const regCid = regOf.get(k);
    if (!fileCid || !regCid || regCid === fileCid || !live.has(regCid)) continue;
    out.push({
      shop,
      fileBrand: String(r.partnerName || '').trim(),
      fileContractId: fileCid,
      registryContractId: regCid,
      registryBrand: live.get(regCid).merchantName || '',
      rows: rowsOf.get(k) || 0,
      model: r.model || null,
    });
  }
  out.sort((a, b) => a.fileBrand.localeCompare(b.fileBrand) || a.shop.localeCompare(b.shop));
  return out;
}

// ── Merchant review state against machine state (2026-10-01) ─────────────────────────────────
// What reaches the registry is a shop that is APPROVED and has a machine DEPLOYED and BOUND to
// it. Three ways the two files disagree about that, and each is somebody's job to go and fix:
//
//   • not approved, yet machines are deployed under it  — earning while the paperwork lags
//   • approved, yet nothing is deployed                 — a merchant signed up with no machine
//   • a machine deployed under a shop no merchant file names
//
// The machine export carries `State` per machine and a `Business ID`/`Business name` it is bound
// to. Neither was read until now, so none of these questions could be asked.
export function machineCheck(doc, cap = 400) {
  const key = s => String(s || '').toLowerCase().trim();
  const out = { notApprovedDeployed: [], approvedNoDeployed: [], deployedUnbound: [] };
  const counts = { notApprovedDeployed: 0, approvedNoDeployed: 0, deployedUnbound: 0,
                   unboundMachines: 0, hasMachineFile: false };
  if (!doc) return { ...out, counts, cap };

  const machines = new Map();
  for (const m of doc.machines || []) {
    const k = key(m.store);
    if (k) machines.set(k, m);
  }
  // A stored machine row only answers these questions if it CARRIES the state. Rows written
  // before 2026-10-01 have counts and no `deployed`, and reading those as "nothing is deployed"
  // reported all 2,380 shops as having no machine — 2,380 findings, every one false. The absence
  // of the field means "not known", which is not the same as zero.
  const withState = [...machines.values()].some(m => Number.isFinite(Number(m.deployed)));
  counts.hasMachineFile = machines.size > 0 && withState;
  counts.unboundMachines = Number(doc.machinesUnbound) || 0;
  // Without machine state there is nothing to compare, and saying every merchant has no machine
  // would be a page of findings about a file nobody has uploaded yet.
  if (!counts.hasMachineFile) return { ...out, counts, cap };

  const seen = new Set();
  for (const r of doc.merchants || []) {
    const k = key(r.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const m = machines.get(k);
    if (!m || !(Number(m.deployed) > 0)) {
      counts.approvedNoDeployed++;
      if (out.approvedNoDeployed.length < cap) {
        out.approvedNoDeployed.push({ name: String(r.name).trim(), brand: String(r.partnerName || '').trim(),
                                      machines: m ? Number(m.total) || 0 : 0 });
      }
    }
  }
  for (const r of doc.excluded || []) {
    const k = key(r.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const m = machines.get(k);
    if (m && Number(m.deployed) > 0) {
      counts.notApprovedDeployed++;
      if (out.notApprovedDeployed.length < cap) {
        out.notApprovedDeployed.push({ name: String(r.name).trim(), brand: String(r.label || '').trim(),
                                       state: r.reviewState || 'held back', deployed: Number(m.deployed) || 0 });
      }
    }
  }
  for (const [k, m] of machines) {
    if (seen.has(k)) continue;
    if (!(Number(m.deployed) > 0)) continue;
    counts.deployedUnbound++;
    if (out.deployedUnbound.length < cap) {
      out.deployedUnbound.push({ name: m.store, deployed: Number(m.deployed) || 0,
                                 businessId: m.businessId || null });
    }
  }
  return { ...out, counts, cap };
}

// ── The file against the registry (2026-10-01) ───────────────────────────────────────────────
// "compare my file with the registry, point out what's mismatched and a button to allow us
// update the registry."
//
// The registry is the shop index: shop -> merchant. The file states the same thing weekly and is
// the authority. This reports every way the two differ, in buckets that need different actions —
// a shop with no row is an add, a wrong link is a repoint, a row with no link is a link.
//
// REVIEW STATE IS NOT A FILTER HERE. A shop held back by the platform's review is still a shop,
// and the user's rule is explicit: run share and approved status are not related. The state is
// carried on each row so it can be seen, never used to drop one.
//
// Pure. Caps what it returns per bucket so a 1,900-row answer cannot become the payload.
export function registryCheck(doc, registry, contracts, cap = 400) {
  const key = s => String(s || '').toLowerCase().trim();
  const live = new Map();
  const byBrand = new Map();
  for (const c of contracts || []) {
    if (!c || c.archived || !c.contractId) continue;
    live.set(c.contractId, c);
    const k = key(c.merchantName);
    if (k && !byBrand.has(k)) byBrand.set(k, c.contractId);
  }

  // Every shop the file names, Approved or not, with where the file puts it.
  const file = new Map();
  for (const r of (doc && doc.merchants) || []) {
    const k = key(r.name);
    if (k && !file.has(k)) file.set(k, { name: String(r.name).trim(), brand: String(r.partnerName || '').trim(),
                                         state: 'Approved', model: r.model || null,
                                         externalId: String(r.externalId || '').trim() || null });
  }
  for (const r of (doc && doc.excluded) || []) {
    const k = key(r.name);
    if (k && !file.has(k)) file.set(k, { name: String(r.name).trim(), brand: String(r.label || '').trim(),
                                         state: r.reviewState || 'held back', model: null, externalId: null });
  }

  const rows = new Map();
  for (const m of registry || []) {
    const k = key(m.name);
    if (!k) continue;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(m);
  }

  // WHAT REACHES THE REGISTRY (user, rule A2): a merchant that is APPROVED and has a machine
  // DEPLOYED and BOUND to it. Offering an "Add" button for anything else asks for something the
  // rule forbids — and it is why a Pending merchant appeared both here and under "Not approved,
  // machines live". Measured 2026-10-01: of 347 listed, 334 were Disapproved and 11 Pending; only
  // 2 qualified.
  //
  // The deployed test applies only where the machine state is actually known: a stored machine
  // row from before 2026-10-01 carries counts and no `deployed`, and treating that as "nothing is
  // deployed" would empty the list for the wrong reason.
  const machinesOf = new Map();
  for (const m of (doc && doc.machines) || []) {
    const k = key(m.store);
    if (k) machinesOf.set(k, m);
  }
  const stateKnown = [...machinesOf.values()].some(m => Number.isFinite(Number(m.deployed)));
  const qualifies = (f) => {
    if (f.state !== 'Approved') return false;
    if (!stateKnown) return true;
    const m = machinesOf.get(key(f.name));
    return !!(m && Number(m.deployed) > 0);
  };
  const pick = (list) => list.find(r => r.contractId && live.has(r.contractId)) || list[0];

  // ONE NAME, ONE PAGE (2026-10-01). A brand with a single merchant shares its name with that
  // merchant, so the same fact surfaced twice: `Minato Shokudou` as an unregistered BRAND and as
  // a MERCHANT with no brand linked. Precedence — the brand is fixed first, because registering
  // it resolves every merchant under it, so those merchants are counted here and listed on the
  // brand tab, never in both. Same rule `uploadTableHtml` already applies to its own buckets.
  const out = { missing: [], wrongLink: [], noLink: [], notInFile: [], duplicated: [] };
  const counts = { missing: 0, missingNoMerchant: 0, wrongLink: 0, noLink: 0, notInFile: 0,
                   duplicated: 0, duplicateRows: 0, onBrandTab: 0, notEligible: 0 };

  // Brands the file names that are not registered, and registered brands the file has dropped —
  // both already have a tab of their own.
  const unregistered = new Set();
  for (const f of file.values()) if (f.brand && !byBrand.has(key(f.brand))) unregistered.add(key(f.brand));
  const fileBrands = new Set([...file.values()].map(f => key(f.brand)).filter(Boolean));
  const departed = new Set();
  for (const c of contracts || []) {
    if (c && !c.archived && c.merchantName && !fileBrands.has(key(c.merchantName))) {
      departed.add(c.contractId);
    }
  }
  const onBrandTab = (brand, contractId) =>
    (brand && unregistered.has(key(brand))) || (contractId && departed.has(contractId));

  for (const [k, f] of file) {
    const want = byBrand.get(key(f.brand)) || null;
    const list = rows.get(k);
    if (!list) {
      // No row at all. Actionable only when the brand is registered AND the merchant qualifies
      // under rule A2 — otherwise adding it is not something anyone should be offered.
      if (!want) { counts.missingNoMerchant++; continue; }
      if (!qualifies(f)) { counts.notEligible++; continue; }
      counts.missing++;
      if (out.missing.length < cap) out.missing.push({ ...f, contractId: want });
      continue;
    }
    if (list.length > 1) {
      counts.duplicated++; counts.duplicateRows += list.length - 1;
      if (out.duplicated.length < cap) out.duplicated.push({ name: f.name, state: f.state, rows: list.length });
    }
    const r = pick(list);
    const linked = r.contractId && live.has(r.contractId);
    if (!linked) {
      // Its brand is not registered — the fix is on the brand tab, and listing the merchant here
      // too would ask for the same thing twice.
      if (onBrandTab(f.brand, null)) { counts.onBrandTab++; continue; }
      counts.noLink++;
      if (out.noLink.length < cap) out.noLink.push({ ...f, rows: list.length, contractId: want });
    } else if (want && r.contractId !== want) {
      counts.wrongLink++;
      if (out.wrongLink.length < cap) {
        out.wrongLink.push({ ...f, rows: list.length, contractId: want,
                             registryBrand: live.get(r.contractId).merchantName || '' });
      }
    }
  }
  for (const [k, list] of rows) {
    if (file.has(k)) continue;
    const r = pick(list);
    // Its whole brand has left the file; that tab says so once, for the brand.
    if (onBrandTab(null, r.contractId)) { counts.onBrandTab++; continue; }
    counts.notInFile++;
    if (out.notInFile.length < cap) {
      out.notInFile.push({ name: r.name, rows: list.length,
                           brand: (live.get(r.contractId) || {}).merchantName || null });
    }
  }
  return { ...out, counts, cap };
}

export async function registryCheckRoute() {
  const [meta, doc, contracts, registry] = await Promise.all([
    dbModule.getRosterMeta(), dbModule.getRosterRows(), listContracts(), dbModule.listMerchants(),
  ]);
  return resp(200, { at: meta?.at || null,
                     machinesAt: meta?.machinesAt || null,
                     ...(doc ? registryCheck(doc, registry, contracts)
                             : registryCheck(null, [], contracts)),
                     machineCheck: machineCheck(doc) });
}

// Read-only. The registry is several MB, so the comparison happens HERE and only the handful of
// disagreements crosses the wire.
export async function rosterConflictsRoute() {
  const [meta, doc, contracts, registry] = await Promise.all([
    dbModule.getRosterMeta(), dbModule.getRosterRows(), listContracts(), dbModule.listMerchants(),
  ]);
  return resp(200, {
    at: meta?.at || null,
    conflicts: doc ? shopConflicts(doc.merchants, registry, contracts) : [],
  });
}

// Read-only. 302 brands is a few KB, so it loads beside the contract list.
export async function rosterBrandsRoute() {
  const meta = await dbModule.getRosterMeta();
  const doc = await dbModule.getRosterRows();
  return resp(200, {
    at: meta?.at || null,
    by: meta?.by || null,
    machinesAt: meta?.machinesAt || null,
    brands: doc ? brandsFromRoster(doc.merchants, doc.machines) : {},
  });
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
