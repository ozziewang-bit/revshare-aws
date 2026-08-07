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

// A merchant needs terms when it is meant to be paid but nothing says how much.
export function contractNeedsTerms(contract) {
  if (!contract) return false;
  if (contract.noPayout) return false;
  return !ruleHasValue(contract.rule);
}

const key = s => String(s || '').toLowerCase().trim();

// First occurrence wins, so a duplicate merchant name resolves deterministically rather
// than depending on scan order.
export function indexContractsByName(contracts) {
  const idx = new Map();
  for (const c of contracts || []) {
    const k = key(c.merchantName);
    if (k && !idx.has(k)) idx.set(k, c);
  }
  return idx;
}

export function resolveLabel(index, label) {
  const k = key(label);
  return k ? (index.get(k) || null) : null;
}
