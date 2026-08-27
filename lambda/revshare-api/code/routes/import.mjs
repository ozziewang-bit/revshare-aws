import { listPartners, getPartner, putPartner, listMerchants, putMerchant, ulid } from '../db.mjs';

const VALID_MODELS = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);

export function parseDeviceType(deviceType) {
  if (!deviceType) return null;
  // Longest-first so S10-A wins over S10. LL20/LL40 are the platform's spelling of L20/L40 and
  // fold to them — Thailand's roster uses LL40 for the machines its contracts call L40.
  const m = String(deviceType).match(/-(S10-A|S5|S8|S10|T8|T10|T20|T35|LL?20|LL?40|M10)$/i);
  if (!m) return null;
  return m[1].toUpperCase().replace('LL', 'L');
}

// compileRule moved to ../rules.mjs (2026-08-27) so the pure contracts.mjs can build a rule
// from sheet columns without pulling this module's AWS imports in. Re-exported for callers.
export { compileRule } from '../rules.mjs';

export async function importRevShareRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { partners = [], merchants = [] } = body;

  const [existingPartners, existingMerchants] = await Promise.all([listPartners(), listMerchants()]);
  const partnerByName = Object.fromEntries(existingPartners.map(p => [p.name.toLowerCase().trim(), p]));
  const merchantByName = Object.fromEntries(existingMerchants.map(m => [m.nameLower, m]));

  const created = { partners: 0, merchants: 0 };
  const skipped = { partners: [] };
  const warnings = [];
  const partnerNameToId = {};

  for (const p of partners) {
    const key = (p.name || '').toLowerCase().trim();
    if (partnerByName[key]) {
      skipped.partners.push(p.name);
      partnerNameToId[key] = partnerByName[key].partnerId;
      continue;
    }
    const rule = compileRule({ gpPercent: p.gpPercent || 0, electricity: p.electricity || 0, placementRows: p.placementRows || [], mgRows: p.mgRows || [], others: p.others || 0 });
    const saved = await putPartner({ partnerId: ulid(), name: p.name, currency: p.currency || 'THB', aggregationMode: p.aggregationMode || 'whole', rule, notes: '', archived: false });
    partnerNameToId[key] = saved.partnerId;
    created.partners++;
  }

  for (const m of merchants) {
    const partnerKey = (m.partnerName || '').toLowerCase().trim();
    const partnerId = partnerNameToId[partnerKey] || partnerByName[partnerKey]?.partnerId;
    if (!partnerId) { warnings.push(`Merchant "${m.name}" skipped — partner "${m.partnerName}" not found`); continue; }
    const model = m.machineModel && VALID_MODELS.has(m.machineModel) ? m.machineModel : null;
    if (m.machineModel && !model) warnings.push(`Merchant "${m.name}": unrecognised model "${m.machineModel}", saved without model`);
    const nameKey = (m.name || '').toLowerCase().trim();
    const existing = merchantByName[nameKey];
    await putMerchant({ merchantId: existing?.merchantId || ulid(), createdAt: existing?.createdAt, name: m.name, partnerId, machineModel: model, externalId: m.externalId || null, notes: '' });
    if (!existing) created.merchants++;
  }

  return resp(200, { created, skipped, warnings });
}

// Run `fn` over `items` with bounded concurrency. Returns Promise.allSettled-style
// results (one entry per item, in order). Used so a single Lambda invocation can
// fan out many DynamoDB writes without firing thousands of separate HTTP requests.
async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
      catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}


function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
