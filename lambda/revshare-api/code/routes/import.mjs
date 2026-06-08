import { listPartners, getPartner, putPartner, listMerchants, putMerchant, ulid } from '../db.mjs';

const VALID_MODELS = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);

export function parseDeviceType(deviceType) {
  if (!deviceType) return null;
  const m = String(deviceType).match(/-(S5|S8|S10|T8|T10|T20|T35|LL?20|LL?40)$/i);
  if (!m) return null;
  return m[1].toUpperCase().replace('LL', 'L');
}

// New rule shape: terms (all 'add') + optional per-device-type MG floor.
// Payout = MG ? max( sum(terms), MG ) : sum(terms). Leaves tagged (_t/_m) to match the editor.
export function compileRule({ gpPercent, electricity, placementRows, mgRows, others }) {
  const adds = [];
  if (Number(gpPercent) > 0) adds.push({ type: 'percent', _t: 'gp', _m: 'add', rows: [{ model: 'ALL', percent: Number(gpPercent) }] });
  if (Number(electricity) > 0) adds.push({ type: 'flat_per_partner_total', _t: 'elec', _m: 'add', amount: Number(electricity) });
  const vp = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  if (vp.length) adds.push({ type: 'flat_per_machine', _t: 'placement', _m: 'add', rows: vp.map(r => ({ model: r.model, amount: Number(r.amount) })) });
  if (Number(others) > 0) adds.push({ type: 'flat_per_partner_total', _t: 'others', _m: 'add', amount: Number(others) });
  const vmg = (mgRows || []).filter(r => r.model && Number(r.amount) > 0);
  const mgLeaf = vmg.length ? { type: 'flat_per_machine', _t: 'mg', rows: vmg.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;

  // MG present → "hybrid-higher" (max of summed terms vs MG). Else sum.
  let rule;
  if (mgLeaf) {
    const s = adds.length === 0 ? { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }] }
      : (adds.length === 1 ? adds[0] : { type: 'sum', children: adds });
    rule = { type: 'max', children: [s, mgLeaf] };
    return { ...rule, _method: 'hybrid-higher' };
  }
  if (!adds.length) return { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }], _method: 'default' };
  if (adds.length === 1) return { ...adds[0], _method: 'default' };
  return { type: 'sum', children: adds, _method: 'hybrid' };
}

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

// POST /import/rule-batch — apply a whole rule-batch upload in ONE invocation.
// The browser sends pre-compiled rules + merchant lists; the server overwrites
// existing partners' rules (or creates new partners) and upserts every merchant
// by name. This replaces the old per-partner/per-merchant fan-out from the
// browser, which fired thousands of concurrent requests and got throttled by the
// account's Lambda concurrency limit. Merchants upsert by nameLower so re-uploads
// don't create duplicates.
export async function applyRuleBatchRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return resp(400, { error: 'no_updates' });

  const existingMerchants = await listMerchants();
  const merchantByName = {};
  for (const m of existingMerchants) if (!merchantByName[m.nameLower]) merchantByName[m.nameLower] = m;

  let updatedPartners = 0, newPartners = 0, failedPartners = 0;
  const warnings = [];
  const jobsByName = new Map(); // nameLower -> { name, model, partnerId } (last write wins, dedupes intra-batch)

  for (const u of updates) {
    try {
      let partnerId = u.partnerId || null;
      const existing = partnerId ? await getPartner(partnerId) : null;
      if (existing) {
        await putPartner({ ...existing, rule: u.rule, partnerId });
        updatedPartners++;
      } else {
        const saved = await putPartner({ partnerId: ulid(), name: u.partnerName, currency: 'THB', aggregationMode: 'whole', rule: u.rule, notes: '', archived: false });
        partnerId = saved.partnerId;
        newPartners++;
      }
      for (const m of (u.merchants || [])) {
        const nameKey = (m.name || '').toLowerCase().trim();
        if (!nameKey) continue;
        jobsByName.set(nameKey, { name: m.name, model: m.model, partnerId });
      }
    } catch (e) {
      failedPartners++;
      warnings.push(`Partner "${u.partnerName}" failed: ${e.message}`);
    }
  }

  const jobs = [...jobsByName.values()];
  const results = await mapPool(jobs, 40, (job) => {
    const nameKey = job.name.toLowerCase().trim();
    const model = job.model && VALID_MODELS.has(job.model) ? job.model : null;
    const ex = merchantByName[nameKey];
    return putMerchant({
      merchantId: ex?.merchantId || ulid(),
      createdAt: ex?.createdAt,
      name: job.name,
      partnerId: job.partnerId,
      machineModel: model,
      externalId: ex?.externalId || null,
      notes: ex?.notes || ''
    });
  });
  const upsertedMerchants = results.filter(r => r.status === 'fulfilled').length;
  const failedMerchants = results.length - upsertedMerchants;
  if (failedMerchants) warnings.push(`${failedMerchants} merchant(s) failed to save`);

  return resp(200, { updatedPartners, newPartners, upsertedMerchants, failedMerchants, failedPartners, warnings });
}

function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
