import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand, BatchWriteCommand
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ulid } from 'ulid';
import { queryAll, chunkUnique } from './ddb-util.mjs';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE  = process.env.REVSHARE_TABLE || 'RevsharePartner';
const RUNS_BUCKET = process.env.REVSHARE_RUNS_BUCKET || 'revshare-runs-812751451548-sea7';
// Region-scoped default currency for auto-created contract stubs (bulk-runs.mjs). This file
// is never synced between regions (unlike bulk-runs.mjs, which is), so this is where the
// region-specific literal has to live — same pattern as TABLE/RUNS_BUCKET above. The Singapore
// db.mjs (~/revshare_sg) must define this export with 'SGD' as its hardcoded default, or the
// TH literal 'THB' will keep shipping to SG via the synced bulk-runs.mjs import.
export const DEFAULT_CURRENCY = process.env.REVSHARE_CURRENCY || 'THB';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Every list function below MUST use this, never a bare ddb.send(new QueryCommand(...)):
// a single Query returns at most 1MB and silently drops the rest. See ddb-util.mjs for what
// that cost us (§1c). If you add a row family, list it through here the same way.
const query = params => queryAll(p => ddb.send(new QueryCommand(p)), params);
const s3 = new S3Client({ region: REGION });

export async function listPartners() {
  const items = await query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'PARTNER', ':s': 'META#' },
  });
  return items.filter(p => !p.archived);
}

export async function getPartner(partnerId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'PARTNER', sk: `META#${partnerId}` }
  }));
  return out.Item || null;
}

export async function putPartner(partner) {
  const now = new Date().toISOString();
  const item = {
    pk: 'PARTNER',
    sk: `META#${partner.partnerId}`,
    ...partner,
    updatedAt: now,
    createdAt: partner.createdAt || now
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function putRun(run) {
  const item = { pk: `RUN#${run.partnerId}`, sk: `RUN#${run.runId}`, ...run };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function listRuns(partnerId) {
  return query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `RUN#${partnerId}` },
    ScanIndexForward: false
  });
}

export async function getRun(partnerId, runId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: `RUN#${partnerId}`, sk: `RUN#${runId}` }
  }));
  return out.Item || null;
}

export { ulid };

// ── Merchants ─────────────────────────────────────────────────────────────

export async function listMerchants() {
  return query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'MERCHANT' },
  });
}

export async function getMerchant(merchantId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'MERCHANT', sk: `MERCHANT#${merchantId}` }
  }));
  return out.Item || null;
}

export function merchantItem(merchant) {
  const now = new Date().toISOString();
  return {
    pk: 'MERCHANT',
    sk: `MERCHANT#${merchant.merchantId}`,
    ...merchant,
    nameLower: (merchant.name || '').toLowerCase().trim(),
    updatedAt: now,
    createdAt: merchant.createdAt || now
  };
}

export async function putMerchant(merchant) {
  const item = merchantItem(merchant);
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

// Bulk upsert for the roster path. One PutItem per store meant ~4,000 signed round trips on a
// 256MB Lambda, which is how /bulk-runs/prepare came to exceed its 30s timeout; BatchWriteItem
// takes 25 per call. DynamoDB may decline part of a batch under load and hands those back in
// UnprocessedItems rather than failing the call — they must be retried or rows go missing
// silently, which is the same class of bug as the unpaginated Query above.
export async function putMerchantsBatch(merchants, { concurrency = 8 } = {}) {
  const items = merchants.map(merchantItem);
  const chunks = chunkUnique(items, i => i.sk, 25);

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    while (next < chunks.length) {
      let pending = chunks[next++].map(Item => ({ PutRequest: { Item } }));
      for (let attempt = 0; pending.length; attempt++) {
        const out = await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: pending } }));
        pending = out.UnprocessedItems?.[TABLE] || [];
        if (pending.length) {
          if (attempt >= 7) throw new Error(`BatchWriteItem: ${pending.length} items unprocessed after ${attempt + 1} attempts`);
          await new Promise(r => setTimeout(r, 50 * 2 ** attempt));
        }
      }
    }
  }));
  return items;
}

export async function deleteMerchant(merchantId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'MERCHANT', sk: `MERCHANT#${merchantId}` }
  }));
}

// ── Contracts ─────────────────────────────────────────────────────────────

export async function listContracts() {
  return query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'CONTRACT' },
  });
}

export async function getContract(contractId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'CONTRACT', sk: `CONTRACT#${contractId}` }
  }));
  return out.Item || null;
}

export async function putContract(contract) {
  const now = new Date().toISOString();
  const item = {
    pk: 'CONTRACT',
    sk: `CONTRACT#${contract.contractId}`,
    ...contract,
    merchantNameLower: (contract.merchantName || '').toLowerCase().trim(),
    updatedAt: now,
    createdAt: contract.createdAt || now
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function deleteContract(contractId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'CONTRACT', sk: `CONTRACT#${contractId}` }
  }));
}

