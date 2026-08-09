import { listMerchants, putMerchant, putBulkRun, listBulkRuns, getBulkRun, deleteBulkRun, listMachineModels, ulid, listContracts, getContract, putContract } from '../db.mjs';
import * as dbModule from '../db.mjs';
import { evaluateRun } from '../engine.mjs';
import { ruleHasValue, contractNeedsTerms, indexContractsByName, resolveLabel } from '../payout.mjs';

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

// Roster-authoritative grouping: one row per roster machine (0/0), orders overlaid by
// merchant name; orders with no roster merchant are unmatched (not paid).
export function buildRosterRows(roster, orders) {
  const groups = {};                 // contractId -> [ {merchantId, merchantName, model, rentals, revenue} ]
  const byName = {};                 // nameLower -> row (for order overlay)
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
  }
  const unmatchedSet = new Set();
  let unmatchedOrderCount = 0, unmatchedRevenue = 0;
  for (const { merchantName, netAmount } of orders) {
    const row = byName[(merchantName || '').toLowerCase().trim()];
    if (!row) { unmatchedSet.add(merchantName); unmatchedOrderCount++; unmatchedRevenue += Number(netAmount) || 0; continue; }
    row.rentals++; row.revenue += Number(netAmount) || 0;
  }
  return { groups, unmatched: [...unmatchedSet], unmatchedOrderCount, unmatchedRevenue };
}

// A roster row's `Merchant label` is the brand. Resolve it to a Merchant-view row; create
// one if the brand is new, so a roster upload still onboards merchants. Labels that match
// nothing are impossible here (we create them) — the unmatched case is the reverse: a
// store-registry row whose brand has no contract, handled in buildRosterRows.
export async function applyMerchantRoster(merchants) {
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
    const created = await putContract({ contractId: ulid(), merchantName: label, partnerId: null,
      units: {}, notes: '', rule: null, aggregationMode: 'per_store',
      // A roster label with no merchant-view row is a brand operating in the field that the
      // merchant sheet does not list. Record it so it is visible, but flagged not-paid: the
      // user decided (2026-08-07) that brands absent from the sheet are not paid. Flip the
      // flag in the Merchant view to start paying one.
      noPayout: true, currency: DEFAULT_CURRENCY });
    contracts.push(created);
    newMerchants.push(label);
  });
  index = indexContractsByName(contracts);

  const roster = [];
  const seen = {};
  await mapPool(validRows, 25, async ({ src, label }) => {
    const contract = resolveLabel(index, label);
    // Should be unreachable — every label was either already resolvable or added to
    // newLabels and stubbed above, so `index` (rebuilt just before this loop) should resolve
    // it. Guard anyway: a throw here would 500 the whole run instead of costing one row.
    if (!contract) { unassigned.push(src.name); return; }
    const ex = merchantByName[(src.name || '').toLowerCase().trim()];
    const merchantId = ex?.merchantId || ulid();
    const saved = await putMerchant({ merchantId, createdAt: ex?.createdAt, name: src.name,
      contractId: contract.contractId, partnerId: ex?.partnerId ?? null,
      machineModel: src.model || null, externalId: src.externalId || ex?.externalId || null, notes: ex?.notes || '' });
    roster.push({ merchantId, name: src.name, nameLower: saved.nameLower, contractId: contract.contractId, model: src.model || null });
    seen[contract.contractId] = contract;
  });

  const merchantsNeedingTerms = Object.values(seen)
    .filter(contractNeedsTerms)
    .map(c => ({ contractId: c.contractId, name: c.merchantName }));

  return { roster, merchantsNeedingTerms, unassigned, newMerchants };
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
  const { roster, merchantsNeedingTerms, unassigned, newMerchants } = await applyMerchantRoster(merchants);
  const merchantBrandCount = new Set(roster.map(r => r.contractId)).size;
  return resp(200, { rosterCount: roster.length, merchantBrandCount, newMerchants, unassigned, merchantsNeedingTerms });
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

export async function createBulkRunRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { orders = [], merchants = [], periodStart, periodEnd } = body;
  if (!periodStart || !periodEnd) return resp(400, { error: 'missing_fields', required: ['periodStart','periodEnd'] });
  if (!merchants.length) return resp(400, { error: 'no_merchants' });

  // Re-apply roster (idempotent) so the registry is current and we have resolved ids.
  const { roster, unassigned } = await applyMerchantRoster(merchants);
  const machineModelsList = await listMachineModels();
  const allowedModels = new Set(machineModelsList.map(m => m.code));

  const { groups, unmatched, unmatchedOrderCount, unmatchedRevenue } = buildRosterRows(roster, orders);

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
  const runId = ulid();
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

  await putBulkRun(bulkRun);
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
