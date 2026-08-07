import { listMerchants, putMerchant, putBulkRun, listBulkRuns, getBulkRun, deleteBulkRun, listMachineModels, ulid, listContracts, getContract, putContract } from '../db.mjs';
import { evaluateRun } from '../engine.mjs';
import { ruleHasValue, contractNeedsTerms, indexContractsByName, resolveLabel } from '../payout.mjs';

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
    // No contract means no merchant-view row for this brand: not paid, by decision, and
    // surfaced in the run's unmatched list rather than deleted.
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
      units: {}, notes: '', rule: null, aggregationMode: 'per_store', noPayout: false, currency: 'THB' });
    contracts.push(created);
    newMerchants.push(label);
  });
  index = indexContractsByName(contracts);

  const roster = [];
  const seen = {};
  await mapPool(validRows, 25, async ({ src, label }) => {
    const contract = resolveLabel(index, label);
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
  const ruleSnapshots = {};
  const warnings = [];

  // Pre-fetch every contract in parallel (bounded) instead of one await per group.
  const contractIds = Object.keys(groups);
  const fetched = await mapPool(contractIds, 25, id => getContract(id));
  const contractById = {};
  contractIds.forEach((id, i) => { contractById[id] = fetched[i]; });

  for (const [contractId, merchantRows] of Object.entries(groups)) {
    const contract = contractById[contractId];
    if (!contract) { warnings.push(`Merchant ${contractId} not found, skipped`); continue; }
    if (contract.noPayout) continue;
    if (!ruleHasValue(contract.rule)) { warnings.push(`"${contract.merchantName}" has no terms that pay, skipped`); continue; }

    const engineRows = merchantRows.map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
    let result;
    try {
      result = evaluateRun({ rule: contract.rule, rows: engineRows, aggregationMode: contract.aggregationMode, allowedModels });
    } catch (e) {
      warnings.push(`"${contract.merchantName}" calculation error: ${e.message}`);
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
  const runId = ulid();
  const bulkRun = {
    runId, periodStart, periodEnd,
    uploadedAt: new Date().toISOString(),
    orderCount: orders.length,
    merchantCount: Object.values(groups).flat().length,
    merchantBrandCount: results.length,
    rosterCount: roster.length,
    unassignedCount: unassigned.length,
    unmatchedCount: unmatched.length,
    unmatchedOrderCount,
    unmatchedRevenue,
    totalPayout,
    results,
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
