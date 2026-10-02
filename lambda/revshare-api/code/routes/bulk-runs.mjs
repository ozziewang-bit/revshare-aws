import { listMerchants, putBulkRun, listBulkRuns, getBulkRun, getBulkRunInputs, deleteBulkRun, listMachineModels, ulid, listContracts, getContract } from '../db.mjs';
import * as dbModule from '../db.mjs';
import { evaluateRun } from '../engine.mjs';
import { ruleHasValue, contractNeedsTerms, indexContractsByName, resolveLabel, merchantRowChanged, indexOrderAliases } from '../payout.mjs';

// A *named* import of DEFAULT_CURRENCY (`import { DEFAULT_CURRENCY } from '../db.mjs'`) is a
// static ESM binding: if the target db.mjs doesn't export that name, the whole module fails
// to load — no partial degradation, the entire Lambda 500s. This file is synced verbatim to
// Singapore, but db.mjs is deliberately never synced (it holds each region's table/bucket) —
// so a straight named import here would crash SG the moment this file deploys ahead of SG's
// db.mjs being updated by hand. Read it off the namespace object instead: that's a plain
// property access, not a static binding, so it degrades to the 'THB' fallback below until the
// SG db.mjs mirror lands, instead of taking the whole API down. (This exact ordering hazard is
// what took Singapore down for three hours earlier in this project.)
const DEFAULT_CURRENCY = dbModule.DEFAULT_CURRENCY || 'THB';

// Run fn over items with at most `limit` in flight. Keeps a full-roster (~1600 writes)
// well under the 29s API Gateway timeout that a sequential loop would blow past.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
  }));
  return results;
}

// Roster-authoritative grouping: one row per roster machine (0/0), orders overlaid onto it;
// orders that resolve to no roster row are unmatched (not paid).
//
// Orders are matched in TWO passes (2026-08-24):
//   1. by store name — the order report identifies a store only by its name string;
//   2. for whatever is left, by machine number -> Business ID -> the roster row's externalId,
//      using the optional Machine List (`machineIndex`);
//   3. finally by explicit alias (`aliasIndex`), assigned by a human from a run's unmatched
//      list. An alias ADDS a store row to the target contract — it does not merge into an
//      existing one — so it counts as a machine for flat_per_machine and per-machine MG.
//      That is deliberate (a merchant's own decision, 2026-08-24), but it is why pass 3 runs
//      LAST: when the machine number proves the store is already in the roster, merging into
//      the real row is right and inventing a second row for the same machine would overpay.
// Pass 2 exists because the platform can rename a store in one export and not the other:
// "รถไฟฟ้ามหานคร สถานีมีนบุรี" in the merchant list is "รถไฟฟ้ามหานคร สถานีตลาดมีนบุรี" in the
// order report — the same store, same Business ID, tagged BTS, whose revenue was paid to
// nobody. Name wins when both agree because it is the join that has always been used and
// needs no extra upload; on the 2026-08 data the two never disagreed (0 of 7,103 orders).
// Without a machineIndex this behaves exactly as it did before.
export function buildRosterRows(roster, orders, machineIndex, aliasIndex) {
  const groups = {};                 // contractId -> [ {merchantId, merchantName, model, rentals, revenue} ]
  const byName = {};                 // nameLower -> row (pass 1)
  const byExternalId = {};           // roster ID / Business ID -> row (pass 2)
  for (const m of roster) {
    // Defence in depth, not a live path: applyMerchantRoster auto-creates a noPayout stub
    // CONTRACT for every roster label (see below), so in production no roster row reaches
    // this function without a contractId. This guard only protects a caller that hands
    // buildRosterRows unresolved rows directly (e.g. a test, or a future caller that skips
    // applyMerchantRoster) — it does NOT mean an order against such a brand lands in
    // `unmatched`; that only happens for order names with no roster row at all. A brand with
    // a contractId but no payout (noPayout, or no paying rule) still matches its orders here
    // and shows up in the run's `skipped` list instead (see payoutDecision).
    if (!m.contractId) continue;
    const row = { merchantId: m.merchantId, merchantName: m.name, model: m.model || 'S8', rentals: 0, revenue: 0 };
    (groups[m.contractId] = groups[m.contractId] || []).push(row);
    byName[(m.nameLower || m.name || '').toLowerCase().trim()] = row;
    const ext = String(m.externalId ?? '').trim();
    if (ext) byExternalId[ext] = row;
  }
  // Per-name totals, not just a name list: a run that reports "165 orders / 5,590 unmatched"
  // and a bare list of names cannot answer "how much is THIS store losing?" after the fact,
  // and the raw orders are gone once the request ends.
  const unmatchedByName = new Map();
  let unmatchedOrderCount = 0, unmatchedRevenue = 0;
  const recovered = new Map();       // order-report name -> what pass 2 resolved it to
  const aliased = new Map();         // order-report name -> what pass 3 (explicit alias) hit
  for (const order of orders) {
    const { merchantName, netAmount } = order;
    let row = byName[(merchantName || '').toLowerCase().trim()];
    if (!row && machineIndex) {
      const businessId = machineIndex[String(order.machineNo ?? '').trim()];
      const hit = businessId ? byExternalId[String(businessId).trim()] : null;
      if (hit) {
        row = hit;
        // Surface every rename rather than absorbing it: a store matched only by machine
        // means the two exports disagree about its name, which someone should fix at source.
        const rec = recovered.get(merchantName)
          || { orderName: merchantName, rosterName: hit.merchantName, orders: 0, revenue: 0 };
        rec.orders++; rec.revenue += Number(netAmount) || 0;
        recovered.set(merchantName, rec);
      }
    }
    if (!row && aliasIndex) {
      const alias = aliasIndex.get((merchantName || '').toLowerCase().trim());
      if (alias) {
        // The contract may have no roster stores at all — that is exactly the case for a
        // merchant created from the unmatched list, which exists only as an alias target.
        const group = groups[alias.contractId] = groups[alias.contractId] || [];
        // Created lazily, on first matching order: an alias with no orders must NOT mint a
        // 0/0 store row, or a flat_per_machine merchant would be paid placement for a machine
        // that never existed, purely because a name was assigned once.
        const id = `alias:${alias.contractId}:${(merchantName || '').toLowerCase().trim()}`;
        row = group.find(r => r.merchantId === id);
        if (!row) {
          row = { merchantId: id, merchantName, model: alias.machineModel || 'S8', rentals: 0, revenue: 0 };
          group.push(row);
        }
        const rec = aliased.get(merchantName)
          || { name: merchantName, contractId: alias.contractId, orders: 0, revenue: 0 };
        rec.orders++; rec.revenue += Number(netAmount) || 0;
        aliased.set(merchantName, rec);
      }
    }
    if (!row) {
      const u = unmatchedByName.get(merchantName) || { name: merchantName, orders: 0, revenue: 0 };
      u.orders++; u.revenue += Number(netAmount) || 0;
      unmatchedByName.set(merchantName, u);
      unmatchedOrderCount++; unmatchedRevenue += Number(netAmount) || 0;
      continue;
    }
    row.rentals++; row.revenue += Number(netAmount) || 0;
  }
  // `unmatched` (names only) is kept as-is: the CSV download and every already-stored run
  // depend on that shape.
  return { groups, unmatched: [...unmatchedByName.keys()], unmatchedOrderCount, unmatchedRevenue,
           unmatchedDetail: [...unmatchedByName.values()].sort((a, b) => b.revenue - a.revenue),
           matchedByMachine: [...recovered.values()],
           matchedByAlias: [...aliased.values()] };
}

