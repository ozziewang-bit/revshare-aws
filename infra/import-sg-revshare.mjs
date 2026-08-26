#!/usr/bin/env node
// Load Singapore's "Inforich ChargeSPOT Rev Share Record" into RevsharePartnerSG as CONTRACT
// rows with payout terms. Dry run by default; --apply writes.
//
// This workbook is NOT shaped like Thailand's All_Merchant sheet — it is a terms record, so
// the TH importer (which reads by column position) cannot read it. Three sheets:
//   Key Account Payment  — brand-level terms: RS% and/or a rental fee per machine model
//   Small Merchants Lists — one row per store, terms as free text in "RS% or Rental Fee$"
//   Copy                 — the same stores with `merchant type.`, the only brand-ish column
//
// GROUPING. A CONTRACT is the payout entity, so stores that share terms must share one. A
// store joins a brand contract when its `merchant type.` is a BRAND (7 Eleven, Cheers, Maxim…)
// rather than a category (F&B, Retail, Health Care…). Everything else becomes its own contract
// carrying its own parsed terms. That split is a judgement call about this data and is printed
// in full by the dry run so it can be checked rather than trusted.
//
// TERMS. Parsed from the free-text column, whose shapes are finite:
//   "S$65+25%revenue share" -> flat_per_machine(ALL,65) + percent(ALL,25)
//   "RS:20%" / "RS: 10%" / "15%revenue share" -> percent(ALL,20)
//   "S$100" -> flat_per_machine(ALL,100)
//   "RS:10%+Rental Fee:SGD150" -> both
//   "-" -> no terms; imported as noPayout so it can never be paid by accident AND never
//          blocks a run's "needs terms" step. 562 rows are in this state.
//   anything else (one-off payments, multi-year escalators) -> noPayout + the raw text in
//          notes, because the rule model has no way to express them. Never guessed at.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.AWS_REGION ||= 'ap-southeast-7';
process.env.REVSHARE_TABLE ||= 'RevsharePartnerSG';
process.env.REVSHARE_CURRENCY ||= 'SGD';

const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!FILE) { console.error('usage: node infra/import-sg-revshare.mjs <workbook.xlsx> [--apply]'); process.exit(1); }

const { listContracts, putContract, ulid } = await import('../lambda/revshare-api/code/db.mjs');

const xl = readFileSync(new URL('../frontend/lib/xlsx.full.min.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, Date, Math, RegExp, JSON, Buffer, process, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer });
vm.runInContext(xl, ctx);
const wb = ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' });
const aoa = n => ctx.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, blankrows: false });

const str = v => String(v ?? '').trim();
const money = v => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

// `merchant type.` values that name a BRAND (stores group under one contract) rather than a
// category. Anything not listed here leaves the store standing alone.
const BRAND_TYPES = new Set(['7 Eleven','Cheers','Maxim','RE&S Group','Sentosa','Yunomori',
  'Frasers Retail (Shopping Mall)','Frasers Commercial','Gardens By The Bay (GBB)',
  'Tan Tock Seng Hospital','Four Points Sheraton Hotel']);

const pct = p => ({ type: 'percent', rows: [{ model: 'ALL', percent: p }], _t: 'gp' });
const perMachine = rows => ({ type: 'flat_per_machine', rows, _t: 'placement' });
const combine = parts => parts.length === 0 ? null
  : parts.length === 1 ? { ...parts[0], _method: 'default' }
  : { type: 'sum', children: parts, _method: 'hybrid' };

// Free-text terms -> a rule, or null with a reason.
export function parseTerms(text) {
  const t = str(text);
  if (!t || t === '-') return { rule: null, reason: 'no terms in the sheet' };
  const parts = [];
  const rs = t.match(/RS\s*:?\s*([\d.]+)\s*%/i) || t.match(/([\d.]+)\s*%\s*revenue\s*share/i);
  const fee = t.match(/S?\$\s*([\d.]+)/i) || t.match(/Rental\s*Fee\s*:?\s*SGD\s*([\d.]+)/i);
  if (/one\s*time/i.test(t)) return { rule: null, reason: 'one-off payment, not a recurring term' };
  if (/\d(st|nd|rd|th)\s*year/i.test(t)) return { rule: null, reason: 'multi-year escalator — the rule model has no contract-year concept' };
  if (fee && money(fee[1])) parts.push(perMachine([{ model: 'ALL', amount: money(fee[1]) }]));
  if (rs && Number(rs[1]) > 0) parts.push(pct(Number(rs[1])));
  if (!parts.length) return { rule: null, reason: `unrecognised terms: ${JSON.stringify(t)}` };
  return { rule: combine(parts), reason: null };
}

// ── Key Account Payment: brand-level terms ────────────────────────────────
// Row 3 headers under "Rental Fee", with the sheet's "S10" read as the S10-A cabinet (decision
// 2026-08-26). Without that, Cheers' S10=45 would pay nothing: its stores run S10-A, and
// flat_per_machine matches on the exact model code. No SG store runs a plain "S10".
const KA_MODELS = ['S5', 'S10-A', 'LL20', 'T35', 'LL40'];
const kaRows = aoa('Key Account Payment').filter(r => typeof r[0] === 'number' && str(r[1]));
const keyAccounts = kaRows.map(r => {
  const parts = [];
  const rentalRows = KA_MODELS.map((model, i) => ({ model, amount: money(r[3 + i]) })).filter(x => x.amount);
  if (rentalRows.length) parts.push(perMachine(rentalRows));
  const rsPct = r[2] != null ? Number(r[2]) * 100 : null;     // stored as a decimal: 0.25 = 25%
  if (rsPct > 0) parts.push(pct(rsPct));
  return { name: str(r[1]), rule: combine(parts), rentalRows,
           note: [str(r[8]), str(r[9]), str(r[11])].filter(Boolean).join(' · ') };
});

