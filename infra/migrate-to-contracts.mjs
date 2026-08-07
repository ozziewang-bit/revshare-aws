// One-off, idempotent. Copies payout fields from PARTNER rows onto their CONTRACT row, then
// points every store-registry row at a contract.
//
// Safety: only ever writes a field that is ABSENT on the target, so re-running cannot
// overwrite a rule edited in the app after the first run. Reports and changes nothing on
// --dry-run.
//
//   node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7 --dry-run
//   node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const TABLE = arg('--table') || 'RevsharePartner';
const REGION = arg('--region') || 'ap-southeast-7';
const DRY = process.argv.includes('--dry-run');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function queryAll(pk) {
  const out = []; let last;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey: last,
    }));
    out.push(...(r.Items || [])); last = r.LastEvaluatedKey;
  } while (last);
  return out;
}

const [partners, contracts, stores] = await Promise.all([
  queryAll('PARTNER'), queryAll('CONTRACT'), queryAll('MERCHANT'),
]);
const partnerById = new Map(partners.map(p => [p.partnerId, p]));

// One contract per partner is assumed by step 2 — if two contracts share a partner there is
// no single answer for that partner's stores. Stop rather than pick one.
const byPartner = new Map();
for (const c of contracts.filter(c => c.partnerId)) {
  if (byPartner.has(c.partnerId)) {
    console.error(`ABORT: partner ${c.partnerId} is claimed by two contracts: ` +
      `"${byPartner.get(c.partnerId).merchantName}" and "${c.merchantName}". Resolve before migrating.`);
    process.exit(1);
  }
  byPartner.set(c.partnerId, c);
}

let copied = 0, skipped = 0;
for (const c of contracts) {
  const p = c.partnerId ? partnerById.get(c.partnerId) : null;
  if (!p) continue;
  const sets = {}, names = {}, vals = {};
  for (const f of ['rule', 'aggregationMode', 'noPayout', 'currency']) {
    if (c[f] !== undefined) continue;              // already migrated or edited in-app — leave it
    if (p[f] === undefined) continue;
    sets[f] = true; names[`#${f}`] = f; vals[`:${f}`] = p[f];
  }
  const fields = Object.keys(sets);
  if (!fields.length) { skipped++; continue; }
  copied++;
  if (DRY) continue;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'CONTRACT', sk: c.sk },
    UpdateExpression: 'SET ' + fields.map(f => `#${f} = :${f}`).join(', '),
    ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
  }));
}

let pointed = 0, orphanStores = 0;
for (const s of stores) {
  if (s.contractId !== undefined) continue;
  const c = s.partnerId ? byPartner.get(s.partnerId) : null;
  if (!c) { orphanStores++; continue; }            // brand has no contract row — stays unmatched, by decision
  pointed++;
  if (DRY) continue;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'MERCHANT', sk: s.sk },
    UpdateExpression: 'SET contractId = :c',
    ExpressionAttributeValues: { ':c': c.contractId },
  }));
}

console.log(DRY ? '--- DRY RUN, nothing written ---' : '--- migration applied ---');
console.log('partners            :', partners.length);
console.log('contracts           :', contracts.length);
console.log('  fields copied onto:', copied);
console.log('  already had them  :', skipped);
console.log('store rows          :', stores.length);
console.log('  pointed at a contract:', pointed);
console.log('  left unmatched       :', orphanStores);
