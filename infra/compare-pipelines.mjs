// Validation only. Evaluates every brand twice from the SAME store registry — once from the
// partner that used to own the rule, once from the merchant-view row that owns it now — and
// diffs the payout. A non-zero diff is a migration defect, not rounding.
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
const run = (rule, mode, list) => {
  if (!ruleHasValue(rule) || !list?.length) return null;
  try { return evaluateRun({ rule, rows: rowsFor(list), aggregationMode: mode, allowedModels }).totalPayout; }
  catch (e) { return `ERROR: ${e.message}`; }
};

let same = 0; const diffs = [];
for (const c of contracts) {
  const p = c.partnerId ? partners.find(x => x.partnerId === c.partnerId) : null;
  if (!p) continue;
  const oldVal = run(p.rule, p.aggregationMode, byPartner[p.partnerId]);
  const newVal = run(c.rule, c.aggregationMode, byContract[c.contractId]);
  if (oldVal === newVal) { same++; continue; }
  diffs.push({ merchant: c.merchantName, old: oldVal, new: newVal });
}
console.log('brands compared      :', same + diffs.length);
console.log('identical payout     :', same);
console.log('DIFFERENT            :', diffs.length);
diffs.forEach(d => console.log(`   ${d.merchant}: was ${d.old}, now ${d.new}`));
process.exit(diffs.length ? 1 : 0);
