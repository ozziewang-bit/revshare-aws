#!/usr/bin/env node
// Refresh contract machine counts from a Businessmen list, without doing a run.
//
// Step 2 of the run wizard does this automatically. This is the one-off form, for bringing the
// Merchant view up to date between runs. It deliberately reuses the SAME functions the run uses
// — rosterUnitCounts / unitsChanged from bulk-runs.mjs, resolveLabel from payout.mjs, and the
// frontend's own parseDeviceModel, lifted out of app.js rather than reimplemented — so the
// numbers it writes are the ones a run would write.
//
// Counts ROSTER ROWS per model, which is the unit the payout counts too: evalFlatPerMachine
// sums one per roster row, and a minimum guarantee is per station rather than per cabinet.
//
//   node infra/refresh-units-from-roster.mjs <businessmen-list.xlsx> [--apply]
//   REVSHARE_TABLE=RevsharePartnerSG node infra/refresh-units-from-roster.mjs <file> [--apply]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.AWS_REGION ||= 'ap-southeast-7';
const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!FILE) { console.error('usage: node infra/refresh-units-from-roster.mjs <businessmen-list.xlsx> [--apply]'); process.exit(1); }

const { listContracts, putContract } = await import('../lambda/revshare-api/code/db.mjs');
const { rosterUnitCounts, unitsChanged } = await import('../lambda/revshare-api/code/routes/bulk-runs.mjs');
const { indexContractsByName, resolveLabel } = await import('../lambda/revshare-api/code/payout.mjs');

// The roster parser that actually runs at upload time lives in the browser bundle. Extract it
// rather than copy it: a second copy is a second thing to drift.
const appSrc = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const parseDeviceModel = new Function(
  appSrc.match(/^const RS_MODELS = .*$/m)[0] + '\n'
  + appSrc.match(/^function parseDeviceModel\(deviceType\) \{[\s\S]*?\n\}$/m)[0]
  + '\nreturn parseDeviceModel;')();

const xl = readFileSync(new URL('../frontend/lib/xlsx.full.min.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, Date, Math, RegExp, JSON, Buffer, process, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer });
vm.runInContext(xl, ctx);
const wb = ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = ctx.XLSX.utils.sheet_to_json(sheet, { defval: null });

const str = v => String(v ?? '').trim();
// Same filter as parseMerchantList: Approved only, and a row must have a name.
const approved = rows.filter(r => str(r['Merchant Review State']).toLowerCase() === 'approved' && str(r['merchant name.']));
console.log(`${FILE.split('/').pop()}: ${rows.length} rows, ${approved.length} approved`);

const contracts = await listContracts();
const index = indexContractsByName(contracts);
const roster = [];
const unresolved = new Set();
for (const r of approved) {
  const label = str(r['Merchant label']);
  if (!label || label === '-') continue;
  const c = resolveLabel(index, label);
  if (!c) { unresolved.add(label); continue; }
  roster.push({ contractId: c.contractId, model: parseDeviceModel(r['device type.']) });
}
console.log(`resolved ${roster.length} roster rows to ${new Set(roster.map(r => r.contractId)).size} contracts`
  + (unresolved.size ? `; ${unresolved.size} label(s) matched no contract: ${[...unresolved].slice(0, 5).join(', ')}` : ''));

const changed = unitsChanged(contracts, rosterUnitCounts(roster));
const byId = new Map(contracts.map(c => [c.contractId, c]));
console.log(`\ncontracts whose counts differ: ${changed.length} of ${contracts.length}\n`);
const lost = [];
for (const c of changed) {
  const before = byId.get(c.contractId).units || {};
  const dropped = Object.keys(before).filter(m => !(m in c.units));
  if (dropped.length) lost.push({ name: c.merchantName, dropped: dropped.map(m => `${m}:${before[m]}`) });
  console.log(`  ${String(c.merchantName).slice(0, 30).padEnd(32)} ${JSON.stringify(before)} -> ${JSON.stringify(c.units)}`);
}
if (lost.length) {
  console.log(`\n⚠ ${lost.length} contract(s) LOSE a model entirely — right if the machine was removed, but also what a`);
  console.log(`  partial export looks like. This overwrites rather than merges, so check these before applying:`);
  for (const l of lost) console.log(`    ${l.name}: ${l.dropped.join(', ')}`);
}
if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
let n = 0;
for (const c of changed) { await putContract(c); n++; }
console.log(`\nupdated ${n} contracts.`);
