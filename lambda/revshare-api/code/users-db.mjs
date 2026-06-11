// Shared user-permissions table (RevshareUsers) — SAME physical table for both TH + SG
// Lambdas (permissions are global). Own DDB client so this file can be synced TH→SG
// without touching region-specific db.mjs.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'ap-southeast-7';
const USERS_TABLE = process.env.REVSHARE_USERS_TABLE || 'RevshareUsers';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export async function getUser(email) {
  const out = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
  return out.Item || null;
}
export async function listUsers() {
  const out = await ddb.send(new ScanCommand({ TableName: USERS_TABLE }));
  return out.Items || [];
}
export async function putUser(rec) {
  await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: rec }));
  return rec;
}
export async function deleteUser(email) {
  await ddb.send(new DeleteCommand({ TableName: USERS_TABLE, Key: { email } }));
}
