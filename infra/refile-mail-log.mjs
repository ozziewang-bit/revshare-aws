#!/usr/bin/env node
// Re-file mail-log rows that landed under `MAILLOG#mail-log` onto their actual run.
//
//   REVSHARE_TABLE=RevsharePartner AWS_REGION=ap-southeast-7 node infra/refile-mail-log.mjs
//   …plus --apply                                                to write
//
// WHY THEY ARE THERE: index.mjs read the run id out of path segment 2 of
// /bulk-runs/<runId>/mail-log. The split drops the empty leading segment, so segment 2 is the
// literal word "mail-log" — every send since the mail log was built was filed under one key.
// Fixed 2026-09-30; these rows predate the fix and would otherwise become unreachable.
//
// ADDITIVE ONLY, and that is the whole design:
//   • The original rows are NEVER deleted or modified. They simply stop being read.
//   • The copy is a conditional put, so re-running writes nothing and cannot duplicate a send.
//   • A row is matched to a run by its own `period` field. A row whose period matches no run is
//     REPORTED and left alone — guessing which month someone was mailed is not acceptable.
const APPLY = process.argv.includes('--apply');
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';
const REGION = process.env.AWS_REGION || 'ap-southeast-7';

const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand } = await import('@aws-sdk/lib-dynamodb');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const queryAll = async (pk) => {
  const out = []; let Start;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey: Start }));
    out.push(...(r.Items || [])); Start = r.LastEvaluatedKey;
  } while (Start);
  return out;
};

const stray = await queryAll('MAILLOG#mail-log');
const runs = await queryAll('BULKRUN');
// Both spellings are in use across the codebase: `2026_09` on a log row, `2026-09` elsewhere.
const tag = (d) => String(d || '').slice(0, 7).replace('-', '_');
const byPeriod = new Map(runs.map(r => [tag(r.periodStart), r]));

console.log(`table ${TABLE} · ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  misfiled rows : ${stray.length}`);
console.log(`  runs          : ${runs.length} (${[...byPeriod.keys()].sort().join(', ')})\n`);

const plan = [], orphans = [];
for (const row of stray) {
  const run = byPeriod.get(String(row.period || ''));
  if (!run) { orphans.push(row); continue; }
  plan.push({ row, runId: run.runId });
  console.log(`  ${row.sentAt}  period ${row.period} → run ${run.runId}`);
  console.log(`      to ${String(row.to || '').slice(0, 70)}`);
}
if (orphans.length) {
  console.log(`\n  ⚠ ${orphans.length} row(s) whose period matches no run — LEFT ALONE, decide by hand:`);
  for (const o of orphans) console.log(`      ${o.sentAt}  period ${JSON.stringify(o.period)}  to ${o.to}`);
}

if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply.`); process.exit(0); }

let made = 0, skipped = 0;
for (const { row, runId } of plan) {
  try {
    await ddb.send(new PutCommand({ TableName: TABLE,
      Item: { ...row, pk: `MAILLOG#${runId}`, runId, refiledFrom: 'MAILLOG#mail-log' },
      ConditionExpression: 'attribute_not_exists(pk)' }));
    made++;
  } catch (e) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
    skipped++;                                   // already re-filed by an earlier run
  }
}
console.log(`\ncopied ${made}, already present ${skipped}. The ${stray.length} originals are untouched.`);
