#!/usr/bin/env node
// Add the `excluded` list (non-Approved roster rows) to a run's stored inputs, so a recompute
// can label the unmatched stores the merchant list actually knows about.
//
// Runs created before 2026-08-27 have no `excluded`: the browser discarded non-Approved rows
// before the backend ever saw them. This reads them out of a Businessmen list and merges them
// in. It changes NO payout figure — `excluded` is only ever used to annotate unmatched rows.
//
//   node infra/backfill-run-excluded.mjs <runId> <businessmen-list.xlsx> [--apply]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.AWS_REGION ||= 'ap-southeast-7';
const [runId, FILE] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!runId || !FILE) { console.error('usage: node infra/backfill-run-excluded.mjs <runId> <roster.xlsx> [--apply]'); process.exit(1); }

const db = await import('../lambda/revshare-api/code/db.mjs');
const { getBulkRun, getBulkRunInputs, putBulkRun } = db;

const xl = readFileSync(new URL('../frontend/lib/xlsx.full.min.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, Date, Math, RegExp, JSON, Buffer, process, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer });
vm.runInContext(xl, ctx);
const rows = ctx.XLSX.utils.sheet_to_json(ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' }).Sheets['Businessmen list']
  || ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' }).Sheets[Object.keys(ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' }).Sheets)[0]], { defval: null });

const str = v => String(v ?? '').trim();
const excluded = rows
  .filter(r => str(r['merchant name.']) && str(r['Merchant Review State']).toLowerCase() !== 'approved')
  .map(r => ({ name: str(r['merchant name.']), label: str(r['Merchant label']), reviewState: str(r['Merchant Review State']) || 'Not approved' }));

const run = await getBulkRun(runId);
if (!run) { console.error(`run ${runId} not found`); process.exit(1); }
const inputs = await getBulkRunInputs(runId);
if (!inputs) { console.error(`run ${runId} has no stored inputs; it cannot be recomputed at all.`); process.exit(1); }

// Which of the run's unmatched names would now be explained?
const byName = new Map(excluded.map(e => [e.name.toLowerCase().trim(), e]));
const hits = (run.unmatched || []).filter(n => byName.has(String(n).toLowerCase().trim()));
console.log(`run ${runId}  period ${run.periodStart}..${run.periodEnd}`);
console.log(`roster supplies ${excluded.length} non-Approved rows`);
console.log(`stored inputs currently hold ${(inputs.excluded || []).length}`);
console.log(`\nunmatched names this would explain: ${hits.length} of ${(run.unmatched || []).length}`);
for (const n of hits) { const e = byName.get(n.toLowerCase().trim()); console.log(`   [${e.reviewState}] ${n}  -> would be paid under "${e.label || '—'}"`); }

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply to store the list.'); process.exit(0); }
await putBulkRun(run, { ...inputs, excluded });
console.log(`\nstored ${excluded.length} excluded rows with run ${runId}. Recompute it to apply the labels:`);
console.log(`   node infra/rerun-bulk-run.mjs ${runId}            # dry run first`);