// Machine counts per contract, straight from the roster. The Merchant view's unit columns were
// hand-typed and drifted from what is actually deployed; a run refreshes them.
//
// This counts ROSTER ROWS per model, which is the same unit the payout uses: evalFlatPerMachine
// sums one per roster row, and a minimum guarantee is per station rather than per cabinet (user,
// 2026-08-27). So a BTS station holding four machines is one unit here exactly as it is one unit
// in the payout — the two never disagree. The Machine List would give true cabinet counts, but it
// is an optional upload and would mean something different from the payout.
export function rosterUnitCounts(roster) {
  const byContract = new Map();
  for (const r of roster || []) {
    if (!r.contractId) continue;
    const m = byContract.get(r.contractId) || {};
    // A row whose device type did not parse still exists, it just has no model to count against.
    if (r.model) m[r.model] = (m[r.model] || 0) + 1;
    byContract.set(r.contractId, m);
  }
  return byContract;
}

const sameCounts = (a, b) => {
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
  // Key order is not preserved by DynamoDB, so compare sorted keys rather than stringifying —
  // a JSON.stringify diff reports a phantom change on every single run.
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && Number(a[k]) === Number(b[k]));
};

// Contracts whose stored counts differ from the roster, as ready-to-write rows. A contract with
// no roster rows this period is absent from `counts` and is left completely alone — a brand
// missing from one upload must not have its unit counts wiped.
export function unitsChanged(contracts, counts) {
  const out = [];
  for (const c of contracts || []) {
    const next = counts.get(c.contractId);
    if (!next) continue;
    const total = Object.values(next).reduce((a, b) => a + b, 0);
    if (sameCounts(c.units || {}, next) && Number(c.installedUnits || 0) === total) continue;
    out.push({ ...c, units: next, installedUnits: total });
  }
  return out;
}

// Tag unmatched stores that ARE in the merchant list but were filtered out for not being
// Approved. The roster upload keeps Approved rows only, so a Disapproved store still taking
// rentals arrives here looking identical to a name nobody recognises — and they are not the
// same thing at all. One is unknown; the other is a machine the platform knows about, earning
// money, held out by a review flag. In July that was 6 stores and 910 THB (17% of unmatched),
// including two live 7-Eleven branches and a Lawson.
//
// `excluded` is what the browser dropped: [{ name, label, reviewState }]. Absent (an older
// frontend) means no classification, never an error.
export function annotateUnmatched(unmatchedDetail, excluded) {
  if (!excluded || !excluded.length) return unmatchedDetail;
  const byName = new Map();
  for (const e of excluded) {
    const k = String(e?.name ?? '').toLowerCase().trim();
    if (k && !byName.has(k)) byName.set(k, e);
  }
  return (unmatchedDetail || []).map((u) => {
    const hit = byName.get(String(u.name ?? '').toLowerCase().trim());
    return hit ? { ...u, reviewState: hit.reviewState || 'Not approved', label: hit.label || '' } : u;
  });
}

// Machine List (optional upload) -> { machineNo: businessId }. Pass 2's lookup table.
export function indexMachines(machines) {
  const idx = {};
  for (const m of machines || []) {
    const no = String(m?.machineNo ?? '').trim();
    const biz = String(m?.businessId ?? '').trim();
    if (no && biz) idx[no] = biz;
  }
  return idx;
}

