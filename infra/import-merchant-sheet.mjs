#!/usr/bin/env node
// Import an updated `All_Merchant` sheet into the live CONTRACT rows.
//
// This is the same operation as the Merchant view's **Upload sheet** button — it reuses
// `normalizeContractRow` / `buildImportPlan` from `lambda/revshare-api/code/contracts.mjs`,
// and writes rows in `putContract`'s exact shape. Only the transport differs: the HTTP route
// (`POST /contracts/import`) needs a browser Google token, which a CLI run does not have.
// Prefer the button. Reach for this when you need a dry run, a field-level diff, or the
// name-canonicalisation below before committing 200+ writes to production.
//
//   node infra/import-merchant-sheet.mjs "<workbook>.xlsx"            # dry run (default)
//   node infra/import-merchant-sheet.mjs "<workbook>.xlsx" --apply    # write
//
// Safety properties, in order of how much they matter:
//
//  1. **Payout fields are never written.** `rule`, `aggregationMode`, `noPayout`, `currency`,
//     `archived` and `archivedAt` are not sheet columns, so `buildImportPlan`'s `...existing`
//     spread carries them through untouched. A guard re-checks every planned update and
//     ABORTS the whole run if any of them would change — belt and braces, because this is the
//     one thing an import must never damage.
//  2. **Nothing is ever deleted.** A merchant live in the app but absent from the sheet is
//     left exactly as it is. Reported as "untouched".
//  3. **Column positions are checked first.** The sheet is read by fixed column INDEX (merged
//     header cells make name-keyed parsing unreliable), so an inserted column silently shifts
//     every field. Two anchors on header row 2 are verified before anything is parsed — the
//     same two the frontend checks in `parseAllMerchantSheet`.
//
// Idempotent: re-running with no sheet changes plans 0 creates and rewrites the same values.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ulid } from 'ulid';
import { normalizeContractRow, buildImportPlan } from '../lambda/revshare-api/code/contracts.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';
const REGION = process.env.AWS_REGION || 'ap-southeast-7';

// Sheet spellings that must resolve to an existing merchant instead of creating a second row.
// The workbook is human-maintained and still carries pre-correction names for these brands;
// the canonical forms were fixed in the Merchant view on 2026-08-09. Without this, an import
// creates a duplicate row with no terms, which then shows as "Needs terms" and blocks step 4
// of a run while the real row sits beside it holding the actual rule.
const CANONICAL = new Map([
  ['big c', 'BIG-C'],
  ['baan ying', 'BAANYING'],
  ['future rangsit', 'Future Park Rangsit'],
]);

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file || file.startsWith('--')) {
  console.error('usage: node infra/import-merchant-sheet.mjs "<workbook>.xlsx" [--apply]');
  process.exit(2);
}

// The frontend's self-hosted SheetJS build, run in a VM so this script needs no new dep.
function loadXlsx() {
  const ctx = { window: {}, self: {}, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'frontend/lib/xlsx.full.min.js'), 'utf8'), ctx);
  return ctx.XLSX || ctx.window.XLSX;
}

function readSheet(XLSX) {
  const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const ws = wb.Sheets['All_Merchant'];
  if (!ws) throw new Error('Sheet "All_Merchant" not found in this workbook');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  const h2 = aoa[1] || [];
  if (!/merchant/i.test(String(h2[1] || '')) || !/link/i.test(String(h2[22] || ''))) {
    throw new Error('All_Merchant layout has changed — column positions no longer match the '
      + 'importer. Check for inserted/removed/reordered columns before running this.');
  }
  const body = aoa.slice(2);
  return body
    .map(r => { const c = new Array(23).fill(null); for (let i = 0; i < 23; i++) c[i] = r[i] ?? null; return c; })
    .filter(c => String(c[1] || '').trim());
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
async function queryAll(pk, skPrefix) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: skPrefix ? 'pk = :p AND begins_with(sk, :s)' : 'pk = :p',
      ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk },
      ExclusiveStartKey,
    }));
    out.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const XLSX = loadXlsx();
