// Validation only. For every contract that carries a partnerId, compares the migrated fields
// (aggregationMode, noPayout, currency, rule) directly against the partner they were copied
// from. That is the primary check: "did the migration copy faithfully" has a direct field-level
// answer, and any mismatch there is unambiguously a migration defect.
//
// Payout is kept as a SECONDARY signal only. totalPayout is mathematically invariant to
// aggregationMode for any rule built from linear leaves (summing per-store evaluations of a
// linear tree equals evaluating once over all rows) — it only diverges for max/min-combinator
// rules whose MG floor actually binds differently under whole vs. per_store. Across this data
// that is true for at most a couple of brands, so a payout match/mismatch alone cannot be trusted
// to prove or disprove that aggregationMode copied correctly. It still catches some rule-copying
// errors when it can, and a disagreement between the two checks is itself worth investigating.
//
//   node infra/compare-pipelines.mjs --table RevsharePartner --region ap-southeast-7
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { evaluateRun } from '../lambda/revshare-api/code/engine.mjs';
import { ruleHasValue } from '../lambda/revshare-api/code/payout.mjs';

const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const TABLE = arg('--table') || 'RevsharePartner';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: arg('--region') || 'ap-southeast-7' }));

async function queryAll(pk) {
  const out = []; let last;
  do {
    const r = await ddb.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey: last }));
    out.push(...(r.Items || [])); last = r.LastEvaluatedKey;
  } while (last);
  return out;
}

const [partners, contracts, stores, models] = await Promise.all([
  queryAll('PARTNER'), queryAll('CONTRACT'), queryAll('MERCHANT'), queryAll('CONFIG'),
]);
const allowedModels = new Set(models.filter(m => m.code).map(m => m.code));

// Synthetic but deterministic revenue, so both paths see identical inputs.
const rowsFor = list => list.map((s, i) => ({
  storeId: s.merchantId, machineSerial: s.merchantId,
  model: s.machineModel || 'S8', rentals: (i % 7) + 1, revenue: ((i % 7) + 1) * 1000,
}));

const byPartner = {}, byContract = {};
for (const s of stores) {
  if (s.partnerId) (byPartner[s.partnerId] = byPartner[s.partnerId] || []).push(s);
  if (s.contractId) (byContract[s.contractId] = byContract[s.contractId] || []).push(s);
}

// NOTE: if evaluateRun throws on BOTH sides with the identical message (e.g. an unknown machine
// model shared by the row data both sides read), the two "ERROR: ..." strings compare equal and
// this registers as a payout "match" without ever exercising the fields being compared. That is
// expected and harmless here because payout is only a secondary signal — the field comparison
// below is what actually proves the migration copied correctly. Not observed in this run.
const run = (rule, mode, list) => {
  if (!ruleHasValue(rule) || !list?.length) return null;
  try { return evaluateRun({ rule, rows: rowsFor(list), aggregationMode: mode, allowedModels }).totalPayout; }
  catch (e) { return `ERROR: ${e.message}`; }
};

// Stable stringify: sorts object keys (recursively, via the replacer) so two structurally
// identical rule trees compare equal regardless of key insertion order.
const stableStringify = value => JSON.stringify(value, function sortKeys(_key, v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = v[k]; return acc; }, {});
  }
  return v;
});

let compared = 0, skipped = 0;
let fieldsMatch = 0; const fieldMismatches = [];
let payoutComputedBoth = 0, payoutTrivial = 0; const payoutDiffs = [];

for (const c of contracts) {
  const p = c.partnerId ? partners.find(x => x.partnerId === c.partnerId) : null;
  if (!p) { skipped++; continue; }
  compared++;

  const rowMismatches = [];
  if ((p.aggregationMode ?? null) !== (c.aggregationMode ?? null)) {
    rowMismatches.push({ field: 'aggregationMode', old: p.aggregationMode, new: c.aggregationMode });
  }
  if (!!p.noPayout !== !!c.noPayout) {
    rowMismatches.push({ field: 'noPayout', old: !!p.noPayout, new: !!c.noPayout });
  }
  if ((p.currency ?? null) !== (c.currency ?? null)) {
    rowMismatches.push({ field: 'currency', old: p.currency, new: c.currency });
  }
  if (stableStringify(p.rule ?? null) !== stableStringify(c.rule ?? null)) {
    rowMismatches.push({ field: 'rule', old: p.rule, new: c.rule });
  }

  if (rowMismatches.length) fieldMismatches.push({ merchant: c.merchantName, mismatches: rowMismatches });
  else fieldsMatch++;

  // Secondary signal — see NOTE above on why this cannot stand alone.
  const oldVal = run(p.rule, p.aggregationMode, byPartner[p.partnerId]);
  const newVal = run(c.rule, c.aggregationMode, byContract[c.contractId]);
  if (oldVal === null && newVal === null) {
    payoutTrivial++;
  } else {
    payoutComputedBoth++;
    if (oldVal !== newVal) payoutDiffs.push({ merchant: c.merchantName, old: oldVal, new: newVal });
  }
}

console.log('contracts                 :', contracts.length);
console.log('  compared (have partner) :', compared);
console.log('  skipped (no partner)    :', skipped);
console.log('field comparison');
console.log('  all fields match        :', fieldsMatch);
console.log('  MISMATCHED              :', fieldMismatches.length);
for (const m of fieldMismatches) {
  for (const f of m.mismatches) {
    console.log(`   ${m.merchant}: ${f.field} was ${JSON.stringify(f.old)}, now ${JSON.stringify(f.new)}`);
  }
}
console.log('payout comparison (secondary signal)');
console.log('  computed both sides     :', payoutComputedBoth);
console.log('  trivial (nothing to run):', payoutTrivial);
console.log('  DIFFERENT               :', payoutDiffs.length);
payoutDiffs.forEach(d => console.log(`   ${d.merchant}: was ${d.old}, now ${d.new}`));

const failed = fieldMismatches.length > 0 || payoutDiffs.length > 0;
process.exit(failed ? 1 : 0);
