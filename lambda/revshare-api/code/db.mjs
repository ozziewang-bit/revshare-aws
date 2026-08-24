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
// a single Query returns at most 1MB and silently drops the rest. See paginate.mjs for what
// that cost us. If you add a row family, list it through here the same way.
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

export async function putBulkRun(bulkRun) {
  const s3Key = `runs/${bulkRun.runId}.json`;
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

export async function deleteBulkRun(runId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${runId}` }
  }));
  const item = out.Item;
  if (item?.s3Key) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: RUNS_BUCKET, Key: item.s3Key }));
    } catch { /* tolerate an already-missing S3 object */ }
  }
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${runId}` }
  }));
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
