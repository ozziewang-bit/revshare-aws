import { listMailTemplates, putMailTemplate, deleteMailTemplate,
         listMailLog, putMailLog, ulid } from '../db.mjs';

const resp = (statusCode, body) => ({ statusCode, body: body === null ? '' : JSON.stringify(body) });

// Mail templates are per region and edited in Settings. The app does not send from here — the
// browser does, through the signed-in user's own Gmail — so this module only stores what to
// write and records what went out.
const WRITABLE = ['name', 'subject', 'body', 'fromAlias'];

export async function listMailTemplatesRoute() {
  const items = await listMailTemplates();
  items.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return resp(200, items);
}

export async function putMailTemplateRoute(event) {
  const body = JSON.parse(event.body || '{}');
  if (!String(body.subject || '').trim()) return resp(400, { error: 'subject_required' });
  const t = { id: body.id || ulid() };
  for (const k of WRITABLE) if (k in body) t[k] = body[k];
  t.updatedBy = event.auth?.email || null;
  return resp(200, await putMailTemplate(t));
}

export async function deleteMailTemplateRoute(event) {
  await deleteMailTemplate(event.pathParameters?.templateId);
  return resp(204, null);
}

export async function listMailLogRoute(event) {
  const items = await listMailLog(event.pathParameters?.runId);
  items.sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || ''));
  return resp(200, items);
}

// Written only AFTER Gmail has accepted the message, so this records sends that happened rather
// than sends that were attempted. A failed send leaves no row — the browser reports the failure
// and the operator can try again without a phantom entry saying it already went.
export async function createMailLogRoute(event) {
  const runId = event.pathParameters?.runId;
  const body = JSON.parse(event.body || '{}');
  if (!String(body.to || '').trim()) return resp(400, { error: 'to_required' });
  return resp(201, await putMailLog(runId, {
    id: ulid(),
    contractId: body.contractId || null,
    merchantName: body.merchantName || null,
    to: body.to,
    subject: body.subject || null,
    attachment: body.attachment || null,
    gmailId: body.gmailId || null,
    fromAlias: body.fromAlias || null,
    sentAt: new Date().toISOString(),
    sentBy: event.auth?.email || null,
  }));
}
