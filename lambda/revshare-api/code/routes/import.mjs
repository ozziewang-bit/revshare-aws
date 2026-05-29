import { listPartners, putPartner, listMerchants, putMerchant, ulid } from '../db.mjs';

const VALID_MODELS = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);

export function parseDeviceType(deviceType) {
  if (!deviceType) return null;
  const m = String(deviceType).match(/-(S5|S8|S10|T8|T10|T20|T35|LL?20|LL?40)$/i);
  if (!m) return null;
  return m[1].toUpperCase().replace('LL', 'L');
}

export function compileRule({ gpPercent, mgEnabled, mgAmount, electricity, placement, others }) {
  const children = [];
  const gpLeaf = { type: 'percent', rows: [{ model: 'ALL', percent: Number(gpPercent) }] };
  if (mgEnabled && Number(mgAmount) > 0) {
    children.push({ type: 'max', children: [gpLeaf, { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: Number(mgAmount) }] }] });
  } else {
    children.push(gpLeaf);
  }
  if (Number(electricity) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(electricity) });
  if (Number(placement) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(placement) });
  if (Number(others) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(others) });
  if (children.length === 1) return children[0];
  return { type: 'sum', children };
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
    const rule = compileRule({ gpPercent: p.gpPercent || 0, mgEnabled: !!p.mgEnabled, mgAmount: p.mgAmount || 0, electricity: p.electricity || 0, placement: p.placement || 0, others: p.others || 0 });
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

function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
