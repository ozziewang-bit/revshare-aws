import { listPartners, getPartner, putPartner, ulid } from '../db.mjs';

export async function listPartnersRoute() {
  const items = await listPartners();
  return resp(200, items);
}

export async function createPartnerRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { name, currency, aggregationMode } = body;
  if (!name || !currency || !aggregationMode) {
    return resp(400, { error: 'missing_fields' });
  }
  if (aggregationMode !== 'whole' && aggregationMode !== 'per_store') {
    return resp(400, { error: 'invalid_aggregationMode' });
  }
  const partner = {
    partnerId: ulid(),
    name, currency, aggregationMode,
    rule: { type: 'sum', children: [] },
    notes: '',
    archived: false
  };
  const saved = await putPartner(partner);
  return resp(201, saved);
}

export async function getPartnerRoute(event) {
  const id = event.pathParameters?.partnerId;
  const p = await getPartner(id);
  if (!p) return resp(404, { error: 'not_found' });
  return resp(200, p);
}

export async function updatePartnerRoute(event) {
  const id = event.pathParameters?.partnerId;
  const body = JSON.parse(event.body || '{}');
  const existing = await getPartner(id);
  if (!existing) return resp(404, { error: 'not_found' });
  const merged = { ...existing, ...body, partnerId: id };
  const saved = await putPartner(merged);
  return resp(200, saved);
}

export async function archivePartnerRoute(event) {
  const id = event.pathParameters?.partnerId;
  const existing = await getPartner(id);
  if (!existing) return resp(404, { error: 'not_found' });
  await putPartner({ ...existing, archived: true });
  return resp(204, null);
}

function resp(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: body == null ? '' : JSON.stringify(body)
  };
}
