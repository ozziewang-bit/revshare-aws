// One-off, idempotent script (2026-08-09): brings payable brands into the Merchant view.
//
// Context: `infra/migrate-to-contracts.mjs` (2026-08-07) linked every CONTRACT that already
// had a partnerId to its PARTNER, then pointed every store row it could at a contractId. 65
// brands were left uncovered — referenced by store rows, but with no CONTRACT at all — and
// the user's decision at the time was "not paid," made against an aggregate count. On review,
// 41 of those 65 turned out to be payable partners (a rule that pays something, and not
// noPayout), covering 235 stores — including BTS, SEACON, Central, i-Store, Turtle Shop and
// UOB LIVE EMSPHERE. The user has now ruled: bring those 41 into the merchant view, carrying
// their existing rule and aggregation across. The other 24 (no paying rule) stay unpaid, as
// originally decided — this script must never create a contract for them.
//
// What it does, per candidate partner:
//   1. Create a CONTRACT row: merchantName = the partner's name, partnerId = the partner's id,
//      rule/aggregationMode/noPayout/currency copied verbatim from the partner.
//   2. Point every MERCHANT (store-registry) row that references that partnerId at the new
//      contractId — but only if the store doesn't already carry one (conditional write, same
//      safety property as migrate-to-contracts.mjs: never overwrite a value set after the
//      snapshot was read).
//
// A candidate is a non-archived PARTNER that: is referenced by at least one MERCHANT row (by
// partnerId), has NO existing CONTRACT row pointing at it (by partnerId), is not noPayout, and
// whose rule passes ruleHasValue (walks the tree for a non-zero leaf — the same strict test the
// run pipeline uses, not the old `!rule || !rule.type` check).
//
// Idempotent: a partner that already has a CONTRACT row (by partnerId) is skipped on the next
// run — re-running after a partial apply, or after the app itself creates a contract for one of
// these partners, does not create a duplicate.
//
//   node infra/adopt-payable-brands.mjs --table RevsharePartner --region ap-southeast-7 --dry-run
//   node infra/adopt-payable-brands.mjs --table RevsharePartner --region ap-southeast-7
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { ruleHasValue } from '../lambda/revshare-api/code/payout.mjs';

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

const contractPartnerIds = new Set(contracts.filter(c => c.partnerId).map(c => c.partnerId));
const referencedPartnerIds = new Set(stores.filter(s => s.partnerId).map(s => s.partnerId));

const candidates = partners.filter(p =>
  !p.archived &&
  referencedPartnerIds.has(p.partnerId) &&
  !contractPartnerIds.has(p.partnerId) &&
  !p.noPayout &&
  ruleHasValue(p.rule)
);

const storesByPartner = new Map();
for (const s of stores) {
  if (!s.partnerId) continue;
  if (!storesByPartner.has(s.partnerId)) storesByPartner.set(s.partnerId, []);
  storesByPartner.get(s.partnerId).push(s);
}

const report = candidates
  .map(p => ({ partnerId: p.partnerId, name: p.name, storeCount: (storesByPartner.get(p.partnerId) || []).length }))
  .sort((a, b) => b.storeCount - a.storeCount);
const totalStores = report.reduce((s, r) => s + r.storeCount, 0);

console.log(DRY ? '--- DRY RUN, nothing written ---' : '--- applying ---');
console.log('partners scanned           :', partners.length);
console.log('referenced by a store row  :', referencedPartnerIds.size);
console.log('already have a contract    :', contractPartnerIds.size);
console.log('payable, uncovered brands  :', candidates.length);
console.log('store rows those reach     :', totalStores);
console.log('');
report.forEach(r => console.log(`  ${String(r.storeCount).padStart(4)} store(s)  ${r.name}  (${r.partnerId})`));

if (DRY) {
  console.log('');
  console.log(`--- DRY RUN: would adopt ${candidates.length} brand(s) / ${totalStores} store(s). Nothing written. ---`);
  process.exit(0);
}

let contractsCreated = 0, storesPointed = 0, storesRaced = 0;
for (const p of candidates) {
  const contractId = ulid();
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      pk: 'CONTRACT', sk: `CONTRACT#${contractId}`,
      contractId,
      merchantName: p.name,
      merchantNameLower: (p.name || '').toLowerCase().trim(),
      partnerId: p.partnerId,
      rule: p.rule,
      aggregationMode: p.aggregationMode,
      noPayout: !!p.noPayout,
      currency: p.currency,
      units: {},
      notes: '',
      createdAt: now, updatedAt: now,
    },
  }));
  contractsCreated++;

  for (const s of storesByPartner.get(p.partnerId) || []) {
    if (s.contractId !== undefined) continue;   // already pointed somewhere — leave it alone
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE, Key: { pk: 'MERCHANT', sk: s.sk },
        UpdateExpression: 'SET contractId = :c',
        ConditionExpression: 'attribute_not_exists(contractId)',
        ExpressionAttributeValues: { ':c': contractId },
      }));
      storesPointed++;
    } catch (e) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      storesRaced++;   // someone linked it between the snapshot and now — leave theirs alone
    }
  }
}

console.log('');
console.log('--- applied ---');
console.log('contracts created :', contractsCreated);
console.log('stores pointed    :', storesPointed);
console.log('stores raced      :', storesRaced);
