import { listMerchants, listPartners, getPartner, putBulkRun, listBulkRuns, getBulkRun, ulid } from '../db.mjs';
import { evaluateRun } from '../engine.mjs';

export function groupOrders(orders, merchantMap) {
  const groups = {};
  const unmatchedSet = new Set();
  for (const { merchantName, netAmount } of orders) {
    const key = (merchantName || '').toLowerCase().trim();
    const merchant = merchantMap[key];
    if (!merchant) { unmatchedSet.add(merchantName); continue; }
    if (!groups[merchant.partnerId]) groups[merchant.partnerId] = [];
    const g = groups[merchant.partnerId];
    const existing = g.find(m => m.merchantId === merchant.merchantId);
    if (existing) { existing.rentals++; existing.revenue += netAmount; }
    else g.push({ merchantId: merchant.merchantId, merchantName: merchant.name, model: merchant.machineModel || 'S8', rentals: 1, revenue: netAmount });
  }
  return { groups, unmatched: [...unmatchedSet] };
}

export async function createBulkRunRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { orders = [], periodStart, periodEnd } = body;
  if (!periodStart || !periodEnd) return resp(400, { error: 'missing_fields', required: ['periodStart','periodEnd'] });
  if (!orders.length) return resp(400, { error: 'no_orders' });

  const [allMerchants, allPartners] = await Promise.all([listMerchants(), listPartners()]);
  const merchantMap = Object.fromEntries(allMerchants.map(m => [m.nameLower, m]));
  const partnerMap = Object.fromEntries(allPartners.map(p => [p.partnerId, p]));

  const { groups, unmatched } = groupOrders(orders, merchantMap);

  const results = [];
  const ruleSnapshots = {};
  const warnings = [];

  for (const [partnerId, merchantRows] of Object.entries(groups)) {
    const partner = partnerMap[partnerId] || await getPartner(partnerId);
    if (!partner) { warnings.push(`Partner ${partnerId} not found, skipped`); continue; }
    if (!partner.rule || !partner.rule.type) { warnings.push(`Partner "${partner.name}" has no rule, skipped`); continue; }

    const engineRows = merchantRows.map(m => ({
      storeId: m.merchantId,
      machineSerial: m.merchantId,
      model: m.model,
      rentals: m.rentals,
      revenue: m.revenue
    }));

    let result;
    try {
      result = evaluateRun({ rule: partner.rule, rows: engineRows, aggregationMode: partner.aggregationMode });
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
    unmatchedCount: unmatched.length,
    totalPayout,
    results,
    unmatched,
    warnings,
    ruleSnapshots
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

function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
