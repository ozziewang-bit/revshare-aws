import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { ulid } from 'ulid';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE  = process.env.REVSHARE_TABLE || 'RevsharePartner';
const RUNS_BUCKET = process.env.REVSHARE_RUNS_BUCKET || 'revshare-runs-812751451548-sea7';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

export async function listPartners() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'PARTNER', ':s': 'META#' },
  }));
  return (out.Items || []).filter(p => !p.archived);
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
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': `RUN#${partnerId}` },
    ScanIndexForward: false
  }));
  return out.Items || [];
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
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'MERCHANT' },
  }));
  return out.Items || [];
}

export async function getMerchant(merchantId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'MERCHANT', sk: `MERCHANT#${merchantId}` }
  }));
  return out.Item || null;
}

export async function putMerchant(merchant) {
  const now = new Date().toISOString();
  const item = {
    pk: 'MERCHANT',
    sk: `MERCHANT#${merchant.merchantId}`,
    ...merchant,
    nameLower: (merchant.name || '').toLowerCase().trim(),
    updatedAt: now,
    createdAt: merchant.createdAt || now
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function deleteMerchant(merchantId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'MERCHANT', sk: `MERCHANT#${merchantId}` }
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
    partnerCount: bulkRun.partnerCount ?? 0,
    unmatchedCount: bulkRun.unmatchedCount ?? 0,
    unmatchedOrderCount: bulkRun.unmatchedOrderCount ?? 0,
    unmatchedRevenue: bulkRun.unmatchedRevenue ?? 0,
    totalPayout: bulkRun.totalPayout ?? 0,
    warningCount: (bulkRun.warnings || []).length
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return bulkRun;
}

export async function listBulkRuns() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'BULKRUN' },
    ScanIndexForward: false
  }));
  return out.Items || [];
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
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'CONFIG', ':s': 'MODEL#' },
  }));
  return (out.Items || [])
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
