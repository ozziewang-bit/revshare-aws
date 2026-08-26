#!/usr/bin/env node
// Fill the contract fields the SG Rev Share Record CAN supply, on contracts already imported
// by import-sg-revshare.mjs: merchantType, per-model unit counts, installedUnits.
//
// Everything else in the Merchant view grid — counter party, contacts, contract dates, notice
// period, auto-renewal, contract link — has NO source in that workbook and stays empty. Blank
// is the honest answer there; a guessed contract date is worse than no date.
//
// Never touches rule / aggregationMode / noPayout / currency: terms are set in the app.
//   node infra/backfill-sg-contract-fields.mjs <workbook.xlsx> [--apply]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.AWS_REGION ||= 'ap-southeast-7';
process.env.REVSHARE_TABLE ||= 'RevsharePartnerSG';

const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!FILE) { console.error('usage: node infra/backfill-sg-contract-fields.mjs <workbook.xlsx> [--apply]'); process.exit(1); }

const { listContracts, putContract } = await import('../lambda/revshare-api/code/db.mjs');

const xl = readFileSync(new URL('../frontend/lib/xlsx.full.min.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, Date, Math, RegExp, JSON, Buffer, process, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer });
vm.runInContext(xl, ctx);
const wb = ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' });
const aoa = n => ctx.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, blankrows: false });
const str = v => String(v ?? '').trim();
const norm = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const BRAND_TYPES = new Set(['7 Eleven','Cheers','Maxim','RE&S Group','Sentosa','Yunomori',
  'Frasers Retail (Shopping Mall)','Frasers Commercial','Gardens By The Bay (GBB)',
  'Tan Tock Seng Hospital','Four Points Sheraton Hotel']);
const kaNames = aoa('Key Account Payment').filter(r => typeof r[0] === 'number' && str(r[1])).map(r => str(r[1]));
const kaByNorm = new Map(kaNames.map(n => [norm(n), n]));

const cp = aoa('Copy').slice(1).filter(r => str(r[1]));
const typeById = new Map(cp.map(r => [str(r[0]).replace(/\s/g, ''), str(r[3])]));
const stores = aoa('Small Merchants Lists').slice(1).filter(r => str(r[1]));

// "Advertising Player-S10-A" -> S10-A ; "LL20" -> LL20 ; a cell may list two, comma separated.
const modelsOf = cell => str(cell).replace(/Advertising Player-/gi, '')
  .split(',').map(x => x.trim()).filter(Boolean);

const agg = new Map();     // contract name -> { type, units: {model: n} }
for (const r of stores) {
  const t = typeById.get(str(r[0]).replace(/\s/g, '')) || '';
  const name = BRAND_TYPES.has(t) ? (kaByNorm.get(norm(t)) || t) : str(r[1]);
  const e = agg.get(name) || { type: t, units: {} };
  if (!e.type && t) e.type = t;
  for (const m of modelsOf(r[3])) e.units[m] = (e.units[m] || 0) + 1;
  agg.set(name, e);
}

const contracts = await listContracts();
const byName = new Map(contracts.map(c => [norm(c.merchantName), c]));
const plan = [];
for (const [name, e] of agg) {
  const c = byName.get(norm(name));
  if (!c) continue;
  const total = Object.values(e.units).reduce((a, b) => a + b, 0);
  const changes = {};
  if (e.type && c.merchantType !== e.type) changes.merchantType = e.type;
  if (JSON.stringify(c.units || {}) !== JSON.stringify(e.units)) changes.units = e.units;
  if ((c.installedUnits ?? null) !== (total || null)) changes.installedUnits = total || null;
  if (Object.keys(changes).length) plan.push({ c, changes, total });
}

console.log(`contracts in SG: ${contracts.length}   with store data in the workbook: ${agg.size}`);
console.log(`would update: ${plan.length}\n`);
const models = {};
for (const [, e] of agg) for (const [m, n] of Object.entries(e.units)) models[m] = (models[m] || 0) + n;
console.log('machine counts by model across the whole file:');
for (const [m, n] of Object.entries(models).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${m}`);
console.log('\nlargest updates:');
for (const p of plan.sort((a, b) => b.total - a.total).slice(0, 10))
  console.log(`  ${p.c.merchantName.padEnd(32)} type=${(p.changes.merchantType ?? p.c.merchantType ?? '-').padEnd(22)} units=${JSON.stringify(p.changes.units ?? p.c.units)} total=${p.total}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
let n = 0;
for (const p of plan) { await putContract({ ...p.c, ...p.changes }); n++; }
console.log(`\nupdated ${n} contracts.`);