// ── Stores ────────────────────────────────────────────────────────────────
const cp = aoa('Copy').slice(1).filter(r => str(r[1]));
const typeById = new Map(cp.map(r => [str(r[0]).replace(/\s/g, ''), str(r[3])]));
const stores = aoa('Small Merchants Lists').slice(1).filter(r => str(r[1])).map(r => ({
  id: str(r[0]).replace(/\s/g, ''), name: str(r[1]), device: str(r[3]), terms: str(r[10]),
}));

const norm = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const kaByNorm = new Map(keyAccounts.map(k => [norm(k.name), k]));

const contracts = new Map();     // name -> { name, rule, note, stores[], reason }
const put = (name, rule, note, reason) => {
  if (!contracts.has(name)) contracts.set(name, { name, rule, note, reason, stores: 0 });
  const c = contracts.get(name);
  if (!c.rule && rule) { c.rule = rule; c.reason = reason; }
  return c;
};
for (const k of keyAccounts) put(k.name, k.rule, k.note, k.rule ? null : 'key account row carries no rental fee or RS%');

for (const s of stores) {
  const type = typeById.get(s.id) || '';
  if (BRAND_TYPES.has(type)) {
    // Prefer the key account of the same name, so brand terms win over a single store's text.
    const ka = kaByNorm.get(norm(type));
    put(ka ? ka.name : type, ka ? ka.rule : parseTerms(s.terms).rule, ka?.note || '', null).stores++;
  } else {
    const { rule, reason } = parseTerms(s.terms);
    put(s.name, rule, '', reason).stores++;
  }
}

// A rental fee keyed to a model none of the brand's stores run silently pays 0 — the same
// class of failure as a `percent ALL 0%` rule. Detect it and say so loudly; never patch it
// by inference.
const devicesByBrand = {};
for (const s2 of stores) {
  const type = typeById.get(s2.id) || '';
  const brand = BRAND_TYPES.has(type) ? (kaByNorm.get(norm(type))?.name || type) : s2.name;
  (devicesByBrand[brand] = devicesByBrand[brand] || new Set());
  for (const d of s2.device.replace(/Advertising Player-/gi, '').split(',').map(x => x.trim()).filter(Boolean))
    devicesByBrand[brand].add(d);
}
const gaps = [];
for (const k of keyAccounts) {
  if (!k.rentalRows?.length) continue;
  const covered = new Set(k.rentalRows.map(r => r.model));
  const run = [...(devicesByBrand[k.name] || [])];
  const uncovered = run.filter(d => !covered.has(d));
  if (uncovered.length) gaps.push({ name: k.name, covered: [...covered], uncovered, stores: (contracts.get(k.name)?.stores ?? 0) });
}
for (const g of gaps) {
  const c = contracts.get(g.name);
  if (c) c.note = [c.note, `⚠ rental fee covers ${g.covered.join('/')} but stores also run ${g.uncovered.join('/')} — those machines are paid 0 until this is set in Merchant view`].filter(Boolean).join(' | ');
}

const list = [...contracts.values()];
const paying = list.filter(c => c.rule);
const noPay = list.filter(c => !c.rule);
console.log(`workbook: ${keyAccounts.length} key accounts, ${stores.length} store rows`);
console.log(`\nplanned contracts: ${list.length}`);
console.log(`  with terms      : ${paying.length}`);
console.log(`  no terms (noPayout): ${noPay.length}`);
console.log(`\nbrand contracts (stores grouped under one payout entity):`);
for (const c of list.filter(c => c.stores > 1).sort((a, b) => b.stores - a.stores))
  console.log(`  ${String(c.stores).padStart(4)} stores  ${c.name.padEnd(34)} ${c.rule ? JSON.stringify(c.rule).slice(0, 78) : '(no terms)'}`);
console.log(`\nreasons a contract has no terms:`);
const why = {};
for (const c of noPay) { const k = c.reason || 'unknown'; why[k] = (why[k] || 0) + 1; }
for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
if (gaps.length) {
  console.log(`\n⚠ RENTAL-FEE GAPS — these brands would pay 0 on some of their machines:`);
  for (const g of gaps)
    console.log(`  ${g.name.padEnd(30)} fee on [${g.covered.join(', ')}]  but stores also run [${g.uncovered.join(', ')}]  (${g.stores} stores)`);
  console.log(`  Each is imported with the sheet's value and a note on the contract, not silently patched.`);
}

console.log(`\nsample of standalone merchants with parsed terms:`);
for (const c of paying.filter(c => c.stores === 1).slice(0, 8))
  console.log(`  ${c.name.padEnd(40)} ${JSON.stringify(c.rule).slice(0, 90)}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }

const existing = new Map((await listContracts()).map(c => [norm(c.merchantName), c]));
let created = 0, skipped = 0;
for (const c of list) {
  if (existing.has(norm(c.name))) { skipped++; continue; }
  await putContract({
    contractId: ulid(), merchantName: c.name, partnerId: null, units: {},
    notes: [c.note, c.reason ? `import: ${c.reason}` : ''].filter(Boolean).join(' | '),
    rule: c.rule, aggregationMode: 'per_store', noPayout: !c.rule, currency: 'SGD',
  });
  created++;
}
console.log(`\ncreated ${created} contracts, skipped ${skipped} already present.`);
