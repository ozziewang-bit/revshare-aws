#!/usr/bin/env node
// Re-key Singapore's LL20/LL40 back to L20/L40 in contract units and per-machine terms.
//
// LL20/LL40 were briefly models in their own right (2026-08-26 to 2026-08-27). They are not:
// they are the platform's spelling of L20/L40, and Thailand's own roster uses it — 152 rows
// read "Advertising Player-LL40" while every Thai contract keys terms to L40. The SG import
// ran during that window and wrote LL20/LL40 into 36 unit maps and 8 rules, which no longer
// match anything now that the fold is restored.
//
// Singapore has never run a payout, so this changes no historical number.
//   node infra/rekey-sg-ll-models.mjs [--apply]
process.env.AWS_REGION ||= 'ap-southeast-7';
process.env.REVSHARE_TABLE ||= 'RevsharePartnerSG';

const APPLY = process.argv.includes('--apply');
const { listContracts, putContract } = await import('../lambda/revshare-api/code/db.mjs');

const FOLD = { LL20: 'L20', LL40: 'L40' };
const fold = m => FOLD[String(m || '').toUpperCase()] || m;

// Rewrite every flat_per_machine row's model, in place through the tree.
function rekeyRule(node) {
  if (!node || typeof node !== 'object') return { node, hits: 0 };
  let hits = 0;
  if (node.type === 'flat_per_machine') {
    const rows = (node.rows || []).map((r) => {
      const next = fold(r.model);
      if (next !== r.model) hits++;
      return { ...r, model: next };
    });
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
  let unitHits = 0;
  for (const [m, n] of Object.entries(c.units || {})) {
    const next = fold(m);
    if (next !== m) unitHits++;
    units[next] = (units[next] || 0) + n;          // merge, in case both spellings exist
  }
  const { node: rule, hits: ruleHits } = rekeyRule(c.rule);
  if (!unitHits && !ruleHits) continue;
  plan.push({ c, next: { ...c, units, rule }, unitHits, ruleHits });
}

console.log(`SG contracts: ${contracts.length}`);
console.log(`to re-key: ${plan.length}  (units: ${plan.filter((p) => p.unitHits).length}, rules: ${plan.filter((p) => p.ruleHits).length})\n`);
for (const p of plan.slice(0, 12)) {
  console.log(`  ${p.c.merchantName.slice(0, 34).padEnd(36)} units ${JSON.stringify(p.c.units || {})} -> ${JSON.stringify(p.next.units)}`);
  if (p.ruleHits) console.log(`  ${''.padEnd(36)} rule  ${JSON.stringify(p.c.rule).slice(0, 90)}`);
}
if (plan.length > 12) console.log(`  … and ${plan.length - 12} more`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
let n = 0;
for (const p of plan) { await putContract(p.next); n++; }
console.log(`\nre-keyed ${n} contracts.`);
