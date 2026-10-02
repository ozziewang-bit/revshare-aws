#!/usr/bin/env node
// Re-point a bulk run's `inputsKey` at the inputs object that is still sitting in S3.
//
//   REVSHARE_TABLE=RevsharePartner AWS_REGION=ap-southeast-7 node infra/repair-run-inputs-key.mjs
//   …same, plus --apply                                                       to actually write
//
// WHY THIS EXISTS (2026-10-02). `putBulkRun` rebuilds the slim DynamoDB row from scratch, and
// `inputsKey` — the only pointer to a run's stored orders — was set to null whenever it was
// called without inputs. Archiving a run does exactly that, so locking a month orphaned its
// order detail: the 5 MB object stayed in S3 and nothing could find it again, and the statement
// download for that month went back to printing "the individual rentals were not kept for this
// run". July and August were both hit. The cause is fixed in db.mjs; this repairs the rows.
//
// ADDITIVE AND NARROW, by construction:
//   • Only ever writes `inputsKey`, and only on a row where it is currently ABSENT OR NULL.
//     A row that already points somewhere is left untouched, printed, and counted.
//   • Writes nothing unless the object is actually THERE — checked with a HeadObject first, so
//     a run that genuinely never stored inputs keeps its honest null rather than gaining a
//     pointer to nothing.
//   • Touches no other attribute, no S3 object, and no payout.
// Dry run by default. Idempotent: a second run repairs nothing.

const APPLY = process.argv.includes('--apply');
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';
const REGION = process.env.AWS_REGION || 'ap-southeast-7';
const BUCKET = process.env.REVSHARE_RUNS_BUCKET || 'revshare-runs-812751451548-sea7';

// Set before db.mjs is imported — it reads these at module scope, and `import` is hoisted.
process.env.AWS_REGION = REGION;
process.env.REVSHARE_TABLE = TABLE;

const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

const rows = [];
let ExclusiveStartKey;
do {
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'BULKRUN' },
    ExclusiveStartKey,
  }));
  rows.push(...(r.Items || []));
  ExclusiveStartKey = r.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(`table ${TABLE} · region ${REGION} · ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  bulk runs: ${rows.length}\n`);

const plan = [];
for (const r of rows.sort((a, b) => String(b.periodStart).localeCompare(String(a.periodStart)))) {
  const period = String(r.periodStart || '').slice(0, 7);
  const key = `runs/${r.runId}.inputs.json`;
  if (r.inputsKey) {
    console.log(`  ${period}  ${r.runId}  already points at ${r.inputsKey} — left alone`);
    continue;
  }
  let size = null;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    size = head.ContentLength;
  } catch {
    console.log(`  ${period}  ${r.runId}  no inputs object in S3 — genuinely an old run, left null`);
    continue;
  }
  console.log(`  ${period}  ${r.runId}  ORPHANED → ${key} (${(size / 1048576).toFixed(1)} MB)`
    + `${r.archived ? ' · locked' : ''}`);
  plan.push({ runId: r.runId, key, period });
}

console.log(`\nplan: re-point ${plan.length} run(s)`);
if (!plan.length) { console.log('nothing to repair.'); process.exit(0); }
if (!APPLY) { console.log('DRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

let done = 0;
for (const p of plan) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: 'BULKRUN', sk: `BULKRUN#${p.runId}` },
    // ONE attribute, and only while it is still absent or null — so a concurrent proper write
    // (a recompute, say) is never overwritten by this.
    UpdateExpression: 'SET inputsKey = :k',
    ConditionExpression: 'attribute_not_exists(inputsKey) OR inputsKey = :null',
    ExpressionAttributeValues: { ':k': p.key, ':null': null },
  })).then(() => { done++; }).catch(err => {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
    console.log(`  ${p.period} was changed by something else — skipped`);
  });
}
console.log(`\nre-pointed ${done} run(s). No other attribute, object or payout touched.`);
