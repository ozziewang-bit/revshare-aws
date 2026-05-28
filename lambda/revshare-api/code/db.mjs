import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand
} from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE  = process.env.REVSHARE_TABLE || 'RevsharePartner';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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