// ── Bulk Runs ─────────────────────────────────────────────────────────────

// `inputs` (2026-08-24) is the run's source data — parsed roster, orders and machine list. It
// is written as a SEPARATE S3 object so the run-detail page, which fetches the payload on every
// view, never pays to download several MB it does not render. Without this a run could not be
// recomputed at all: the payload holds only aggregates, so answering "how would this run look
// under corrected matching?" meant asking the user to re-upload files that only existed in
// their Downloads folder and a browser tab.
export async function putBulkRun(bulkRun, inputs) {
  const s3Key = `runs/${bulkRun.runId}.json`;
  const inputsKey = inputs ? `runs/${bulkRun.runId}.inputs.json` : null;
  if (inputs) {
    await s3.send(new PutObjectCommand({
      Bucket: RUNS_BUCKET,
      Key: inputsKey,
      Body: JSON.stringify(inputs),
      ContentType: 'application/json'
    }));
  }
  // Full payload goes to S3 — bulk runs can exceed DynamoDB's 400 KB item limit.
  await s3.send(new PutObjectCommand({
    Bucket: RUNS_BUCKET,
    Key: s3Key,
    Body: JSON.stringify(bulkRun),
    ContentType: 'application/json'
  }));
  // Slim summary index in DynamoDB drives the list view + getBulkRun lookup.
  const item = {
    pk: 'BULKRUN',
    sk: `BULKRUN#${bulkRun.runId}`,
    s3Key,
    inputsKey,
    runId: bulkRun.runId,
    periodStart: bulkRun.periodStart,
    periodEnd: bulkRun.periodEnd,
    uploadedAt: bulkRun.uploadedAt,
    orderCount: bulkRun.orderCount ?? 0,
    merchantCount: bulkRun.merchantCount ?? 0,
    paidBrandCount: bulkRun.paidBrandCount ?? 0,
    rosterBrandCount: bulkRun.rosterBrandCount ?? 0,
    unmatchedCount: bulkRun.unmatchedCount ?? 0,
    unmatchedOrderCount: bulkRun.unmatchedOrderCount ?? 0,
    unmatchedRevenue: bulkRun.unmatchedRevenue ?? 0,
    skippedCount: bulkRun.skippedCount ?? 0,
    skippedRevenue: bulkRun.skippedRevenue ?? 0,
    totalOrderRevenue: bulkRun.totalOrderRevenue ?? 0,
    totalPayout: bulkRun.totalPayout ?? 0,
    warningCount: (bulkRun.warnings || []).length,
    archived: bulkRun.archived || false
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return bulkRun;
}

export async function listBulkRuns() {
  return query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'BULKRUN' },
    ScanIndexForward: false
  });
}

export async function getBulkRun(runId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${runId}` }
  }));
  const item = out.Item;
  if (!item) return null;
  if (item.s3Key) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: item.s3Key }));
    return JSON.parse(await obj.Body.transformToString());
  }
  return item;   // legacy run stored inline in DynamoDB (pre-S3)
}

// Read back what a run was computed from. null for runs created before 2026-08-24, which
// have no stored inputs and therefore cannot be recomputed.
export async function getBulkRunInputs(runId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${runId}` }
  }));
  const key = out.Item?.inputsKey;
  if (!key) return null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }));
    return JSON.parse(await obj.Body.transformToString());
  } catch { return null; }
}

export async function deleteBulkRun(runId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${runId}` }
  }));
  const item = out.Item;
  // Both objects, or deleting a run leaves its inputs orphaned in the bucket forever.
  for (const key of [item?.s3Key, item?.inputsKey]) {
    if (!key) continue;
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: RUNS_BUCKET, Key: key }));
    } catch { /* tolerate an already-missing S3 object */ }
  }
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${runId}` }
  }));
}

// ── Feature requests ──────────────────────────────────────────────────────
// Anyone signed in can file one; admins resolve them. Kept in this table rather than a new one
// so it needs no extra IAM, and per-region like everything else here — a Thai user's request
// lands in the Thai table, which is also where the person reading it is working.

export async function listFeatureRequests() {
  return query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'FEATURE' },
    ScanIndexForward: false,        // ULID sort key, so newest first
  });
}

export async function getFeatureRequest(id) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'FEATURE', sk: `FEATURE#${id}` } }));
  return out.Item || null;
}

export async function putFeatureRequest(fr) {
  const now = new Date().toISOString();
  const item = { pk: 'FEATURE', sk: `FEATURE#${fr.id}`, ...fr, updatedAt: now, createdAt: fr.createdAt || now };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function deleteFeatureRequest(id) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: 'FEATURE', sk: `FEATURE#${id}` } }));
}

// ── Machine Models ────────────────────────────────────────────────────────

export async function listMachineModels() {
  const items = await query({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'CONFIG', ':s': 'MODEL#' },
  });
  return items
    .map(({ code, displayName }) => ({ code, displayName }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function getMachineModel(code) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'CONFIG', sk: `MODEL#${code}` }
  }));
  return out.Item ? { code: out.Item.code, displayName: out.Item.displayName } : null;
}