const rows = readSheet(XLSX);
let renamed = 0;
for (const r of rows) {
  const canonical = CANONICAL.get(String(r[1] || '').trim().toLowerCase());
  if (canonical && canonical !== String(r[1]).trim()) { r[1] = canonical; renamed++; }
}

const [contracts, partnersRaw] = await Promise.all([queryAll('CONTRACT'), queryAll('PARTNER', 'META#')]);
const partners = partnersRaw.filter(p => !p.archived);
const normalized = rows.map(normalizeContractRow).filter(Boolean);
const plan = buildImportPlan(normalized, contracts, partners, {});

console.log(`sheet          : ${path.basename(file)}`);
console.log(`rows with name : ${rows.length}  (canonicalised: ${renamed})`);
console.log(`live contracts : ${contracts.length}`);
console.log(`creates        : ${plan.creates.length}${plan.creates.length ? '  → ' + plan.creates.map(c => c.merchantName).join(', ') : ''}`);
console.log(`updates        : ${plan.updates.length}`);
console.log(`untouched      : ${contracts.length - plan.updates.length}  (live but not in the sheet — never deleted)`);

// Key-order-insensitive comparison. DynamoDB does not preserve map key order, so a `units`
// map read back as {S8,L40,S5} is the same value as the {S5,S8,L40} that was written —
// plain JSON.stringify calls that a change and reports phantom diffs on every re-run.
const stable = v => JSON.stringify(v, (k, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map(kk => [kk, val[kk]]))
    : val);

const byId = new Map(contracts.map(c => [c.contractId, c]));
const PAYOUT = ['rule', 'aggregationMode', 'noPayout', 'currency', 'archived', 'archivedAt'];
const violations = [];
for (const u of plan.updates) {
  const o = byId.get(u.contractId);
  if (!o) { violations.push(`${u.merchantName}: update with no existing row`); continue; }
  for (const f of PAYOUT) {
    if (o[f] !== undefined && stable(u[f]) !== stable(o[f])) {
      violations.push(`${o.merchantName}.${f}: ${stable(o[f])} → ${stable(u[f])}`);
    }
  }
}
if (violations.length) {
  console.error('\nABORT — payout fields would change. Nothing written.\n  ' + violations.join('\n  '));
  process.exit(1);
}
console.log('guard          : rule/aggregationMode/noPayout/currency/archived preserved on every update');

// Which sheet-owned fields actually move, so a "206 updated" number is never mistaken for
// "206 rows changed".
const FIELDS = ['merchantType', 'counterParty', 'installedUnits', 'units', 'startDate', 'endDate',
                'terminationNoticeDays', 'declineToRenew', 'autoRenewal', 'contractLink'];
const changedBy = {};
let changedRows = 0;
for (const u of plan.updates) {
  const o = byId.get(u.contractId);
  let hit = false;
  for (const f of FIELDS) {
    if (stable(o[f] ?? null) !== stable(u[f] ?? null)) { changedBy[f] = (changedBy[f] || 0) + 1; hit = true; }
  }
  if (hit) changedRows++;
}
console.log(`real changes   : ${changedRows} of ${plan.updates.length} updates change a value`
  + (changedRows ? '  [' + Object.entries(changedBy).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ') + ']' : ''));

if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); process.exit(0); }

const all = [...plan.creates.map(c => ({ ...c, contractId: ulid() })), ...plan.updates];
let done = 0;
for (let i = 0; i < all.length; i += 10) {          // bounded concurrency, as the route does
  await Promise.all(all.slice(i, i + 10).map(c => {
    const now = new Date().toISOString();
    return ddb.send(new PutCommand({ TableName: TABLE, Item: {
      pk: 'CONTRACT', sk: `CONTRACT#${c.contractId}`, ...c,
      merchantNameLower: (c.merchantName || '').toLowerCase().trim(),
      updatedAt: now, createdAt: c.createdAt || now,
    } }));
  }));
  done += Math.min(10, all.length - i);
  if (done % 50 === 0 || done === all.length) console.log(`  written ${done}/${all.length}`);
}
console.log('done');
