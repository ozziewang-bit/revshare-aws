import { listContracts, getContract, putContract, deleteContract, listPartners, ulid } from '../db.mjs';
import { normalizeContractRow, buildImportPlan } from '../contracts.mjs';

// Fields a client may write. `sheetTerms` is import-preview data and is not stored;
// share terms live on the partner's rule, never on the contract row.
const WRITABLE = [
  'merchantName', 'merchantType', 'counterParty', 'partnerId', 'installedUnits',
  'units', 'startDate', 'endDate', 'terminationNoticeDays',
  'autoRenewal', 'contractLink', 'notes',
  // Contact details are entered in the app, not imported — the source workbook has no
  // contact columns, so the importer never sets these and a re-import never clears them.
  'contactName', 'contactPhone', 'contactEmail',
  // The contract is the payout entity now: it owns the rule, how it aggregates, whether it
  // is paid at all, and in which currency. These were PARTNER fields until 2026-08-07.
  'rule', 'aggregationMode', 'noPayout', 'currency',
  // Manual archive, set when a contract ends. `archivedAt` is stamped server-side, not
  // taken from the client.
  'archived',
  // Order-report names assigned to this merchant from a run's unmatched list. Third and last
  // matching pass — see indexOrderAliases in payout.mjs. Each matching alias ADDS a store row
  // to this contract, so it counts as a machine for flat_per_machine / per-machine MG.
  'orderAliases',
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
  const next = { ...existing, ...pick(body), contractId: id };
  // Stamp the archive date here rather than trusting a client clock, and only on the
  // transition — re-saving an already-archived row must not move the date.
  if (next.archived && !existing.archived) next.archivedAt = new Date().toISOString();
  if (!next.archived) delete next.archivedAt;
  return resp(200, await putContract(next));
}

export async function deleteContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteContract(id);
  return resp(204, null);
}

export async function importContractsRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) return resp(400, { error: 'no_rows' });

  const normalized = rawRows.map(normalizeContractRow).filter(Boolean);
  const [existing, partners] = await Promise.all([listContracts(), listPartners()]);
  const plan = buildImportPlan(normalized, existing, partners, body.links || {});

  // Bounded concurrency — 208 rows would otherwise open 208 sockets at once.
  const all = [...plan.creates.map(c => ({ ...c, contractId: ulid() })), ...plan.updates];
  for (let i = 0; i < all.length; i += 10) {
    await Promise.all(all.slice(i, i + 10).map(putContract));
  }

  return resp(200, {
    created: plan.creates.length,
    updated: plan.updates.length,
    linked: all.filter(c => c.partnerId).length,
    unmatched: plan.unmatched,
  });
}

function resp(statusCode, body) {
  return { statusCode, body: body === null ? '' : JSON.stringify(body) };
}