// A roster row's `Merchant label` is the brand. Resolve it to a Merchant-view row.
//
// A RUN NEVER WRITES TO THE MERCHANT TABLE (user, 2026-09-03). The merchant list is curated
// from the weekly upload on the Merchant view; the platform's roster is a run input and must
// not edit it. Two write-backs were removed here for that reason:
//   - the contract stub minted for an unresolvable label (it grew the table to 341 rows
//     against a curated list of ~260, and every one of them arrived unasked-for)
//   - the machine-count refresh onto `units`/`installedUnits`, which overwrote typed numbers
//     with the platform's on every run. No payout is affected: engine.mjs never reads `units`
//     — flat_per_machine and per-machine MG count ROSTER ROWS at run time. Refreshing those
//     counts deliberately is still available as infra/refresh-units-from-roster.mjs.
// An unresolvable label still gets an IN-MEMORY stub, so the run itself is computed exactly as
// before: its orders match, and its revenue lands in the run's `skipped` list under the brand's
// own name rather than disappearing into `unmatched` as a set of store names. The stub is never
// persisted, so the brand does not appear in the Merchant view; `newMerchants` now reports
// brands the roster has and your table does not.
//
// A RUN WRITES NOTHING (2026-09-29). It used to upsert the store registry from the roster, which
// meant a shop only became known to the app after a run had been done — and a merchant that came
// and went left rows behind that nothing corrected. The registry is now written by the UPLOAD,
// from the two files, which is where shop names come from in the first place.
//
// The batch writer is no longer imported by this module AT ALL, exactly as the contract writer
// stopped being imported in the 2026-09-03 change: reintroducing either write means adding an
// import back, which is a visible act rather than a line that drifts in. `persist` stays in the
// signature because infra/rerun-bulk-run.mjs passes it, and it now changes nothing — a run
// persists nothing either way, which is what makes a dry run honest by construction.

// ── Merchants the current file has dropped, recovered from an earlier one (C5, 2026-10-01) ───
// "there will be brands or merchants that is not registered anymore, it's ok, because they come
// and go, and we still need to calculate to pay... do calculation by archived files for brands or
// merchants that are gone in between my file updates."
//
// A merchant that left the file between the period and the run would otherwise be unresolvable:
// its rentals land in `unmatched` and its brand is paid nothing for them. Earlier uploads are
// kept, so the answer is already on record.
//
// ONLY WHEN THE PERIOD'S ORDERS NAME IT. A roster row is a STATION, and `flat_per_machine` and
// per-machine MG count rows — so adding a departed merchant that earned nothing would raise a
// guarantee every month for a merchant that no longer exists. Same rule the order aliases follow
// (§1d): no matching orders, no row.
async function recoverDepartedMerchants(merchants, orders) {
  const key = s => String(s || '').toLowerCase().trim();
  const have = new Set(merchants.map(m => key(m.name)));
  const wanted = new Set();
  for (const o of orders || []) {
    const k = key(o.merchantName);
    if (k && !have.has(k)) wanted.add(k);
  }
  if (!wanted.size) return { merchants, recovered: [] };

  const recovered = [];
  for (const k of await dbModule.listRosterHistory()) {
    if (!wanted.size) break;
    const doc = await dbModule.getRosterDoc(k);
    for (const m of (doc && doc.merchants) || []) {
      const mk = key(m.name);
      if (!wanted.has(mk)) continue;
      wanted.delete(mk);
      // Marked, so the run can say the row came from an older file rather than today's.
      recovered.push({ ...m, fromArchivedFile: k });
    }
  }
  return { merchants: recovered.length ? [...merchants, ...recovered] : merchants, recovered };
}

export async function applyMerchantRoster(merchants, { persist = true } = {}) {
  const [contracts, existingMerchants] = await Promise.all([listContracts(), listMerchants()]);
  let index = indexContractsByName(contracts);
  const merchantByName = {};
  for (const m of existingMerchants) merchantByName[m.nameLower] = m;

  const unassigned = [], newMerchants = [];
  const validRows = [];
  const newLabels = new Map();
  for (const src of merchants) {
    const label = (src.partnerName || '').trim();
    if (!label || label === '-') { unassigned.push(src.name); continue; }
    const key = label.toLowerCase();
    if (!resolveLabel(index, label) && !newLabels.has(key)) newLabels.set(key, label);
    validRows.push({ src, label });
  }

  for (const label of newLabels.values()) {
    // In-memory only — never written. A roster label with no merchant-view row is a brand
    // operating in the field that your merchant list does not carry. It is not paid (brands
    // absent from the merchant list are not paid — user, 2026-08-07) and it is not added to
    // your table (a run does not edit the merchant list — user, 2026-09-03). Giving it a stub
    // here keeps its orders matched, so its revenue is reported by brand under `skipped`
    // instead of scattering across `unmatched` as unrecognised store names.
    contracts.push({ contractId: ulid(), merchantName: label, partnerId: null,
      units: {}, notes: '', rule: null, aggregationMode: 'per_store',
      noPayout: true, currency: DEFAULT_CURRENCY });
    newMerchants.push(label);
  }
  index = indexContractsByName(contracts);

  // Resolve every roster row first, writing nothing: this loop is pure bookkeeping, so it
  // costs no round trips. Only rows that actually differ from the registry are written, in
  // batches, afterwards. It used to be one PutItem per roster row (~4,000 of them) — at 256MB
  // that took 25-30s and, from 2026-07-27, blew the 30s Lambda timeout on every attempt. A
  // roster is near-identical month to month, so in the steady state this now writes ~nothing.
  const roster = [];
  const seen = {};
  const toWrite = [];
  for (const { src, label } of validRows) {
    const contract = resolveLabel(index, label);
    // Should be unreachable — every label was either already resolvable or added to
    // newLabels and stubbed above, so `index` (rebuilt just before this loop) should resolve
    // it. Guard anyway: a throw here would 500 the whole run instead of costing one row.
    if (!contract) { unassigned.push(src.name); continue; }
    const nameLower = (src.name || '').toLowerCase().trim();
    const ex = merchantByName[nameLower];
    const merchantId = ex?.merchantId || ulid();
    const row = { merchantId, createdAt: ex?.createdAt, name: src.name,
      contractId: contract.contractId, partnerId: ex?.partnerId ?? null,
      machineModel: src.model || null, externalId: src.externalId || ex?.externalId || null, notes: ex?.notes || '' };
    // Still computed, because the run needs the resolved row in memory — simply never written.
    if (merchantRowChanged(ex, row)) toWrite.push(row);
    roster.push({ merchantId, name: src.name, nameLower, contractId: contract.contractId,
      model: src.model || null, externalId: row.externalId });
    seen[contract.contractId] = contract;
  }

  // Machine counts the roster DIFFERS from what each contract stores. Reported so step 2 can
  // say so, and deliberately NOT written — see the note at the top of this function. To apply
  // them, run infra/refresh-units-from-roster.mjs.
  const changedUnits = unitsChanged(Object.values(seen), rosterUnitCounts(roster));

  const merchantsNeedingTerms = Object.values(seen)
    .filter(contractNeedsTerms)
    .map(c => ({ contractId: c.contractId, name: c.merchantName }));

  // Built here because this is where the full contract list is already loaded.
  return { roster, merchantsNeedingTerms, unassigned, newMerchants,
           unitsDiffer: changedUnits.map(c => ({ contractId: c.contractId, merchantName: c.merchantName, units: c.units, installedUnits: c.installedUnits })),
           aliasIndex: indexOrderAliases(contracts) };
}