export async function putMachineModel({ code, displayName }) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'CONFIG', sk: `MODEL#${code}`, code, displayName }
  }));
  return { code, displayName };
}

export async function deleteMachineModel(code) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'CONFIG', sk: `MODEL#${code}` }
  }));
}

// ── The weekly upload record ──────────────────────────────────────────────
// The brand names the last weekly merchant file contained, kept as ONE row rather than a
// per-contract "last seen" stamp. The only question asked of it is "was this merchant in my
// latest file?", which needs the latest list and nothing else; a per-contract field would mean
// rewriting all ~260 contracts every upload to record something no payout ever reads.
// Consequence to know: only the LATEST upload is remembered. There is no per-merchant history,
// so the grid can say "not in the 3 Sep upload" but never "last seen 12 Aug".

export async function getLastUpload() {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { pk: 'CONFIG', sk: 'UPLOAD#LATEST' }
  }));
  if (!out.Item) return null;
  const { pk, sk, ...rec } = out.Item;
  return { at: rec.at, names: rec.names || [], s3Key: rec.s3Key || null, counts: rec.counts || null };
}

export async function putLastUpload(names, extra = {}) {
  const rec = { at: new Date().toISOString(), names, ...extra };
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: { pk: 'CONFIG', sk: 'UPLOAD#LATEST', ...rec }
  }));
  return rec;
}

// ── Mail templates + the record of what was sent (2026-09-25) ──────────────────────────────
// Templates are per region, because a Thai merchant and a Singapore one are not written to in
// the same language or currency. `MAILLOG` is deliberately a SEPARATE row family rather than a
// field on the run: a run is a frozen snapshot of what was CALCULATED (§10.5), and what was
// SENT is a different fact that keeps changing after the run is finished.

export async function listMailTemplates() {
  // TableName is NOT added by `query` — every caller passes it. Omitting it fails at runtime
  // with "Value null at 'tableName'", which reached the browser as an empty list.
  return (await query({ TableName: TABLE,
                        KeyConditionExpression: 'pk = :p',
                        ExpressionAttributeValues: { ':p': 'MAILTEMPLATE' } }))
    .map(({ pk, sk, ...t }) => t);
}

export async function putMailTemplate(t) {
  const now = new Date().toISOString();
  const item = { pk: 'MAILTEMPLATE', sk: `MAILTEMPLATE#${t.id}`, ...t,
                 updatedAt: now, createdAt: t.createdAt || now };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  const { pk, sk, ...out } = item;
  return out;
}

export async function deleteMailTemplate(id) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { pk: 'MAILTEMPLATE', sk: `MAILTEMPLATE#${id}` } }));
}

// A file attached to a mail TEMPLATE — a notice, a rate card — uploaded once and sent with
// every message that uses that template. S3 rather than DynamoDB: a 400KB item limit would
// rule out most real attachments, and this is the same bucket the runs already use.
//
// A replaced file is NOT deleted. A past send's record points at what was actually sent, and
// storage is pennies against losing that evidence.
export async function putTemplateAttachment(key, bytes, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: RUNS_BUCKET, Key: key, Body: bytes,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { key };
}

export async function getTemplateAttachment(key) {
  if (!key) return null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }));
    const bytes = await obj.Body.transformToByteArray();
    return { bytes: Buffer.from(bytes), contentType: obj.ContentType || 'application/octet-stream' };
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;
    throw e;
  }
}

// One row per mail actually accepted by Gmail. Keyed by run so "did we send Central's statement
// for September?" is one query. Nothing here is ever updated — a send happened or it did not.
export async function listMailLog(runId) {
  return (await query({ TableName: TABLE,
                        KeyConditionExpression: 'pk = :p',
                        ExpressionAttributeValues: { ':p': `MAILLOG#${runId}` } }))
    .map(({ pk, sk, ...m }) => m);
}

export async function putMailLog(runId, entry) {
  const item = { pk: `MAILLOG#${runId}`, sk: `MAILLOG#${entry.id}`, ...entry };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  const { pk, sk, ...out } = item;
  return out;
}

// One document per RECORDED weekly upload — the folded brand rows the import already built,
// kept so the Reconcile tab can compare field by field long after the dialog closed. It goes
// to S3 rather than DynamoDB for the same reason bulk runs do: 260 brands of contact detail
// is comfortably past the 400KB item limit. RUNS_BUCKET is region-specific and defined at the
// top of this file, which is exactly why this function cannot be synced.
export async function putUploadDoc(doc) {
  const key = `uploads/${ulid()}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: RUNS_BUCKET, Key: key,
    Body: JSON.stringify(doc), ContentType: 'application/json'
  }));
  return { key, at: doc.at };
}

export async function getUploadDoc(key) {
  if (!key) return null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }));
    return JSON.parse(await obj.Body.transformToString());
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;   // pointer outlived the object; not an error
    throw e;
  }
}
