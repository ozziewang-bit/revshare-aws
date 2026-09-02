// Feature requests. Anyone signed in can file one — the people who use this app daily are the
// ones who notice what it is missing, and making them ask elsewhere loses the thought.
// Resolving is admin-only.
import { listFeatureRequests, getFeatureRequest, putFeatureRequest, deleteFeatureRequest, ulid } from '../db.mjs';

const resp = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export async function listFeatureRequestsRoute() {
  return resp(200, await listFeatureRequests());
}

export async function createFeatureRequestRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const title = str(body.title, 140);
  if (!title) return resp(400, { error: 'title_required' });
  const fr = await putFeatureRequest({
    id: ulid(),
    title,
    detail: str(body.detail, 4000),
    // Where the person was when they thought of it — often the whole context of the request.
    screen: str(body.screen, 60),
    status: 'open',
    createdBy: event.auth?.email || '',
  });
  return resp(201, fr);
}

// Admin-only: status changes and notes. The title and detail are left exactly as filed, so a
// request cannot be quietly rewritten into something the requester did not ask for.
export async function updateFeatureRequestRoute(event, id) {
  const body = JSON.parse(event.body || '{}');
  const existing = await getFeatureRequest(id);
  if (!existing) return resp(404, { error: 'not_found' });
  const status = ['open', 'planned', 'done', 'declined'].includes(body.status) ? body.status : existing.status;
  const now = new Date().toISOString();
  const closing = status !== 'open' && existing.status === 'open';
  return resp(200, await putFeatureRequest({
    ...existing,
    status,
    note: body.note === undefined ? existing.note : str(body.note, 1000),
    resolvedBy: closing ? (event.auth?.email || '') : existing.resolvedBy,
    resolvedAt: closing ? now : existing.resolvedAt,
  }));
}

export async function deleteFeatureRequestRoute(id) {
  await deleteFeatureRequest(id);
  return resp(204, {});
}
