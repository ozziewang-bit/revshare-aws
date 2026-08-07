// One-off, idempotent, safe to re-run even while the app is live. Copies payout fields from
// PARTNER rows onto their CONTRACT row, then points every store-registry row at a contract.
//
// Safety: the "is this field absent" check is read from a snapshot taken once at the top of
// the script, but every write is ALSO conditional (DynamoDB ConditionExpression) on the field
// still being absent at write time. If someone edits a contract's rule in the app during the
// run, the condition fails, the write is skipped (counted as `raced`), and their edit is left
// alone — the migration never overwrites a value that was set after the snapshot was read.
// Reports and changes nothing on --dry-run.
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

let copied = 0, skipped = 0, unlinked = 0, racedContracts = 0;
let pointed = 0, orphanStores = 0, racedStores = 0;

function printSummary(label) {
  console.log(label);
  console.log('partners            :', partners.length);
  console.log('contracts           :', contracts.length);
  console.log('  fields copied onto :', copied);
  console.log('  already had them   :', skipped);
  console.log('  no partner, skipped:', unlinked);
  console.log('  raced (edited concurrently):', racedContracts);
  console.log('store rows          :', stores.length);
  console.log('  pointed at a contract:', pointed);
  console.log('  left unmatched       :', orphanStores);
  console.log('  raced (edited concurrently):', racedStores);
}

try {
  for (const c of contracts) {
    const p = c.partnerId ? partnerById.get(c.partnerId) : null;
    if (!p) { unlinked++; continue; }               // no matching partner — nothing to copy from
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
      ConditionExpression: fields.map(f => `attribute_not_exists(#${f})`).join(' AND '),
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
    })).catch(e => {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      racedContracts++;   // someone set it between the snapshot and now — leave theirs alone
    });
  }

  for (const s of stores) {
    if (s.contractId !== undefined) continue;
    const c = s.partnerId ? byPartner.get(s.partnerId) : null;
    if (!c) { orphanStores++; continue; }            // brand has no contract row — stays unmatched, by decision
    pointed++;
    if (DRY) continue;
    await ddb.send(new UpdateCommand({
      TableName: TABLE, Key: { pk: 'MERCHANT', sk: s.sk },
      UpdateExpression: 'SET contractId = :c',
      ConditionExpression: 'attribute_not_exists(contractId)',
      ExpressionAttributeValues: { ':c': c.contractId },
    })).catch(e => {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      racedStores++;   // someone linked it between the snapshot and now — leave theirs alone
    });
  }
} catch (e) {
  // Idempotence means resuming is safe — the operator just needs to see where it stopped
  // instead of an unhandled rejection with no counters at all.
  printSummary('--- FAILED partway through — counters below are as far as it got ---');
  throw e;
}

printSummary(DRY ? '--- DRY RUN, nothing written ---' : '--- migration applied ---');