export function groupOrders(orders, merchantMap) {
  const groups = {};
  const unmatchedSet = new Set();
  let unmatchedOrderCount = 0;
  let unmatchedRevenue = 0;
  for (const { merchantName, netAmount } of orders) {
    const key = (merchantName || '').toLowerCase().trim();
    const merchant = merchantMap[key];
    if (!merchant) {
      unmatchedSet.add(merchantName);
      unmatchedOrderCount++;
      unmatchedRevenue += Number(netAmount) || 0;
      continue;
    }
    if (!groups[merchant.partnerId]) groups[merchant.partnerId] = [];
    const g = groups[merchant.partnerId];
    const existing = g.find(m => m.merchantId === merchant.merchantId);
    if (existing) { existing.rentals++; existing.revenue += netAmount; }
    else g.push({ merchantId: merchant.merchantId, merchantName: merchant.name, model: merchant.machineModel || 'S8', rentals: 1, revenue: netAmount });
  }
  return { groups, unmatched: [...unmatchedSet], unmatchedOrderCount, unmatchedRevenue };
}

// POST /bulk-runs/prepare — apply the uploaded merchant list, return rule-readiness for the wizard.
export async function prepareBulkRunRoute(event) {
  const body = JSON.parse(event.body || '{}');
  // A run no longer asks for the merchant list (2026-09-29): it is uploaded on the Upload page
  // and STORED. The request may still carry one — an open tab on the old wizard, the CLI — and
  // that still wins, so nothing that worked before stops working.
  let merchants = Array.isArray(body.merchants) ? body.merchants : [];
  let rosterSource = merchants.length ? 'uploaded' : null;
  if (!merchants.length) {
    const stored = await dbModule.getRosterRows();
    merchants = (stored && stored.merchants) || [];
    rosterSource = 'stored';
  }
  if (!merchants.length) return resp(400, { error: 'no_merchants' });
  // Step 2 has no orders yet, so nothing is recovered here — the wizard reports the roster it
  // will use, and the recovery happens when the orders arrive.
  const { roster, merchantsNeedingTerms, unassigned, newMerchants, unitsDiffer } = await applyMerchantRoster(merchants);
  const merchantBrandCount = new Set(roster.map(r => r.contractId)).size;
  // The wizard says where the roster came from and when it was last refreshed, so "this run used
  // a three-week-old merchant list" is visible rather than assumed.
  const rosterMeta = rosterSource === 'stored' ? await dbModule.getRosterMeta() : null;
  return resp(200, { rosterCount: roster.length, merchantBrandCount, newMerchants, unassigned,
                     merchantsNeedingTerms, unitsDiffer, rosterSource, rosterMeta });
}

// Why a contract is or is not paid, as a pure decision — so the ordering of these rules is
// testable without DynamoDB. Returns { pay: true } or { pay: false, warning?: string }.
// Order matters and is load-bearing: missing contract -> warn; noPayout -> skip silently
// (it is a deliberate, known state, not an error); a rule that pays nothing -> skip with a
// warning; an invalid aggregationMode -> skip with a warning (evaluateRun would otherwise
// silently fall back to the lower-paying 'whole' branch — see 7-Eleven); otherwise pay.
// `sampleMerchantName` is optional — a roster row's own name, passed by the caller when
// `contract` is null so the missing-contract warning names a brand instead of a bare ULID.
export function payoutDecision(contract, contractId, sampleMerchantName) {
  if (!contract) {
    const label = sampleMerchantName ? `"${sampleMerchantName}" (${contractId})` : contractId;
    return { pay: false, warning: `Merchant ${label} not found, skipped` };
  }
  // Archived means the contract has ended, so there is nothing to pay. It stays in the name
  // index on purpose, so a roster label still resolves to it rather than minting a duplicate
  // stub — its stores keep matching orders and that revenue lands in `skipped`, where it can
  // still be reconciled. Unlike `noPayout` this warns: a roster that still lists an archived
  // merchant means machines are live and earning under a contract you ended.
  if (contract.archived) {
    return { pay: false, warning: `"${contract.merchantName}" is archived (contract ended), skipped — its machines are still in the roster` };
  }
  if (contract.noPayout) return { pay: false };
  if (!ruleHasValue(contract.rule)) return { pay: false, warning: `"${contract.merchantName}" has no terms that pay, skipped` };
  if (contract.aggregationMode !== 'whole' && contract.aggregationMode !== 'per_store') {
    return { pay: false, warning: `"${contract.merchantName}" has no valid aggregation mode (${contract.aggregationMode ?? 'unset'}), skipped — set it in the Merchant view` };
  }
  return { pay: true };
}

