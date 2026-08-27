#!/usr/bin/env node
// Re-key device codes in contract unit counts and per-machine terms.
//
// Thailand's large cabinets are LL40, not L40 — the roster says "Advertising Player-LL40" 152
// times and there is no plain L40 anywhere. Contracts stored L40 because an old importer ran
// `.replace('LL','L')` on the way in. Singapore's are LL20/LL40 for the same reason.
// L20 is a REAL and separate Thai code (5 machines), so it is never touched in TH.
//
// Terms and units must move together with the parser change: a term keyed to L40 matches
// nothing once roster rows start parsing as LL40.
//
//   REVSHARE_TABLE=RevsharePartner   node infra/rekey-models.mjs L40=LL40 [--apply]
//   REVSHARE_TABLE=RevsharePartnerSG node infra/rekey-models.mjs L20=LL20 L40=LL40 [--apply]
process.env.AWS_REGION ||= 'ap-southeast-7';

const APPLY = process.argv.includes('--apply');
const MAP = Object.fromEntries(process.argv.slice(2).filter(a => a.includes('=')).map(a => a.split('=')));
if (!Object.keys(MAP).length) { console.error('usage: rekey-models.mjs FROM=TO [FROM=TO ...] [--apply]'); process.exit(1); }
const to = m => MAP[String(m || '').toUpperCase()] || m;

const { listContracts, putContract } = await import('../lambda/revshare-api/code/db.mjs');

function rekeyRule(node) {
  if (!node || typeof node !== 'object') return { node, hits: 0 };
  let hits = 0;
  if (node.type === 'flat_per_machine') {
    const rows = (node.rows || []).map((r) => { const n = to(r.model); if (n !== r.model) hits++; return { ...r, model: n }; });
    return { node: { ...node, rows }, hits };
  }
  if (node.children) {
    const children = node.children.map((c) => { const r = rekeyRule(c); hits += r.hits; return r.node; });
    return { node: { ...node, children }, hits };
  }
  return { node, hits };
}

const contracts = await listContracts();
const plan = [];
for (const c of contracts) {
  const units = {};
  let uh = 0;
  for (const [m, n] of Object.entries(c.units || {})) {
    const next = to(m);
    if (next !== m) uh++;
    units[next] = (units[next] || 0) + n;      // merge if both spellings somehow exist
  }
  const { node: rule, hits: rh } = rekeyRule(c.rule);
  if (!uh && !rh) continue;
  plan.push({ c, next: { ...c, units, rule }, uh, rh });
}

console.log(`table ${process.env.REVSHARE_TABLE || 'RevsharePartner'}   mapping ${JSON.stringify(MAP)}`);
console.log(`contracts: ${contracts.length}   to re-key: ${plan.length}  (units ${plan.filter(p => p.uh).length}, terms ${plan.filter(p => p.rh).length})\n`);
for (const p of plan.slice(0, 10))
  console.log(`  ${String(p.c.merchantName).slice(0, 30).padEnd(32)} ${JSON.stringify(p.c.units || {})} -> ${JSON.stringify(p.next.units)}${p.rh ? `   [${p.rh} term row(s)]` : ''}`);
if (plan.length > 10) console.log(`  … and ${plan.length - 10} more`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
let n = 0;
for (const p of plan) { await putContract(p.next); n++; }
console.log(`\nre-keyed ${n} contracts.`);
