#!/usr/bin/env node
// Index the roster uploads already in S3, so a run can reach a file that has been replaced.
//
//   aws s3 ls s3://revshare-runs-812751451548-sea7/rosters/ --region ap-southeast-7 \
//     | REVSHARE_TABLE=RevsharePartner node infra/backfill-roster-history.mjs [--apply]
//
// WHY A BACKFILL. `putRoster` records one `CONFIG / ROSTER#HIST#<ulid>` row per upload from
// 2026-10-01 onward, and `listRosterHistory` reads those. Every upload BEFORE that sits in S3
// with no row, so a run cannot reach it — and those are exactly the files holding the merchants
// the current one has dropped (C5).
//
// KEYS COME IN ON STDIN, from `aws s3 ls`. The Lambda role deliberately has no `s3:ListBucket`
// (which is why the index exists), and `@aws-sdk/client-s3` is not resolvable from infra/ —
// adding a dependency to list what the CLI already prints would be the wrong trade.
//
// ADDITIVE AND IDEMPOTENT: one slim row per object, conditional, so re-running writes nothing.
// No roster document is read, moved or changed, and the LATEST pointer is not touched.
const APPLY = process.argv.includes('--apply');
process.env.AWS_REGION ||= 'ap-southeast-7';
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';

const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand } = await import('@aws-sdk/lib-dynamodb');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const text = await new Promise((res) => {
  let b = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { b += c; });
  process.stdin.on('end', () => res(b));
});
// `aws s3 ls` prints: 2026-10-01 11:05:47  1056615 01M3TT7HXR8H21THA9ZBYZWZK6.json
const files = text.split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length === 4)
  .map(([d, t, size, name]) => ({ key: 'rosters/' + name, at: `${d}T${t}Z`, size: Number(size) }))
  .filter(f => f.key.endsWith('.json'));

const latest = await ddb.send(new GetCommand({
  TableName: TABLE, Key: { pk: 'CONFIG', sk: 'ROSTER#LATEST' } }));
const latestKey = latest.Item?.s3Key || null;

console.log(`table ${TABLE} · ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  roster files read from stdin : ${files.length}`);
console.log(`  current file                 : ${latestKey || '(none)'}\n`);
if (!files.length) {
  console.error('No roster keys on stdin. Pipe `aws s3 ls .../rosters/` into this.');
  process.exit(1);
}

let made = 0, already = 0;
for (const f of files.sort((a, b) => a.key.localeCompare(b.key))) {
  const sk = `ROSTER#HIST#${f.key.replace('rosters/', '').replace('.json', '')}`;
  const have = await ddb.send(new GetCommand({ TableName: TABLE, Key: { pk: 'CONFIG', sk } }));
  if (have.Item) { already++; continue; }
  console.log(`  + ${f.key}  ${f.at}  ${f.size} bytes${f.key === latestKey ? '   (the current file)' : ''}`);
  made++;
  if (!APPLY) continue;
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'CONFIG', sk, s3Key: f.key, at: f.at, backfilled: true },
    ConditionExpression: 'attribute_not_exists(sk)',
  }));
}
console.log(`\n${APPLY ? 'wrote' : 'would write'} ${made} row(s); ${already} already indexed.`);
if (!APPLY) console.log('DRY RUN — nothing written. Re-run with --apply.');
