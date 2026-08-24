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

// Fields of a store-registry row that the roster actually owns. Everything else on the item
// (pk/sk/nameLower/createdAt/updatedAt) is bookkeeping and must not, on its own, force a write.
const ROSTER_OWNED_FIELDS = ['name', 'contractId', 'partnerId', 'machineModel', 'externalId', 'notes'];

// null / undefined / '' all mean "not set" here — putMerchant has always normalised absent
// values inconsistently across these fields, so comparing them raw would report a change on
// every run and defeat the whole point of this check.
const same = (a, b) => (a ?? '') === (b ?? '');

// Should this roster row be written back to the registry? prepare used to PutItem all ~4,000
// rows unconditionally, which at 256MB exceeded the 30s Lambda timeout (and API Gateway's 29s
// ceiling) — the browser saw that as a bare "Failed to fetch". A roster barely changes month to
// month, so writing only what actually differs takes the steady-state case to near zero writes.
export function merchantRowChanged(existing, next) {
  if (!existing) return true;
  return ROSTER_OWNED_FIELDS.some(f => !same(existing[f], next[f]));
}
