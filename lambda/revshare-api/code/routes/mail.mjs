import { listMailTemplates, putMailTemplate, deleteMailTemplate,
         listMailLog, putMailLog, putTemplateAttachment, getTemplateAttachment,
         ulid } from '../db.mjs';

const resp = (statusCode, body) => ({ statusCode, body: body === null ? '' : JSON.stringify(body) });

// Mail templates are per region and edited in Settings. The app does not send from here — the
// browser does, through the signed-in user's own Gmail — so this module only stores what to
// write and records what went out.
// `kind` decides what the send screen asks for: a statement needs a period and attaches a
// file, a plain message needs neither.
const WRITABLE = ['name', 'kind', 'subject', 'body', 'fromAlias',
                  // A file carried by every message using this template. Only a plain message
                  // may have one: a statement already attaches that merchant's own figures, and
                  // two attachments raise the question of which one matters.
                  'attachmentKey', 'attachmentName', 'attachmentSize', 'attachmentType'];

// 5 MB. The request carries the file base64-encoded, which inflates it by a third, against an
// API Gateway limit of 10 MB — so this is the largest size that still leaves headroom. Refused
// with the actual size rather than a generic error, because "too large" without a number tells
// nobody what to do.
const MAX_ATTACHMENT = 5 * 1024 * 1024;

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
    // Recorded so the log can be reconciled against the run itself: "we sent it" is not the
    // same claim as "we sent the right one".
    period: body.period || null,
    payout: typeof body.payout === 'number' ? body.payout : null,
    attachmentRows: typeof body.attachmentRows === 'number' ? body.attachmentRows : null,
    gmailId: body.gmailId || null,
    fromAlias: body.fromAlias || null,
    sentAt: new Date().toISOString(),
    sentBy: event.auth?.email || null,
  }));
}

export async function putTemplateAttachmentRoute(event) {
  const id = event.pathParameters?.templateId;
  const body = JSON.parse(event.body || '{}');
  const name = String(body.name || '').trim();
  if (!name || typeof body.data !== 'string') return resp(400, { error: 'name_and_data_required' });

  const bytes = Buffer.from(body.data, 'base64');
  if (!bytes.length) return resp(400, { error: 'empty_file' });
  if (bytes.length > MAX_ATTACHMENT) {
    return resp(413, { error: 'too_large', bytes: bytes.length, limit: MAX_ATTACHMENT });
  }
  // Keyed by ULID, never by filename: replacing a file must not overwrite the object a past
  // send's record points at, and a filename can contain anything at all.
  const key = `mail-templates/${id}/${ulid()}`;
  await putTemplateAttachment(key, bytes, body.type || 'application/octet-stream');
  return resp(200, {
    attachmentKey: key, attachmentName: name,
    attachmentSize: bytes.length, attachmentType: body.type || 'application/octet-stream',
  });
}

export async function getTemplateAttachmentRoute(event) {
  const templates = await listMailTemplates();
  const t = templates.find(x => x.id === event.pathParameters?.templateId);
  if (!t || !t.attachmentKey) return resp(404, { error: 'no_attachment' });
  const file = await getTemplateAttachment(t.attachmentKey);
  if (!file) return resp(404, { error: 'attachment_missing' });
  return resp(200, {
    name: t.attachmentName, type: file.contentType,
    size: file.bytes.length, data: file.bytes.toString('base64'),
  });
}
