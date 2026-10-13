// payreq-db.mjs — MCRM's side of payment requests (spec 2026-10-13): one PAYREQ row per Brand
// per month, the statement file handed to Payment Request, and the Lambda invoke.
//
// Deliberately NOT in db.mjs: that file is never synced to Singapore (§8), and adding a function
// to it in one region only has taken SG down three times. This module is identical in both
// regions — everything region-specific comes from Lambda env.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { queryAll } from './ddb-util.mjs';

const REGION = process.env.AWS_REGION || 'ap-southeast-7';
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';
const BUCKET = process.env.REVSHARE_RUNS_BUCKET || 'revshare-runs-812751451548-sea7';
const FN = process.env.PAYMENT_REQUEST_FUNCTION || '';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });
const pk = (period) => `PAYREQ#${period}`;

export async function listPayReqs(period) {
  return queryAll((p) => ddb.send(new QueryCommand(p)),
    { TableName: TABLE, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk(period) } });
}

export async function getPayReq(period, contractId) {
  const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: pk(period), sk: contractId } }));
  return out.Item || null;
}

// Conditional: a Brand + month is recorded once. False = someone recorded it first.
export async function putPayReq(period, row) {
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: { pk: pk(period), sk: row.contractId, ...row },
      ConditionExpression: 'attribute_not_exists(sk)' }));
    return true;
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

export async function deletePayReq(period, contractId) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: pk(period), sk: contractId } }));
}

// The statement goes to Payment Request BY KEY, not inside the invoke: an invoke payload is
// capped at 6 MB and a large Brand's statement is several. Its role may read `payreq/*` only.
export async function putStatement(period, contractId, bytes) {
  const key = `payreq/${period}/${contractId}.xlsx`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes,
    ContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  return { bucket: BUCKET, key };
}

// The Node 22 runtime ships the v3 SDK, so client-lambda resolves without a package.json change
// (one would also have to be installed in the SG repo by hand). Imported lazily so tests that
// inject their own invoke never load it.
export async function invokePaymentRequest(action, payload) {
  if (!FN) throw Object.assign(new Error('PAYMENT_REQUEST_FUNCTION is not set on this function'), { code: 'unreachable' });
  let res;
  try {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    const out = await new LambdaClient({ region: REGION }).send(new InvokeCommand({
      FunctionName: FN, Payload: Buffer.from(JSON.stringify({ internal: 'mcrm', action, payload })) }));
    const text = Buffer.from(out.Payload || []).toString();
    if (out.FunctionError) throw new Error(text || out.FunctionError);
    res = JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`Payment Request could not be reached: ${e.message}`), { code: 'unreachable' });
  }
  if (!res || !res.ok) throw Object.assign(new Error((res && res.error) || 'failed'), { code: (res && res.code) || 'error' });
  return res.result;
}
