import { listMachineModels, getMachineModel, putMachineModel, deleteMachineModel } from '../db.mjs';
import { MACHINE_MODELS } from '../engine.mjs';

async function seedIfEmpty() {
  const existing = await listMachineModels();
  if (existing.length > 0) return existing;
  await Promise.all([...MACHINE_MODELS].map(code => putMachineModel({ code, displayName: code })));
  return [...MACHINE_MODELS]
    .map(code => ({ code, displayName: code }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function listMachineModelsRoute() {
  const models = await seedIfEmpty();
  return resp(200, models);
}

export async function createMachineModelRoute(event) {
  const { code, displayName } = JSON.parse(event.body || '{}');
  if (!code || !displayName) return resp(400, { error: 'missing_fields', required: ['code', 'displayName'] });
  const existing = await getMachineModel(code);
  if (existing) return resp(409, { error: 'code_exists' });
  await putMachineModel({ code, displayName });
  return resp(201, { code, displayName });
}

export async function updateMachineModelRoute(event) {
  const code = event.pathParameters?.code;
  const { displayName } = JSON.parse(event.body || '{}');
  if (!displayName) return resp(400, { error: 'missing_fields', required: ['displayName'] });
  const existing = await getMachineModel(code);
  if (!existing) return resp(404, { error: 'not_found' });
  await putMachineModel({ code, displayName });
  return resp(200, { code, displayName });
}

export async function deleteMachineModelRoute(event) {
  const code = event.pathParameters?.code;
  const existing = await getMachineModel(code);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteMachineModel(code);
  return resp(204, null);
}

function resp(statusCode, body) {
  if (statusCode === 204) return { statusCode, headers: {}, body: '' };
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
