import { listMerchants, listPartners, getPartner, putPartner, putMerchant, putBulkRun, listBulkRuns, getBulkRun, deleteBulkRun, listMachineModels, ulid } from '../db.mjs';
import { evaluateRun } from '../engine.mjs';

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
  const groups = {};                 // partnerId -> [ {merchantId, merchantName, model, rentals, revenue} ]
  const byName = {};                 // nameLower -> row (for overlay)
  for (const m of roster) {
    if (!m.partnerId) continue;      // unassigned (no Merchant label) — surfaced separately, not paid
    const row = { merchantId: m.merchantId, merchantName: m.name, model: m.model || 'S8', rentals: 0, revenue: 0 };
    (groups[m.partnerId] = groups[m.partnerId] || []).push(row);
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

// Apply an uploaded merchant roster: create missing partners (by Merchant label = partner
// name, empty rule), upsert each merchant (partner + machine model), report readiness.
export async function applyMerchantRoster(merchants) {
  const [partners, existingMerchants] = await Promise.all([listPartners(), listMerchants()]);
  const partnerByName = {};
  for (const p of partners) if (!p.archived) partnerByName[(p.name || '').toLowerCase().trim()] = p;
  const merchantByName = {};
  for (const m of existingMerchants) merchantByName[m.nameLower] = m;

  const unassigned = [], newPartners = [];

  // Pass 1 (in memory): split rows, and collect distinct partner labels that don't exist yet.
  const validRows = [];
  const newLabels = new Map();   // lowerLabel -> display label (deduped so each partner is created once)
  for (const src of merchants) {
    const label = (src.partnerName || '').trim();
    if (!label || label === '-') { unassigned.push(src.name); continue; }
    const key = label.toLowerCase();
    if (!partnerByName[key] && !newLabels.has(key)) newLabels.set(key, label);
    validRows.push({ src, key });
  }

  // Pass 2: create the missing partners (deduped → no double-create under concurrency).
  await mapPool([...newLabels.entries()], 20, async ([key, label]) => {
    const partner = await putPartner({ partnerId: ulid(), name: label, currency: 'THB', aggregationMode: 'per_store', rule: null, notes: '', archived: false, noPayout: false });
    partnerByName[key] = partner;
    newPartners.push(label);
  });

  // Pass 3: write every merchant concurrently — these are independent, so a bounded pool
  // turns ~1600 serial writes (which timed out) into a handful of parallel batches.
  const roster = [];
  const seenPartner = {};
  await mapPool(validRows, 25, async ({ src, key }) => {
    const partner = partnerByName[key];
    const ex = merchantByName[(src.name || '').toLowerCase().trim()];
    const merchantId = ex?.merchantId || ulid();
    const saved = await putMerchant({ merchantId, createdAt: ex?.createdAt, name: src.name, partnerId: partner.partnerId, machineModel: src.model || null, externalId: src.externalId || ex?.externalId || null, notes: ex?.notes || '' });
    roster.push({ merchantId, name: src.name, nameLower: saved.nameLower, partnerId: partner.partnerId, model: src.model || null });
    seenPartner[partner.partnerId] = partner;
  });

  const partnersNeedingRules = Object.values(seenPartner)
    .filter(p => !p.noPayout && (!p.rule || !p.rule.type))
    .map(p => ({ partnerId: p.partnerId, name: p.name }));

  return { roster, partnersNeedingRules, unassigned, newPartners };
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
  const { roster, partnersNeedingRules, unassigned, newPartners } = await applyMerchantRoster(merchants);
  const partnerCount = new Set(roster.map(r => r.partnerId)).size;
  return resp(200, { rosterCount: roster.length, partnerCount, newPartners, unassigned, partnersNeedingRules });
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

  // Pre-fetch every partner in parallel (bounded) instead of one await per group.
  const partnerIds = Object.keys(groups);
  const fetched = await mapPool(partnerIds, 25, id => getPartner(id));
  const partnerById = {};
  partnerIds.forEach((id, i) => { partnerById[id] = fetched[i]; });

  for (const [partnerId, merchantRows] of Object.entries(groups)) {
    const partner = partnerById[partnerId];
    if (!partner) { warnings.push(`Partner ${partnerId} not found, skipped`); continue; }
    if (partner.noPayout) continue;
    if (!partner.rule || !partner.rule.type) { warnings.push(`Partner "${partner.name}" has no rule, skipped`); continue; }

    const engineRows = merchantRows.map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
    let result;
    try {
      result = evaluateRun({ rule: partner.rule, rows: engineRows, aggregationMode: partner.aggregationMode, allowedModels });
    } catch (e) {
      warnings.push(`Partner "${partner.name}" calculation error: ${e.message}`);
      continue;
    }

    ruleSnapshots[partnerId] = partner.rule;
    results.push({
      partnerId,
      partnerName: partner.name,
      currency: partner.currency,
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
    partnerCount: results.length,
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
