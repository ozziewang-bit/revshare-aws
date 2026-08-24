#!/usr/bin/env node
// Recompute an existing bulk run from its STORED INPUTS — no browser token, no re-upload.
//
// Why this exists: a run's S3 payload holds only aggregates (per-merchant rentals/revenue,
// skipped, unmatched names). When the order-matching logic changed on 2026-08-24 there was no
// way to see what the July run would look like under it, because the roster and order report
// existed only in the user's Downloads folder and a browser tab. `putBulkRun` now writes a
// second object, runs/<runId>.inputs.json; this script reads it back and re-runs the exact
// same code path the HTTP route uses (computeBulkRun), so a re-run cannot drift from a real one.
//
// Runs older than 2026-08-24 have no stored inputs and cannot be recomputed — that is a fact
// about the data, not a bug here.
//
//   node infra/rerun-bulk-run.mjs <runId>                  # dry run: diff only, writes nothing
//   node infra/rerun-bulk-run.mjs <runId> --apply          # create a NEW run from those inputs
//   node infra/rerun-bulk-run.mjs <runId> --apply --replace  # ...and delete the original
//
// A re-run always creates a new run rather than mutating the old one: a run is a frozen
// snapshot with its own ruleSnapshots (CLAUDE.md §5), and rewriting one in place would silently
// change a historical period.
// db.mjs reads AWS_REGION at import time and falls back to the Lambda-era ap-northeast-1,
// which is the wrong region for this table — set it before the module loads. Static imports
// are hoisted above assignments, so these have to be dynamic.
process.env.AWS_REGION ||= 'ap-southeast-7';
const { getBulkRun, getBulkRunInputs, putBulkRun, deleteBulkRun, ulid } = await import('../lambda/revshare-api/code/db.mjs');
const { computeBulkRun } = await import('../lambda/revshare-api/code/routes/bulk-runs.mjs');

const [runId, ...flags] = process.argv.slice(2);
const APPLY = flags.includes('--apply');
const REPLACE = flags.includes('--replace');
if (!runId) { console.error('usage: node infra/rerun-bulk-run.mjs <runId> [--apply] [--replace]'); process.exit(1); }

const n = v => Number(v || 0);
const f2 = v => n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const delta = (a, b) => { const d = n(b) - n(a); return d === 0 ? '   =' : (d > 0 ? `+${f2(d)}` : f2(d)); };

const old = await getBulkRun(runId);
if (!old) { console.error(`run ${runId} not found`); process.exit(1); }
const inputs = await getBulkRunInputs(runId);
if (!inputs) {
  console.error(`run ${runId} has no stored inputs — it predates input persistence (2026-08-24).`);
  console.error('It can only be reproduced by re-uploading the original files through the wizard.');
  process.exit(1);
}
console.log(`run ${runId}  period ${old.periodStart}..${old.periodEnd}`);
console.log(`stored inputs: ${inputs.merchants?.length ?? 0} roster rows, ${inputs.orders?.length ?? 0} orders, ${inputs.machines?.length ?? 0} machines\n`);

const fresh = await computeBulkRun({
  // A dry run must not touch the registry — applyMerchantRoster writes store rows and
  // contract stubs unless told otherwise.
  persist: APPLY,
  runId: APPLY ? ulid() : 'DRYRUN',
  merchants: inputs.merchants, orders: inputs.orders, machines: inputs.machines,
  periodStart: inputs.periodStart ?? old.periodStart, periodEnd: inputs.periodEnd ?? old.periodEnd,
});

const ROWS = ['orderCount','rosterCount','paidBrandCount','rosterBrandCount','skippedCount','skippedRevenue','unmatchedCount','unmatchedOrderCount','unmatchedRevenue','totalOrderRevenue','totalPayout'];
console.log('field                      before            after           delta');
for (const k of ROWS) console.log(`  ${k.padEnd(22)} ${f2(old[k]).padStart(14)} ${f2(fresh[k]).padStart(16)} ${delta(old[k], fresh[k]).padStart(14)}`);

const byId = r => new Map((r.results || []).map(x => [x.contractId, x]));
const [a, b] = [byId(old), byId(fresh)];
const changed = [...b.entries()].filter(([id, x]) => n(a.get(id)?.payout) !== n(x.payout));
console.log(`\nper-merchant payout changes: ${changed.length}`);
for (const [id, x] of changed.sort((p, q) => Math.abs(n(q[1].payout) - n(a.get(q[0])?.payout)) - Math.abs(n(p[1].payout) - n(a.get(p[0])?.payout))).slice(0, 25))
  console.log(`  ${x.merchantName.padEnd(34)} ${f2(a.get(id)?.payout).padStart(12)} -> ${f2(x.payout).padStart(12)}  (${delta(a.get(id)?.payout, x.payout)})`);
for (const id of [...a.keys()].filter(k => !b.has(k))) console.log(`  DROPPED: ${a.get(id).merchantName}`);
for (const id of [...b.keys()].filter(k => !a.has(k))) console.log(`  NEW:     ${b.get(id).merchantName}`);

if (fresh.matchedByMachine?.length) {
  console.log('\nrecovered by machine number:');
  for (const m of fresh.matchedByMachine) console.log(`  ${f2(m.revenue).padStart(12)} / ${m.orders} orders  ${JSON.stringify(m.orderName)} -> ${JSON.stringify(m.rosterName)}`);
}
const recon = n(fresh.results?.reduce((s, r) => s + n(r.revenue), 0)) + n(fresh.skippedRevenue) + n(fresh.unmatchedRevenue);
console.log(`\nreconciliation: paid+skipped+unmatched = ${f2(recon)} vs order total ${f2(fresh.totalOrderRevenue)} — ${Math.abs(recon - n(fresh.totalOrderRevenue)) < 0.01 ? 'OK' : 'MISMATCH'}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to create the new run.'); process.exit(0); }
await putBulkRun(fresh, inputs);
console.log(`\ncreated run ${fresh.runId}`);
if (REPLACE) { await deleteBulkRun(runId); console.log(`deleted original run ${runId}`); }
