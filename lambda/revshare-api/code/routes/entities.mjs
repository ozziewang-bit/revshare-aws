import { listEntities, getEntity, putEntity, deleteEntity, listContracts, ulid } from '../db.mjs';

const resp = (statusCode, body) => ({ statusCode, body: body === null ? '' : JSON.stringify(body) });

// The legal entity a payout is settled with — the thing an invoice is addressed to. ONE ENTITY
// COVERS MANY BRANDS (Central Pattana holds Central Ladprao, Eastville and Westgate), which is
// why it is a record of its own rather than a column repeated on each contract.
//
// It replaces nothing. `counterParty` stays on every contract exactly as it was typed, and a
// contract with no `entityId` keeps reading it. This record is additive: linking a contract sets
// a field that was absent, and unlinking leaves the original string still there.
const WRITABLE = ['name', 'taxId', 'address', 'notes'];

export async function listEntitiesRoute() {
  const items = await listEntities();
  items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return resp(200, items);
}

// A name is required because the name IS the thing — an entity with no name cannot be picked,
// invoiced, or told apart from another.
export async function putEntityRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const name = String(body.name || '').trim();
  if (!name) return resp(400, { error: 'name_required' });

  // Two entities with the same name defeat the whole point: the picker would show the same
  // company twice and brands would split across them exactly as the free-text field allowed.
  // Compared case- and space-insensitively, because that is precisely how the live duplicates
  // arose ('บริษัท เอ็มแอนด์ เอ็ม 2007 จำกัด' vs the same string without the space).
  const existing = await listEntities();
  const key = squash(name);
  const clash = existing.find(e => squash(e.name) === key && e.entityId !== body.entityId);
  if (clash) return resp(409, { error: 'name_taken', entityId: clash.entityId, name: clash.name });

  const e = { entityId: body.entityId || ulid() };
  for (const k of WRITABLE) if (k in body) e[k] = body[k];
  e.name = name;
  e.updatedBy = event.auth?.email || null;
  return resp(200, await putEntity(e));
}

// Refused while any contract still points here. Deleting would not lose the contract's own
// `counterParty` string — that was never removed — but it would silently unlink brands from the
// entity someone grouped them under, and say nothing.
export async function deleteEntityRoute(event) {
  const entityId = event.pathParameters?.entityId;
  if (!entityId) return resp(400, { error: 'missing_entity' });
  const found = await getEntity(entityId);
  if (!found) return resp(404, { error: 'not_found' });

  const contracts = await listContracts();
  const used = contracts.filter(c => c.entityId === entityId);
  if (used.length) {
    return resp(409, {
      error: 'entity_in_use',
      count: used.length,
      merchants: used.slice(0, 20).map(c => c.merchantName).filter(Boolean),
    });
  }
  await deleteEntity(entityId);
  return resp(204, null);
}

// Whitespace and case are not part of a company's identity here. Kept local rather than shared:
// it exists to catch the duplicate-entry case above, not to normalise anything for storage —
// the name is always stored exactly as typed.
function squash(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}