// The whole calculation, independent of HTTP. Split out of createBulkRunRoute (2026-08-24) so
// a run can also be recomputed from its stored inputs by infra/rerun-bulk-run.mjs — without a
// browser token and without re-uploading anything. The route below is now a thin wrapper, so
// there is exactly one implementation of what a run means.

// ── A RUN NEVER READS A REVIEW STATE (2026-10-02) ─────────────────────────────────────────────
// "RUN SHARE AND APPROVED STATUS ARE NOT RELATED." · "For registry: yes, always approved merchant
// with deployed machine binding. For run share: ALWAYS READ ONLY ORDER LIST FOR THE RENTAL
// MERCHANT COLUMN, and you do mapping with the brands to apply the rule."
//
// The two halves of the file were doing two jobs at once. `merchants` is the APPROVED half, and
// using it as the run's roster made approval a payment gate: a Disapproved branch with a live
// machine earned, failed to match any row, and its revenue landed in `unmatched` — six 7-Eleven
// branches are in exactly that state on the 1 Oct file, worth 1,100 THB a month in per-store
// guarantee alone.
//
// So the run's merchant set is assembled from what EXISTS, never from what is approved:
//   • every row of the stored roster, unchanged — the Approved half, still the bulk of it
//   • every merchant with a machine DEPLOYED against it, whatever its review state
//   • every merchant the period's orders name, if the file can say which brand it belongs to
// and the brand mapping reads BOTH halves of the file, because `excluded` is the only place a
// non-Approved merchant's `Merchant label` is recorded. That mapping is the whole job: a name in
// the order report becomes a brand, and the brand's rule is what pays.
//
// WHAT THIS DELIBERATELY DOES NOT DO: take the order list as the ONLY input. Measured on the
// August run through the engine, that pays 71,700 THB less — 7-Eleven 59,950 and LAWSON 10,500 —
// because 352 stations held a machine all month and took no rental. The user's own rule is older
// and still stands: "even with no revenue, if there's any fixed fee, we still have to pay,
// including electricity." A machine that exists earns its fee; the orders decide the revenue.
//
// A ROSTER ROW IS A STATION (§1h), so a merchant added here contributes ONE row per machine
// MODEL present, never one per cabinet — the machine file counts cabinets, and counting those
// would pay a 4-cabinet station four placements while the Approved half beside it gets one.
//
// Verified payout-identical on both stored runs (July and August): 0 brands move.
export function expandRunRoster({ merchants = [], excluded = [], machines = [], orders = [] }) {
  const key = s => String(s || '').trim().toLowerCase();

  // name -> Merchant label, from BOTH halves. The Approved half wins where they disagree.
  const brandOf = new Map(), modelOf = new Map();
  for (const m of merchants || []) {
    const k = key(m.name);
    if (!k) continue;
    if (m.partnerName) brandOf.set(k, String(m.partnerName).trim());
    if (m.model) modelOf.set(k, m.model);
  }
  for (const e of excluded || []) {
    const k = key(e.name);
    if (k && !brandOf.has(k) && e.label) brandOf.set(k, String(e.label).trim());
  }

  const out = new Map();
  for (const m of merchants || []) { const k = key(m.name); if (k) out.set(k, m); }
  const addedByMachine = [], addedByOrder = [];

  const add = (k, display, brand, model, externalId, into, extra) => {
    const row = { name: display, nameLower: k, partnerName: brand, model: model || null,
                  externalId: externalId || null };
    out.set(k, row);
    into.push({ name: display, brand, ...extra });
    return row;
  };

  // Machines deployed against a merchant the Approved half does not carry.
  for (const mc of machines || []) {
    const k = key(mc.store);
    if (!k || out.has(k)) continue;
    if (!(Number(mc.deployed) > 0)) continue;          // bound but not deployed pays for nothing
    const brand = brandOf.get(k);
    if (!brand) continue;                               // no label anywhere: nothing to apply
    const models = Object.entries(mc.counts || {}).filter(([, n]) => Number(n) > 0).map(([m]) => m);
    const list = models.length ? models : [modelOf.get(k) || null];
    list.forEach((model, i) => {
      // One row per model. The key has to stay unique or the second model overwrites the first.
      const rk = i === 0 ? k : `${k}#${String(model).toLowerCase()}`;
      const row = { name: mc.store, nameLower: k, partnerName: brand, model,
                    externalId: mc.businessId || null };
      out.set(rk, row);
      if (i === 0) addedByMachine.push({ name: mc.store, brand, model, deployed: Number(mc.deployed) || 0 });
    });
  }

  // Merchants the period's orders name that nothing above placed. Their machine is gone from
  // today's file but it was there in the period — which is what the revenue proves.
  const seen = new Set();
  for (const o of orders || []) {
    const k = key(o.merchantName);
    if (!k || out.has(k) || seen.has(k)) continue;
    seen.add(k);
    const brand = brandOf.get(k);
    if (!brand) continue;                               // stays unmatched, and is reported as such
    add(k, String(o.merchantName).trim(), brand,
        modelOf.get(k) || null, null, addedByOrder, {});
  }

  return { roster: [...out.values()], addedByMachine, addedByOrder };
}

