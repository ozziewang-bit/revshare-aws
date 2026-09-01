import { listMerchants, putMerchantsBatch, putBulkRun, listBulkRuns, getBulkRun, getBulkRunInputs, deleteBulkRun, listMachineModels, ulid, listContracts, getContract, putContract } from '../db.mjs';
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

// A roster row's `Merchant label` is the brand. Resolve it to a Merchant-view row; create
// one if the brand is new, so a roster upload still onboards merchants. Labels that match
// nothing are impossible here (we create them) — the unmatched case is the reverse: a
// store-registry row whose brand has no contract, handled in buildRosterRows.
// `persist: false` resolves the roster exactly as normal but writes NOTHING — no contract
// stubs, no store rows. That is what makes infra/rerun-bulk-run.mjs's dry run honest: without
// it, merely previewing a re-run would mutate the registry. New labels still get an in-memory
// stub so resolution (and therefore the computed run) is identical either way.
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

  await mapPool([...newLabels.values()], 20, async label => {
    const stub = { contractId: ulid(), merchantName: label, partnerId: null,
      units: {}, notes: '', rule: null, aggregationMode: 'per_store',
      // A roster label with no merchant-view row is a brand operating in the field that the
      // merchant sheet does not list. Record it so it is visible, but flagged not-paid: the
      // user decided (2026-08-07) that brands absent from the sheet are not paid. Flip the
      // flag in the Merchant view to start paying one.
      noPayout: true, currency: DEFAULT_CURRENCY };
    contracts.push(persist ? await putContract(stub) : stub);
    newMerchants.push(label);
  });
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
    if (merchantRowChanged(ex, row)) toWrite.push(row);
    roster.push({ merchantId, name: src.name, nameLower, contractId: contract.contractId,
      model: src.model || null, externalId: row.externalId });
    seen[contract.contractId] = contract;
  }
  if (toWrite.length && persist) await putMerchantsBatch(toWrite);

  // Refresh the Merchant view's machine counts from what the roster actually contains. Only
  // contracts whose counts really changed are written, so a re-run writes nothing.
  const changedUnits = unitsChanged(Object.values(seen), rosterUnitCounts(roster));
  if (changedUnits.length && persist) await mapPool(changedUnits, 20, c => putContract(c));

  const merchantsNeedingTerms = Object.values(seen)
    .filter(contractNeedsTerms)
    .map(c => ({ contractId: c.contractId, name: c.merchantName }));

  // Built here because this is where the full contract list is already loaded.
  return { roster, merchantsNeedingTerms, unassigned, newMerchants,
           unitsUpdated: changedUnits.map(c => ({ contractId: c.contractId, merchantName: c.merchantName, units: c.units, installedUnits: c.installedUnits })),
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
  const merchants = Array.isArray(body.merchants) ? body.merchants : [];
  if (!merchants.length) return resp(400, { error: 'no_merchants' });
  const { roster, merchantsNeedingTerms, unassigned, newMerchants, unitsUpdated } = await applyMerchantRoster(merchants);
  const merchantBrandCount = new Set(roster.map(r => r.contractId)).size;
  return resp(200, { rosterCount: roster.length, merchantBrandCount, newMerchants, unassigned, merchantsNeedingTerms, unitsUpdated });
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
export async function computeBulkRun({ runId, orders = [], merchants = [], machines = [], excluded = [], periodStart, periodEnd, persist = true }) {
  // Re-apply roster (idempotent) so the registry is current and we have resolved ids.
  const { roster, unassigned, aliasIndex } = await applyMerchantRoster(merchants, { persist });
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
    notApprovedCount: notApproved.length,
    notApprovedRevenue: notApproved.reduce((a2, u) => a2 + (Number(u.revenue) || 0), 0),
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
  const { orders = [], merchants = [], machines = [], excluded = [], periodStart, periodEnd } = body;
  if (!periodStart || !periodEnd) return resp(400, { error: 'missing_fields', required: ['periodStart','periodEnd'] });
  if (!merchants.length) return resp(400, { error: 'no_merchants' });

  const bulkRun = await computeBulkRun({ orders, merchants, machines, excluded, periodStart, periodEnd });
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
  if (run && run.archived) return resp(409, { error: 'archived', message: 'Unarchive before deleting.' });
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
export async function getBulkRunInputsRoute(runId) {
  const inputs = await getBulkRunInputs(runId);
  if (!inputs) {
    return resp(409, { error: 'no_stored_inputs',
      message: 'This run predates stored inputs (2026-08-24), so its orders were not kept.' });
  }
  return resp(200, inputs);
}

// POST /bulk-runs/:id/recompute — rebuild a run from its stored inputs and REPLACE it.
//
// Replacing rather than versioning is a deliberate user decision (2026-08-24): the point is to
// fix an unmatched merchant and see the run correct itself, not to accumulate near-identical
// runs. The frozen-snapshot rule (CLAUDE.md §5) is preserved where it matters — the result is
// still a self-consistent snapshot with its own ruleSnapshots, and an ARCHIVED run is refused
// (409), so locking a payout you have acted on is the one click that makes it immutable.
export async function recomputeBulkRunRoute(runId) {
  const old = await getBulkRun(runId);
  if (!old) return resp(404, { error: 'not_found' });
  if (old.archived) return resp(409, { error: 'archived', message: 'This run is locked. Unarchive it first.' });

  const inputs = await getBulkRunInputs(runId);
  if (!inputs) {
    return resp(409, { error: 'no_stored_inputs',
      message: 'This run predates stored inputs (2026-08-24), so it cannot be recomputed. Re-run it from the wizard.' });
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
