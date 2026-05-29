import { listMerchants, getMerchant, putMerchant, deleteMerchant, ulid } from '../db.mjs';

const VALID_MODELS = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);

export async function listMerchantsRoute() {
  return resp(200, await listMerchants());
}

export async function createMerchantRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { name, partnerId, machineModel } = body;
  if (!name || !partnerId) return resp(400, { error: 'missing_fields', required: ['name','partnerId'] });
  if (machineModel && !VALID_MODELS.has(machineModel)) return resp(400, { error: 'invalid_machineModel' });
  const merchant = {
    merchantId: ulid(),
    name,
    partnerId,
    machineModel: machineModel || null,
    externalId: body.externalId || null,
    notes: body.notes || ''
  };
  return resp(201, await putMerchant(merchant));
}

export async function getMerchantRoute(event) {
  const id = event.pathParameters?.merchantId;
  const m = await getMerchant(id);
  if (!m) return resp(404, { error: 'not_found' });
  return resp(200, m);
}

export async function updateMerchantRoute(event) {
  const id = event.pathParameters?.merchantId;
  const body = JSON.parse(event.body || '{}');
  const existing = await getMerchant(id);
  if (!existing) return resp(404, { error: 'not_found' });
  if (body.machineModel && !VALID_MODELS.has(body.machineModel)) return resp(400, { error: 'invalid_machineModel' });
  return resp(200, await putMerchant({ ...existing, ...body, merchantId: id }));
}

export async function deleteMerchantRoute(event) {
  const id = event.pathParameters?.merchantId;
  const existing = await getMerchant(id);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteMerchant(id);
  return resp(204, null);
}

function resp(statusCode, body) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: body == null ? '' : JSON.stringify(body) };
}