export async function computeBulkRun({ runId, orders = [], merchants = [], machines = [], excluded = [], periodStart, periodEnd, persist = true }) {
  // Who is in this run — assembled from what exists, never from a review state. See above.
  const expanded = expandRunRoster({ merchants, excluded, machines, orders });
  // Re-apply roster (idempotent) so the registry is current and we have resolved ids.
  const { roster, unassigned, aliasIndex } = await applyMerchantRoster(expanded.roster, { persist });
  const machineModelsList = await listMachineModels();
  const allowedModels = new Set(machineModelsList.map(m => m.code));

  // `machines` is the optional Machine List upload; without it pass 2 simply does not run.
  const machineIndex = machines.length ? indexMachines(machines) : null;
  const { groups, unmatched, unmatchedOrderCount, unmatchedRevenue, unmatchedDetail: rawUnmatched,
          matchedByMachine, matchedByAlias } =
    buildRosterRows(roster, orders, machineIndex, aliasIndex);
  const unmatchedDetail = annotateUnmatched(rawUnmatched, excluded);
  const notApproved = unmatchedDetail.filter((u) => u.reviewState);

  const results = [];
  const skipped = [];
  const ruleSnapshots = {};
  const warnings = [];

  // Pre-fetch every contract in parallel (bounded) instead of one await per group.
  const contractIds = Object.keys(groups);
  const fetched = await mapPool(contractIds, 25, id => getContract(id));
  const contractById = {};
  contractIds.forEach((id, i) => { contractById[id] = fetched[i]; });

  for (const [contractId, merchantRows] of Object.entries(groups)) {
    const contract = contractById[contractId];
    const decision = payoutDecision(contract, contractId, merchantRows[0]?.merchantName);
    if (!decision.pay) {
      if (decision.warning) warnings.push(decision.warning);
      // The stores are still in the roster and their orders still matched into these rows
      // (buildRosterRows doesn't know about payoutDecision) — so the revenue is real and
      // must be accounted for somewhere, or it vanishes from every total on the page while
      // still counting inside orderCount. Record it here instead of dropping it.
      skipped.push({
        contractId,
        merchantName: contract?.merchantName ?? merchantRows[0]?.merchantName ?? null,
        reason: decision.warning ?? 'not paid (marked no revenue share)',
        merchantCount: merchantRows.length,
        rentals: merchantRows.reduce((s, m) => s + m.rentals, 0),
        revenue: merchantRows.reduce((s, m) => s + m.revenue, 0),
      });
      continue;
    }

    const engineRows = merchantRows.map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
    let result;
    try {
      result = evaluateRun({ rule: contract.rule, rows: engineRows, aggregationMode: contract.aggregationMode, allowedModels });
    } catch (e) {
      // Same accounting problem as the payoutDecision skip above: the stores and their
      // matched revenue are still real, so they go into `skipped` too rather than vanishing.
      warnings.push(`"${contract.merchantName}" calculation error: ${e.message}`);
      skipped.push({
        contractId,
        merchantName: contract.merchantName,
        reason: `calculation error: ${e.message}`,
        merchantCount: merchantRows.length,
        rentals: merchantRows.reduce((s, m) => s + m.rentals, 0),
        revenue: merchantRows.reduce((s, m) => s + m.revenue, 0),
      });
      continue;
    }

    ruleSnapshots[contractId] = contract.rule;
    results.push({
      contractId,
      merchantName: contract.merchantName,
      currency: contract.currency,
      merchantCount: merchantRows.length,
      rentals: merchantRows.reduce((s, m) => s + m.rentals, 0),
      revenue: merchantRows.reduce((s, m) => s + m.revenue, 0),
      payout: result.totalPayout,
      merchants: merchantRows,
      engineResult: result
    });
  }

  const totalPayout = results.reduce((s, r) => s + r.payout, 0);
  const skippedRevenue = skipped.reduce((s, r) => s + r.revenue, 0);
  // Every order either matched a roster row (whose group ends up in `results` or `skipped`)
  // or didn't (`unmatched`) — so paid + skipped + unmatched must equal this by construction.
  // Stored so the frontend can show the reconciliation explicitly instead of asserting it.
  const totalOrderRevenue = orders.reduce((s, o) => s + (Number(o.netAmount) || 0), 0);
  runId = runId || ulid();
  const bulkRun = {
    runId, periodStart, periodEnd,
    uploadedAt: new Date().toISOString(),
    orderCount: orders.length,
    merchantCount: Object.values(groups).flat().length,
    // Two different questions: how many brands did the roster resolve (rosterBrandCount),
    // and how many actually got paid (paidBrandCount). Keeping only one number under the old
    // `merchantBrandCount` name made a real drop (e.g. 199 loaded -> 134 paid) look like the
    // same count reported twice, rather than 65 brands being skipped.
    paidBrandCount: results.length,
    rosterBrandCount: new Set(roster.map(r => r.contractId)).size,
    rosterCount: roster.length,
    unassignedCount: unassigned.length,
    unmatchedCount: unmatched.length,
    unmatchedOrderCount,
    unmatchedRevenue,
    // Per-name orders/revenue, so an unmatched store can be sized after the fact — the raw
    // orders do not survive the request.
    unmatchedDetail,
    // Of those, the ones the merchant list DOES know about but excluded for their review state.
    // Expected to be 0 or near it since 2026-10-02: a run no longer reads a review state, so a
    // held-back merchant with a machine is IN the run rather than stranded in unmatched. A name
    // that still lands here is one the file gives no `Merchant label` at all.
    notApprovedCount: notApproved.length,
    notApprovedRevenue: notApproved.reduce((a2, u) => a2 + (Number(u.revenue) || 0), 0),
    // Merchants the Approved half of the file does not carry but which are in this run anyway:
    // a machine is deployed against them, or the period's orders name them. Named, not counted —
    // the whole point is being able to see which merchant is being paid on what basis.
    addedByMachine: expanded.addedByMachine,
    addedByOrder: expanded.addedByOrder,
    // Stores whose order-report name no longer matches their merchant-list name, recovered by
    // machine number. Shown on the run so the underlying rename gets fixed at source.
    matchedByMachine,
    // Stores paid because someone assigned their order-report name to a merchant from a run's
    // unmatched list. Each one added a store row to that merchant.
    matchedByAlias,
    machineCount: machineIndex ? Object.keys(machineIndex).length : 0,
    skippedCount: skipped.length,
    skippedRevenue,
    totalOrderRevenue,
    totalPayout,
    results,
    skipped,
    unmatched,
    unassigned,
    warnings,
    ruleSnapshots,
    archived: false, archivedAt: null, archivedBy: null,
  };

  return bulkRun;
}

