// Pure payout decisions. No AWS imports — unit-tested.
//
// `ruleHasValue` is the strict readiness test. The run pipeline used to ask only
// `!rule || !rule.type`, which passes a bare `percent ALL 0%` — that is why 39 partners
// could reach a run and be paid nothing with no warning. The Partners list already asked
// the stricter question; this is that logic, in one place both sides can use.

export function ruleHasValue(node) {
  if (!node || typeof node !== 'object') return false;
  switch (node.type) {
    case 'flat_per_partner_total': return Number(node.amount) > 0;
    case 'percent':                return (node.rows || []).some(r => Number(r.percent) > 0);
    case 'flat_per_machine':       return (node.rows || []).some(r => Number(r.amount) > 0);
    case 'tiered_percent':         return (node.rows || []).some(r => (r.tiers || []).some(t => Number(t.percent) > 0));
    default:                       return (node.children || []).some(ruleHasValue);
  }
}

// A merchant needs terms when it is meant to be paid but nothing says how much or how to
// aggregate it. Must agree with `payoutDecision` (bulk-runs.mjs) — that is what actually runs
// at calc time — or a contract can pass this gate and still be silently skipped at run time
// (the aggregationMode half of this check was missing until 2026-08-09; 73 live contracts hit
// it: a paying rule with no aggregationMode used to clear step 3 and then get skipped in step 4).
export function contractNeedsTerms(contract) {
  if (!contract) return false;
  // An archived merchant is one whose contract has ended. It is never paid, so it must never
  // hold up a run either — otherwise ending a contract would make the merchant permanently
  // block step 4 with terms nobody intends to set.
  if (contract.archived) return false;
  if (contract.noPayout) return false;
  if (!ruleHasValue(contract.rule)) return true;
  return contract.aggregationMode !== 'whole' && contract.aggregationMode !== 'per_store';
}

const key = s => String(s || '').toLowerCase().trim();

// First occurrence wins, so a duplicate merchant name resolves deterministically rather
// than depending on scan order.
export function indexContractsByName(contracts) {
  const idx = new Map();
  for (const c of contracts || []) {
    if (!c) continue;
    const k = key(c.merchantName);
    if (k && !idx.has(k)) idx.set(k, c);
  }
  return idx;
}

export function resolveLabel(index, label) {
  const k = key(label);
  return k ? (index.get(k) || null) : null;
}
