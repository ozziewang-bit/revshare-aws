#!/usr/bin/env node
// Compare the live CONTRACT rows against a snapshot, and put the snapshot back.
//
//   AWS_REGION=ap-southeast-7 REVSHARE_TABLE=RevsharePartner \
//     node infra/restore-contracts.mjs ~/revshare-backups/2026-09-21/th-contracts.json
//
// DRY RUN BY DEFAULT — it prints what differs and writes nothing. Add --apply to restore.
//
// The snapshot is raw DynamoDB JSON, exactly as `aws dynamodb query` emits it, so it can be
// taken with nothing but the CLI and read back here without a schema. Take one with:
//   aws dynamodb query --table-name <T> --region <R> \
//     --key-condition-expression "pk = :p" \
//     --expression-attribute-values '{":p":{"S":"CONTRACT"}}' > snapshot.json
//
// WHAT IT WILL NOT DO: it never deletes. A merchant created after the snapshot is REPORTED and
// left alone — restoring a list is putting back what you had, not destroying what you have
// since decided. If you want such a row gone, delete it deliberately from the app.
import { readFileSync } from 'node:fs';

const [, , file, ...flags] = process.argv;
const apply = flags.includes('--apply');
if (!file) {
  console.error('usage: node infra/restore-contracts.mjs <snapshot.json> [--apply]');
  process.exit(2);
}

const REGION = process.env.AWS_REGION || 'ap-southeast-7';
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';

// Region has to be set before db clients are constructed, hence the dynamic import — the same
// reason infra/rerun-bulk-run.mjs does it.
const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Raw DynamoDB JSON -> plain values. Written out rather than pulling in util-dynamodb, so the
// script keeps working with only the two SDK packages the repo root already declares.
function plain(v) {
  if (!v || typeof v !== 'object') return v;
  const [t, val] = Object.entries(v)[0];
  if (t === 'S' || t === 'BOOL') return val;
  if (t === 'N') return Number(val);
  if (t === 'NULL') return null;
  if (t === 'L') return val.map(plain);
  if (t === 'M') return Object.fromEntries(Object.entries(val).map(([k, x]) => [k, plain(x)]));
  return val;
}

// DynamoDB does not preserve map key order, so a plain JSON.stringify reports phantom changes on
// every run — the same trap §1h hit with `units` and §1m with contract comparisons.
const stable = (v) => JSON.stringify(
  v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x))
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
    : x);

const snapshot = JSON.parse(readFileSync(file, 'utf8'));
if (snapshot.LastEvaluatedKey) {
  console.error('REFUSING: this snapshot is TRUNCATED (it carries a LastEvaluatedKey).');
  console.error('Restoring from it would silently drop every row past the first page.');
  process.exit(1);
}
const snap = new Map((snapshot.Items || []).map(i => {
  const row = Object.fromEntries(Object.entries(i).map(([k, v]) => [k, plain(v)]));
  return [row.contractId, row];
}));

const live = new Map();
let key;
do {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'CONTRACT' },
    ExclusiveStartKey: key,
  }));
  for (const row of out.Items || []) live.set(row.contractId, row);
  key = out.LastEvaluatedKey;
} while (key);

const changed = [], gone = [], added = [];
for (const [id, row] of snap) {
  const now = live.get(id);
  if (!now) { gone.push(row); continue; }
  if (stable(now) !== stable(row)) {
    const fields = [...new Set([...Object.keys(row), ...Object.keys(now)])]
      .filter(f => stable(row[f]) !== stable(now[f]));
    changed.push({ row, now, fields });
  }
}
for (const [id, row] of live) if (!snap.has(id)) added.push(row);

console.log(`Snapshot: ${file}`);
console.log(`  ${snap.size} rows in the snapshot · ${live.size} live in ${TABLE} (${REGION})\n`);
console.log(`  ${changed.length} changed since the snapshot`);
console.log(`  ${gone.length} in the snapshot but MISSING live (deleted since)`);
console.log(`  ${added.length} live but not in the snapshot (created since — left alone)\n`);

for (const c of changed.slice(0, 40)) {
  console.log(`  ~ ${c.row.merchantName}`);
  for (const f of c.fields.slice(0, 8)) {
    const was = stable(c.row[f]), is = stable(c.now[f]);
    console.log(`      ${f}: ${is ?? 'absent'}  ->  ${was ?? 'absent'}  (restore direction)`);
  }
}
if (changed.length > 40) console.log(`  … and ${changed.length - 40} more`);
for (const g of gone.slice(0, 20)) console.log(`  + ${g.merchantName} (would be recreated)`);
for (const a of added.slice(0, 20)) console.log(`  ! ${a.merchantName} (created since — NOT touched)`);

const writes = [...changed.map(c => c.row), ...gone];
if (!writes.length) {
  console.log('\nNothing to restore — live matches the snapshot.');
  process.exit(0);
}
if (!apply) {
  console.log(`\nDRY RUN. ${writes.length} row(s) would be written back. Re-run with --apply.`);
  process.exit(0);
}
for (let i = 0; i < writes.length; i += 10) {
  await Promise.all(writes.slice(i, i + 10).map(Item =>
    ddb.send(new PutCommand({ TableName: TABLE, Item }))));
  process.stdout.write(`\r  restored ${Math.min(i + 10, writes.length)}/${writes.length}`);
}
console.log(`\nRestored ${writes.length} row(s) from the snapshot. Nothing was deleted.`);