export async function createBulkRunRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { orders = [], periodStart, periodEnd } = body;
  let { merchants = [], machines = [], excluded = [] } = body;
  if (!periodStart || !periodEnd) return resp(400, { error: 'missing_fields', required: ['periodStart','periodEnd'] });

  // Same fallback as prepare. The roster the run computes against is STORED at upload time and
  // read here — as parsed rows, so `flat_per_machine` and per-machine MG keep counting stations
  // exactly as they always have (§1h: BTS is 36 stations, not 103 cabinets).
  let rosterSource = merchants.length ? 'uploaded' : 'stored';
  if (!merchants.length) {
    const stored = await dbModule.getRosterRows();
    if (stored) {
      merchants = stored.merchants || [];
      if (!machines.length) machines = stored.machines || [];
      if (!excluded.length) excluded = stored.excluded || [];
    }
  }
  if (!merchants.length) return resp(400, { error: 'no_merchants' });

  // A merchant the file has dropped since the period still earned in it (C5).
  const { merchants: withDeparted, recovered } = await recoverDepartedMerchants(merchants, orders);

  const bulkRun = await computeBulkRun({ orders, merchants: withDeparted, machines, excluded,
                                         periodStart, periodEnd });
  bulkRun.rosterSource = rosterSource;
  // Named on the run, so a figure that came from an older file is explained rather than assumed.
  bulkRun.recoveredFromArchive = recovered.map(m => ({ name: m.name, brand: m.partnerName,
                                                       from: m.fromArchivedFile }));
  // Store the inputs alongside the run so it can be recomputed later without a re-upload.
  await putBulkRun(bulkRun, { merchants, orders, machines, excluded, periodStart, periodEnd });
  return resp(201, bulkRun);
}

export async function listBulkRunsRoute() {
  return resp(200, await listBulkRuns());
}

export async function getBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  const run = await getBulkRun(id);
  if (!run) return resp(404, { error: 'not_found' });
  return resp(200, run);
}

export async function archiveBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  const run = await getBulkRun(id);
  if (!run) return resp(404, { error: 'not_found' });
  run.archived = true; run.archivedAt = new Date().toISOString(); run.archivedBy = event.auth?.email || null;
  await putBulkRun(run);
  return resp(200, { ok: true, archived: true });
}

export async function unarchiveBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  const run = await getBulkRun(id);
  if (!run) return resp(404, { error: 'not_found' });
  run.archived = false; run.archivedAt = null; run.archivedBy = null;
  await putBulkRun(run);
  return resp(200, { ok: true, archived: false });
}

export async function deleteBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  if (!id) return resp(400, { error: 'missing_runId' });
  const run = await getBulkRun(id);
  // The message reaches the user verbatim, so it uses the word the screen uses: Lock, not
  // Archive (2026-10-02). The stored field and the route names are unchanged.
  if (run && run.archived) return resp(409, { error: 'archived',
    message: 'This month is locked. An admin must unlock it before it can be deleted.' });
  await deleteBulkRun(id);
  return resp(200, { ok: true });
}

function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

// GET /bulk-runs/:id/inputs — the roster, orders and machine list a run was computed from.
//
// The run payload holds only aggregates, so the per-merchant download cannot show order-level
// detail without this. Kept as a separate object (and a separate request) because it is several
// MB: the run-detail page must never pay for it just to draw a table.
// GZIPPED, because a month of orders outgrew API Gateway's 10 MB RESPONSE limit (2026-09-30).
// September's stored inputs are 10.4 MB: the request 413'd, `runOrderIndex` swallowed it in a
// bare catch, and every statement for that run went out summary-only — with a message blaming
// the run's age. This is §1p's wall in the other direction; orders are dense repetitive JSON, so
// the same trick buys the same ~10x.
//
// `application/gzip` + base64 is what API Gateway needs to pass bytes through. The limit applies
// to the ENCODED response, so base64's 4/3 inflation is accounted for by the compression itself.
// A run's stored order rows, IN PAGES.
//
// Two separate faults lived here, and the second hid the first for a month.
//
// 1. THE SIGNATURE. `routeBulkRun` (index.mjs) calls every bulk-run handler as `fn(event)`. This
//    one declared its parameter as `runId`, so it received the event object, asked DynamoDB for
//    `BULKRUN#[object Object]`, got nothing, and returned 409 `no_stored_inputs`. The client reads
//    that as "this run is too old to have kept its orders" and every statement said so — about
//    runs made that morning. Broken since the download was written (2026-09-01, ca74a1c); it has
//    never returned a single order.
// 2. THE SIZE. September's inputs are 10.40 MB — orders alone are 9.92 MB of it — against API
//    Gateway's hard 10 MB response ceiling. So even once (1) was fixed it could not have shipped
//    whole. A gzip+base64 body was tried first and is gone: `isBase64Encoded` is only honoured
//    when the response content-type is in the API's `binaryMediaTypes`, and NEITHER REGION HAS
//    ONE CONFIGURED, so it arrived as text the browser could not inflate.
//
// Pages of plain JSON instead — the same transport every working route in this app already uses,
// with no ceiling to grow back into. 5,000 orders is 1.9 MB; September is 6 requests.
//
// Returns ORDERS ONLY. That is all the statement download reads, and the roster on the side would
// add 0.48 MB to every page for nothing.
const ORDER_PAGE = 5000;
const ORDER_PAGE_MAX = 10000;

