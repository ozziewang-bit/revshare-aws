import { listContracts, getContract, putContract, deleteContract, ulid } from '../db.mjs';

// Fields a client may write. `sheetTerms` is import-preview data and is not stored;
// share terms live on the partner's rule, never on the contract row.
const WRITABLE = [
  'merchantName', 'merchantType', 'counterParty', 'partnerId', 'installedUnits',
  'units', 'startDate', 'endDate', 'terminationNoticeDays', 'declineToRenew',
  'autoRenewal', 'contractLink', 'notes',
];

function pick(body) {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  return out;
}

export async function listContractsRoute() {
  const items = await listContracts();
  items.sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  return resp(200, items);
}

export async function createContractRoute(event) {
  const body = JSON.parse(event.body || '{}');
  if (!String(body.merchantName || '').trim()) {
    return resp(400, { error: 'missing_fields', required: ['merchantName'] });
  }
  const contract = { contractId: ulid(), partnerId: null, units: {}, notes: '', ...pick(body) };
  return resp(201, await putContract(contract));
}

export async function updateContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const body = JSON.parse(event.body || '{}');
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  return resp(200, await putContract({ ...existing, ...pick(body), contractId: id }));
}

export async function deleteContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteContract(id);
  return resp(204, null);
}

function resp(statusCode, body) {
  return { statusCode, body: body === null ? '' : JSON.stringify(body) };
}
