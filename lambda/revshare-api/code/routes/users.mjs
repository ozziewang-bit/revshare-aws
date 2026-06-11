import { listUsers, putUser, deleteUser } from '../users-db.mjs';
import { PERMS } from '../auth.mjs';

const resp = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: body == null ? '' : JSON.stringify(body) });

export async function listUsersRoute() {
  return resp(200, await listUsers());
}
export async function putUserRoute(event) {
  const email = (event.pathParameters?.email || '').toLowerCase();
  if (!email) return resp(400, { error: 'missing_email' });
  const body = JSON.parse(event.body || '{}');
  const permissions = Object.fromEntries(PERMS.map(k => [k, !!(body.permissions || {})[k]]));
  const rec = { email, permissions, updatedAt: new Date().toISOString(), updatedBy: event.auth?.email || null };
  await putUser(rec);
  return resp(200, rec);
}
export async function deleteUserRoute(event) {
  const email = (event.pathParameters?.email || '').toLowerCase();
  if (!email) return resp(400, { error: 'missing_email' });
  await deleteUser(email);
  return resp(204, null);
}