export async function getBulkRunInputsRoute(event) {
  const runId = event?.pathParameters?.runId;
  if (!runId) return resp(400, { error: 'missing_run' });

  const inputs = await getBulkRunInputs(runId);
  if (!inputs) {
    return resp(409, { error: 'no_stored_inputs',
      message: 'This run predates stored inputs (2026-08-24), so its orders were not kept.' });
  }

  return resp(200, pageOrders(inputs.orders, event.queryStringParameters));
}

// Pure, so the paging can actually be executed by a test rather than grepped for.
// `total` on every page is what lets the client tell "that is all of them" from "the connection
// stopped early" — without it a truncated read is an incomplete statement that looks finished.
export function pageOrders(orders, query) {
  const all = Array.isArray(orders) ? orders : [];
  const q = query || {};
  const offset = Math.min(all.length, Math.max(0, Math.trunc(Number(q.offset) || 0)));
  const limit = Math.min(ORDER_PAGE_MAX, Math.max(1, Math.trunc(Number(q.limit) || ORDER_PAGE)));
  return { total: all.length, offset, limit, orders: all.slice(offset, offset + limit) };
}

// POST /bulk-runs/:id/recompute — rebuild a run from its stored inputs and REPLACE it.
//
// Replacing rather than versioning is a deliberate user decision (2026-08-24): the point is to
// fix an unmatched merchant and see the run correct itself, not to accumulate near-identical
// runs. The frozen-snapshot rule (CLAUDE.md §5) is preserved where it matters — the result is
// still a self-consistent snapshot with its own ruleSnapshots, and an ARCHIVED run is refused
// (409), so locking a payout you have acted on is the one click that makes it immutable.

// ── A RECOMPUTE MUST NOT PAY LESS BECAUSE A DEVICE TYPE WAS DELETED (2026-10-02) ─────────────
// Recompute REPLACES a run (§1e, the user's explicit choice), and it reads TODAY's Device Types.
// Delete a type and every stored roster row carrying it becomes `unknown machine model: <code>`
// inside `evaluateRun` — which `payoutDecision` catches per brand and drops THE WHOLE BRAND into
// `skipped`. Not the row. The brand.
//
// Measured on the live July run, which carries `L40 x156` from before the 2026-08-27 LL40
// re-key: recomputing it today pays 143,869 against the 894,760 it is on record for. 7-Eleven,
// BTS and Siam Paragon all go to zero. One button, 750,891 THB, no warning — the run page would
// simply show a smaller number afterwards and the original would be gone.
//
// So the models are checked against Device Types BEFORE anything is computed or written, and the
// refusal names the code, how many rows carry it and which brands lose their payout. The fix is
// a person's: re-key the data (`infra/rekey-models.mjs`) or put the type back.
export function deadRosterModels(merchants, allowedModels) {
  const allowed = allowedModels instanceof Set ? allowedModels : new Set(allowedModels || []);
  const byModel = new Map();
  for (const m of merchants || []) {
    const model = String(m && m.model ? m.model : '').trim();
    if (!model || allowed.has(model)) continue;      // a blank model is a separate, older case
    if (!byModel.has(model)) byModel.set(model, { model, rows: 0, brands: new Set() });
    const e = byModel.get(model);
    e.rows++;
    const b = String((m && m.partnerName) || '').trim();
    if (b) e.brands.add(b);
  }
  return [...byModel.values()]
    .sort((a, b) => b.rows - a.rows)
    .map(e => ({ model: e.model, rows: e.rows, brands: [...e.brands].sort() }));
}

export async function recomputeBulkRunRoute(event) {
  // `routeBulkRun` in index.mjs calls every handler as `fn(event)`. This one declared `runId`, so
  // it received the whole event and looked up `BULKRUN#[object Object]` — a 404 for every run that
  // exists. Same defect as getBulkRunInputsRoute below, same commit, never noticed because the
  // only symptom was a plausible-looking error message.
  const runId = event?.pathParameters?.runId;
  if (!runId) return resp(400, { error: 'missing_run' });
  const old = await getBulkRun(runId);
  if (!old) return resp(404, { error: 'not_found' });
  if (old.archived) return resp(409, { error: 'archived',
    message: 'This month is locked, so its payouts are the record and cannot be recomputed. '
      + 'An admin must unlock it first.' });

  const inputs = await getBulkRunInputs(runId);
  if (!inputs) {
    return resp(409, { error: 'no_stored_inputs',
      message: 'This run predates stored inputs (2026-08-24), so it cannot be recomputed. Re-run it from the wizard.' });
  }

  // Checked before a single number is computed, and before anything is written or deleted.
  const dead = deadRosterModels(inputs.merchants, (await listMachineModels()).map(m => m.code));
  if (dead.length) {
    const affected = [...new Set(dead.flatMap(d => d.brands))];
    return resp(409, {
      error: 'retired_machine_model',
      models: dead,
      brandCount: affected.length,
      message: `This run's merchant list uses ${dead.map(d => `${d.model} (${d.rows} row(s))`).join(', ')}`
        + `, which ${dead.length === 1 ? 'is' : 'are'} no longer a machine type in Settings → Device types.`
        + ` Recomputing would pay ${affected.length} brand(s) nothing instead of what they are on`
        + ` record for. Re-key the data or restore the type first — the run has not been changed.`,
    });
  }

  const fresh = await computeBulkRun({
    merchants: inputs.merchants, orders: inputs.orders, machines: inputs.machines, excluded: inputs.excluded,
    periodStart: inputs.periodStart ?? old.periodStart, periodEnd: inputs.periodEnd ?? old.periodEnd,
  });
  fresh.recomputedFrom = runId;
  fresh.recomputedAt = new Date().toISOString();
  await putBulkRun(fresh, inputs);
  await deleteBulkRun(runId);
  return resp(200, fresh);
}
