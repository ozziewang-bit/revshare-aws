# Merchant View as Source of Truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the revenue-share run pipeline read Merchant view rows (`CONTRACT`) instead of `PARTNER`, so the Partners page can be removed.

**Architecture:** The `CONTRACT` row gains the four fields that made a partner a payout entity (`rule`, `aggregationMode`, `noPayout`, `currency`). The 4,066-row store registry gains `contractId`. A one-off idempotent migration copies rules across and repoints stores. The roster resolver then maps a `Merchant label` to a contract instead of a partner, and the run evaluates each contract's own rule. **The calculation engine does not change.**

**Tech Stack:** Node 22 ES modules, `node:test` + `node:assert`, DynamoDB via `@aws-sdk/lib-dynamodb`, vanilla browser JS (no build step).

**Spec:** `docs/superpowers/specs/2026-08-07-merchant-view-as-source-of-truth-design.md`

## Global Constraints

- **No change to `lambda/revshare-api/code/engine.mjs`.** It still takes a rule, rows and an aggregation mode; only the source of those changes.
- **`PARTNER` rows and the `/partners` routes are kept, dormant.** Nothing reads them after migration. Do not delete rows and do not remove routes — they are the only record to compare a migrated rule against.
- **The 436 store rows whose brand has no contract row are never deleted.** They resolve to nothing and must appear in the run's unmatched list. Silent is the failure mode to avoid.
- **The migration only ever writes a field that is currently absent on the target.** Re-running it must not overwrite a rule edited in the app afterwards.
- **The readiness gate must test that a rule pays something**, by walking it for a non-zero value — not `!rule || !rule.type`, which passes a bare `percent ALL 0%`. 39 partners are in exactly that state today.
- **`buildRosterRows`, `applyMerchantRoster` and the new resolution helpers stay pure or thin.** Business logic goes in a testable module, not inline in a route.
- **Bump `frontend/service-worker.js` `CACHE_VERSION`** on every shell change (currently `revshare-v100`).
- **No `Co-Authored-By:` trailers in commit messages.**
- **Prefix AWS CLI calls with `AWS_DEFAULT_OUTPUT=json`** — the user's `~/.aws/config` sets `output=none`.
- **After any `deploy-lambda-all.sh` run, check BOTH `/healthz` endpoints.** SG was down 3 hours in this project because only TH was checked.
- **Local commits per task; do not `git push`** until the user says "save progress".

**Live baseline, verified 2026-08-07:** 207 contract rows (134 linked to a partner, 73 not); 4,066 store rows referencing 199 distinct partners; 134 of those partners have a contract, 65 do not (436 store rows); 0 bulk runs, 0 per-partner runs, 0 objects in the run bucket; 96/96 tests pass.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lambda/revshare-api/code/payout.mjs` | **New.** Pure: does a rule pay anything, does a contract need terms, resolve a label to a contract. No AWS imports. | Create |
| `lambda/revshare-api/tests/payout.test.mjs` | **New.** Tests for the above. | Create |
| `infra/migrate-to-contracts.mjs` | **New.** One-off idempotent migration + coverage report. | Create |
| `lambda/revshare-api/code/routes/contracts.mjs` | Contract CRUD | Add 4 fields to `WRITABLE` |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Roster + run | Resolve to contracts; evaluate from contracts |
| `lambda/revshare-api/tests/bulk-runs.test.mjs` | Run tests | Update for contract keying |
| `infra/compare-pipelines.mjs` | **New.** Dual-run diff, validation only. | Create |
| `frontend/app.js` | SPA | Dialog writes contracts; wizard + analytics rekeyed; Partners screens removed |
| `frontend/service-worker.js` | Shell cache | Bump |
| `CLAUDE.md` | Handoff doc | Rewrite the data-model and run-flow sections |

---

### Task 1: Pure payout module

Everything the pipeline needs to decide *whether* and *how* a merchant gets paid, in one
import-free module that can be unit-tested without AWS.

**Files:**
- Create: `lambda/revshare-api/code/payout.mjs`
- Test: `lambda/revshare-api/tests/payout.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces, relied on by Tasks 2, 3 and 4:
  - `ruleHasValue(node)` → boolean. True when the tree contains a leaf that pays something.
  - `contractNeedsTerms(contract)` → boolean. True when the contract is not `noPayout` and its rule pays nothing.
  - `indexContractsByName(contracts)` → `Map` from lowercased trimmed `merchantName` to contract.
  - `resolveLabel(index, label)` → contract or `null`.

- [ ] **Step 1: Write the failing tests**

Create `lambda/revshare-api/tests/payout.test.mjs`:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ruleHasValue, contractNeedsTerms, indexContractsByName, resolveLabel } from '../code/payout.mjs';

const pct = p => ({ type: 'percent', rows: [{ model: 'ALL', percent: p }] });
const mg  = a => ({ type: 'flat_per_machine', rows: [{ model: 'S8', amount: a }] });

test('ruleHasValue: a non-zero percent pays', () => {
  assert.equal(ruleHasValue(pct(50)), true);
});

test('ruleHasValue: a bare 0% does NOT pay — this is the 39-partner case', () => {
  assert.equal(ruleHasValue(pct(0)), false);
});

test('ruleHasValue: null and empty shapes do not pay', () => {
  assert.equal(ruleHasValue(null), false);
  assert.equal(ruleHasValue({ type: 'sum', children: [] }), false);
  assert.equal(ruleHasValue({}), false);
});

test('ruleHasValue: flat leaves', () => {
  assert.equal(ruleHasValue(mg(200)), true);
  assert.equal(ruleHasValue(mg(0)), false);
  assert.equal(ruleHasValue({ type: 'flat_per_partner_total', amount: 900 }), true);
  assert.equal(ruleHasValue({ type: 'flat_per_partner_total', amount: 0 }), false);
});

test('ruleHasValue: recurses through combinators', () => {
  assert.equal(ruleHasValue({ type: 'sum', children: [pct(0), mg(200)] }), true);
  assert.equal(ruleHasValue({ type: 'max', children: [pct(0), mg(0)] }), false);
  assert.equal(ruleHasValue({ type: 'sum', children: [{ type: 'max', children: [pct(25)] }] }), true);
});

test('ruleHasValue: tiered_percent', () => {
  assert.equal(ruleHasValue({ type: 'tiered_percent', rows: [{ tiers: [{ percent: 15 }] }] }), true);
  assert.equal(ruleHasValue({ type: 'tiered_percent', rows: [{ tiers: [{ percent: 0 }] }] }), false);
});

test('contractNeedsTerms: noPayout never needs terms', () => {
  assert.equal(contractNeedsTerms({ noPayout: true, rule: null }), false);
  assert.equal(contractNeedsTerms({ noPayout: true, rule: pct(50) }), false);
});

test('contractNeedsTerms: a paying rule needs nothing', () => {
  assert.equal(contractNeedsTerms({ rule: pct(50) }), false);
});

test('contractNeedsTerms: no rule, or a rule that pays nothing, needs terms', () => {
  assert.equal(contractNeedsTerms({ rule: null }), true);
  assert.equal(contractNeedsTerms({ rule: pct(0) }), true);
  assert.equal(contractNeedsTerms({ rule: { type: 'sum', children: [] } }), true);
});

test('indexContractsByName / resolveLabel match case- and space-insensitively', () => {
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'BIG-C' },
    { contractId: 'c2', merchantName: '  7-Eleven ' },
  ]);
  assert.equal(resolveLabel(idx, 'big-c').contractId, 'c1');
  assert.equal(resolveLabel(idx, '  7-ELEVEN  ').contractId, 'c2');
  assert.equal(resolveLabel(idx, 'Big C'), null);   // punctuation still matters
  assert.equal(resolveLabel(idx, ''), null);
  assert.equal(resolveLabel(idx, null), null);
});

test('indexContractsByName: later duplicates do not silently win', () => {
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'IMPACT' },
    { contractId: 'c2', merchantName: 'impact' },
  ]);
  assert.equal(resolveLabel(idx, 'IMPACT').contractId, 'c1');   // first wins, deterministically
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../code/payout.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `lambda/revshare-api/code/payout.mjs`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 107`, `fail 0` (96 existing + 11 new).

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/payout.mjs lambda/revshare-api/tests/payout.test.mjs
git commit -m "feat(payout): pure readiness + label-resolution module"
```

---

### Task 2: Migration script

**Files:**
- Create: `infra/migrate-to-contracts.mjs`
- Modify: `lambda/revshare-api/code/routes/contracts.mjs` (`WRITABLE`)

**Interfaces:**
- Consumes: `ruleHasValue` from Task 1 (for the coverage report only).
- Produces: contract rows carrying `rule`, `aggregationMode`, `noPayout`, `currency`; store rows carrying `contractId`. Tasks 3 and 4 assume both.

- [ ] **Step 1: Let the API accept the new contract fields**

In `lambda/revshare-api/code/routes/contracts.mjs`, extend `WRITABLE`:

```js
  // The contract is the payout entity now: it owns the rule, how it aggregates, whether it
  // is paid at all, and in which currency. These were PARTNER fields until 2026-08-07.
  'rule', 'aggregationMode', 'noPayout', 'currency',
```

- [ ] **Step 2: Write the migration script**

Create `infra/migrate-to-contracts.mjs`:

```js
// One-off, idempotent. Copies payout fields from PARTNER rows onto their CONTRACT row, then
// points every store-registry row at a contract.
//
// Safety: only ever writes a field that is ABSENT on the target, so re-running cannot
// overwrite a rule edited in the app after the first run. Reports and changes nothing on
// --dry-run.
//
//   node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7 --dry-run
//   node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const TABLE = arg('--table') || 'RevsharePartner';
const REGION = arg('--region') || 'ap-southeast-7';
const DRY = process.argv.includes('--dry-run');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function queryAll(pk) {
  const out = []; let last;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE, KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey: last,
    }));
    out.push(...(r.Items || [])); last = r.LastEvaluatedKey;
  } while (last);
  return out;
}

const [partners, contracts, stores] = await Promise.all([
  queryAll('PARTNER'), queryAll('CONTRACT'), queryAll('MERCHANT'),
]);
const partnerById = new Map(partners.map(p => [p.partnerId, p]));

// One contract per partner is assumed by step 2 — if two contracts share a partner there is
// no single answer for that partner's stores. Stop rather than pick one.
const byPartner = new Map();
for (const c of contracts.filter(c => c.partnerId)) {
  if (byPartner.has(c.partnerId)) {
    console.error(`ABORT: partner ${c.partnerId} is claimed by two contracts: ` +
      `"${byPartner.get(c.partnerId).merchantName}" and "${c.merchantName}". Resolve before migrating.`);
    process.exit(1);
  }
  byPartner.set(c.partnerId, c);
}

let copied = 0, skipped = 0;
for (const c of contracts) {
  const p = c.partnerId ? partnerById.get(c.partnerId) : null;
  if (!p) continue;
  const sets = {}, names = {}, vals = {};
  for (const f of ['rule', 'aggregationMode', 'noPayout', 'currency']) {
    if (c[f] !== undefined) continue;              // already migrated or edited in-app — leave it
    if (p[f] === undefined) continue;
    sets[f] = true; names[`#${f}`] = f; vals[`:${f}`] = p[f];
  }
  const fields = Object.keys(sets);
  if (!fields.length) { skipped++; continue; }
  copied++;
  if (DRY) continue;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'CONTRACT', sk: c.sk },
    UpdateExpression: 'SET ' + fields.map(f => `#${f} = :${f}`).join(', '),
    ExpressionAttributeNames: names, ExpressionAttributeValues: vals,
  }));
}

let pointed = 0, orphanStores = 0;
for (const s of stores) {
  if (s.contractId !== undefined) continue;
  const c = s.partnerId ? byPartner.get(s.partnerId) : null;
  if (!c) { orphanStores++; continue; }            // brand has no contract row — stays unmatched, by decision
  pointed++;
  if (DRY) continue;
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { pk: 'MERCHANT', sk: s.sk },
    UpdateExpression: 'SET contractId = :c',
    ExpressionAttributeValues: { ':c': c.contractId },
  }));
}

console.log(DRY ? '--- DRY RUN, nothing written ---' : '--- migration applied ---');
console.log('partners            :', partners.length);
console.log('contracts           :', contracts.length);
console.log('  fields copied onto:', copied);
console.log('  already had them  :', skipped);
console.log('store rows          :', stores.length);
console.log('  pointed at a contract:', pointed);
console.log('  left unmatched       :', orphanStores);
```

- [ ] **Step 3: Dry-run it and check the numbers against the baseline**

```bash
AWS_DEFAULT_OUTPUT=json node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7 --dry-run
```
Expected: `contracts 207`, `fields copied onto 134`, `store rows 4066`, `pointed at a contract 3630`, `left unmatched 436`. **If any number differs, stop and report** — the baseline was measured on 2026-08-07 and a difference means the data moved.

- [ ] **Step 4: Apply it, then re-run the dry run**

```bash
AWS_DEFAULT_OUTPUT=json node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7
AWS_DEFAULT_OUTPUT=json node infra/migrate-to-contracts.mjs --table RevsharePartner --region ap-southeast-7 --dry-run
```
Expected on the second run: `fields copied onto 0`, `already had them 134`, `pointed at a contract 0`. That is the idempotence proof — paste both outputs in your report.

- [ ] **Step 5: Spot-check the highest-value row**

```bash
AWS_DEFAULT_OUTPUT=json aws dynamodb query --table-name RevsharePartner --region ap-southeast-7 \
  --key-condition-expression "pk = :p" --expression-attribute-values '{":p":{"S":"CONTRACT"}}' \
  --projection-expression "merchantName, aggregationMode, #r" --expression-attribute-names '{"#r":"rule"}' \
  --query 'Items[?merchantName.S==`7-Eleven`]'
```
Expected: `aggregationMode` = `per_store`, and a rule of `max( percent 50%, flat_per_machine[S5:150, S8:200, L40:1000] )`. Anything else means the copy is wrong — stop.

- [ ] **Step 6: Commit**

```bash
git add infra/migrate-to-contracts.mjs lambda/revshare-api/code/routes/contracts.mjs
git commit -m "feat(contracts): payout fields writable + one-off migration from partners"
```

---

### Task 3: Run pipeline reads contracts

**Files:**
- Modify: `lambda/revshare-api/code/routes/bulk-runs.mjs`
- Test: `lambda/revshare-api/tests/bulk-runs.test.mjs`

**Interfaces:**
- Consumes: `ruleHasValue`, `contractNeedsTerms`, `indexContractsByName`, `resolveLabel` (Task 1); migrated data (Task 2); `listContracts`, `getContract`, `putContract` from `db.mjs`.
- Produces:
  - `applyMerchantRoster(merchants)` → `{ roster, merchantsNeedingTerms, unassigned, newMerchants }`, where each roster entry carries `contractId` and `unmatchedLabels` lists labels with no contract row.
  - `buildRosterRows(roster, orders)` → `{ groups, ... }` keyed by **`contractId`**.
  - Run results carry `contractId` and `merchantName` instead of `partnerId`/`partnerName`.

- [ ] **Step 1: Write the failing tests**

Append to `lambda/revshare-api/tests/bulk-runs.test.mjs`:

```js
import { buildRosterRows } from '../code/routes/bulk-runs.mjs';

test('buildRosterRows groups by contractId, not partnerId', () => {
  const roster = [
    { merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
    { merchantId: 'm2', name: 'Store B', nameLower: 'store b', contractId: 'c1', model: 'S5' },
    { merchantId: 'm3', name: 'Store C', nameLower: 'store c', contractId: 'c2', model: 'S8' },
  ];
  const { groups } = buildRosterRows(roster, []);
  assert.deepEqual(Object.keys(groups).sort(), ['c1', 'c2']);
  assert.equal(groups.c1.length, 2);
  assert.equal(groups.c2.length, 1);
});

test('buildRosterRows drops stores with no contract — the 436 case — without throwing', () => {
  const roster = [
    { merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' },
    { merchantId: 'm2', name: 'Orphan',  nameLower: 'orphan',  contractId: null, model: 'S8' },
  ];
  const { groups } = buildRosterRows(roster, []);
  assert.deepEqual(Object.keys(groups), ['c1']);
  assert.equal(groups.c1.length, 1);
});

test('buildRosterRows still overlays orders by store name and reports unmatched', () => {
  const roster = [{ merchantId: 'm1', name: 'Store A', nameLower: 'store a', contractId: 'c1', model: 'S8' }];
  const { groups, unmatched, unmatchedOrderCount } = buildRosterRows(roster, [
    { merchantName: 'Store A', netAmount: 100 },
    { merchantName: 'Store A', netAmount: 50 },
    { merchantName: 'Nowhere', netAmount: 999 },
  ]);
  assert.equal(groups.c1[0].rentals, 2);
  assert.equal(groups.c1[0].revenue, 150);
  assert.deepEqual(unmatched, ['Nowhere']);
  assert.equal(unmatchedOrderCount, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `buildRosterRows` still groups on `partnerId`, so `Object.keys(groups)` is empty.

- [ ] **Step 3: Rewrite `buildRosterRows`**

Replace the body of `buildRosterRows` in `lambda/revshare-api/code/routes/bulk-runs.mjs`:

```js
export function buildRosterRows(roster, orders) {
  const groups = {};                 // contractId -> [ {merchantId, merchantName, model, rentals, revenue} ]
  const byName = {};                 // nameLower -> row (for order overlay)
  for (const m of roster) {
    // No contract means no merchant-view row for this brand: not paid, by decision, and
    // surfaced in the run's unmatched list rather than deleted.
    if (!m.contractId) continue;
    const row = { merchantId: m.merchantId, merchantName: m.name, model: m.model || 'S8', rentals: 0, revenue: 0 };
    (groups[m.contractId] = groups[m.contractId] || []).push(row);
    byName[(m.nameLower || m.name || '').toLowerCase().trim()] = row;
  }
  const unmatchedSet = new Set();
  let unmatchedOrderCount = 0, unmatchedRevenue = 0;
  for (const { merchantName, netAmount } of orders) {
    const row = byName[(merchantName || '').toLowerCase().trim()];
    if (!row) { unmatchedSet.add(merchantName); unmatchedOrderCount++; unmatchedRevenue += Number(netAmount) || 0; continue; }
    row.rentals++; row.revenue += Number(netAmount) || 0;
  }
  return { groups, unmatched: [...unmatchedSet], unmatchedOrderCount, unmatchedRevenue };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 110`, `fail 0`.

- [ ] **Step 5: Rewrite `applyMerchantRoster` to resolve labels to contracts**

Replace `applyMerchantRoster` entirely:

```js
// A roster row's `Merchant label` is the brand. Resolve it to a Merchant-view row; create
// one if the brand is new, so a roster upload still onboards merchants. Labels that match
// nothing are impossible here (we create them) — the unmatched case is the reverse: a
// store-registry row whose brand has no contract, handled in buildRosterRows.
export async function applyMerchantRoster(merchants) {
  const [contracts, existingMerchants] = await Promise.all([listContracts(), listMerchants()]);
  let index = indexContractsByName(contracts);
  const merchantByName = {};
  for (const m of existingMerchants) merchantByName[m.nameLower] = m;

  const unassigned = [], newMerchants = [];
  const validRows = [];
  const newLabels = new Map();
  for (const src of merchants) {
    const label = (src.partnerName || '').trim();
    if (!label || label === '-') { unassigned.push(src.name); continue; }
    const key = label.toLowerCase();
    if (!resolveLabel(index, label) && !newLabels.has(key)) newLabels.set(key, label);
    validRows.push({ src, label });
  }

  await mapPool([...newLabels.values()], 20, async label => {
    const created = await putContract({ contractId: ulid(), merchantName: label, partnerId: null,
      units: {}, notes: '', rule: null, aggregationMode: 'per_store', noPayout: false, currency: 'THB' });
    contracts.push(created);
    newMerchants.push(label);
  });
  index = indexContractsByName(contracts);

  const roster = [];
  const seen = {};
  await mapPool(validRows, 25, async ({ src, label }) => {
    const contract = resolveLabel(index, label);
    const ex = merchantByName[(src.name || '').toLowerCase().trim()];
    const merchantId = ex?.merchantId || ulid();
    const saved = await putMerchant({ merchantId, createdAt: ex?.createdAt, name: src.name,
      contractId: contract.contractId, partnerId: ex?.partnerId ?? null,
      machineModel: src.model || null, externalId: src.externalId || ex?.externalId || null, notes: ex?.notes || '' });
    roster.push({ merchantId, name: src.name, nameLower: saved.nameLower, contractId: contract.contractId, model: src.model || null });
    seen[contract.contractId] = contract;
  });

  const merchantsNeedingTerms = Object.values(seen)
    .filter(contractNeedsTerms)
    .map(c => ({ contractId: c.contractId, name: c.merchantName }));

  return { roster, merchantsNeedingTerms, unassigned, newMerchants };
}
```

Extend the imports at the top of the file:

```js
import { listContracts, getContract, putContract } from '../db.mjs';
import { contractNeedsTerms, indexContractsByName, resolveLabel } from '../payout.mjs';
```

- [ ] **Step 6: Rewrite the evaluation loop in `createBulkRunRoute`**

Replace the destructure, the pre-fetch and the loop:

```js
  const { roster, unassigned } = await applyMerchantRoster(merchants);
  ...
  const contractIds = Object.keys(groups);
  const fetched = await mapPool(contractIds, 25, id => getContract(id));
  const contractById = {};
  contractIds.forEach((id, i) => { contractById[id] = fetched[i]; });

  for (const [contractId, merchantRows] of Object.entries(groups)) {
    const contract = contractById[contractId];
    if (!contract) { warnings.push(`Merchant ${contractId} not found, skipped`); continue; }
    if (contract.noPayout) continue;
    if (!ruleHasValue(contract.rule)) { warnings.push(`"${contract.merchantName}" has no terms that pay, skipped`); continue; }

    const engineRows = merchantRows.map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
    let result;
    try {
      result = evaluateRun({ rule: contract.rule, rows: engineRows, aggregationMode: contract.aggregationMode, allowedModels });
    } catch (e) {
      warnings.push(`"${contract.merchantName}" calculation error: ${e.message}`);
      continue;
    }

    ruleSnapshots[contractId] = contract.rule;
    results.push({
      contractId,
      merchantName: contract.merchantName,
      currency: contract.currency,
      merchantCount: merchantRows.length,
      rentals: merchantRows.reduce((s, m) => s + m.rentals, 0),
      revenue: merchantRows.reduce((s, m) => s + m.revenue, 0),
      payout: result.totalPayout,
      merchants: merchantRows,
      engineResult: result
    });
  }
```

In the `bulkRun` object, rename `partnerCount` to `merchantBrandCount` (same value, `results.length`), and add `ruleHasValue` to the `payout.mjs` import.

- [ ] **Step 7: Update `prepareBulkRunRoute`'s response**

It currently returns `partnersNeedingRules`. Return `merchantsNeedingTerms` and `newMerchants` instead, keeping `rosterCount`, `unassigned`, and renaming `partnerCount` to `merchantBrandCount`.

- [ ] **Step 8: Verify and deploy**

```bash
npm test 2>&1 | grep -E "^. (pass|fail)"
node -e "import('./lambda/revshare-api/code/index.mjs').then(()=>console.log('OK')).catch(e=>{console.error(e.message);process.exit(1)})"
AWS_DEFAULT_OUTPUT=json ./infra/deploy-lambda-all.sh
curl -sS https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod/healthz
curl -sS https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod/healthz
```
Expected: `pass 110`, `OK`, both `{"ok":true}`. **Both** health checks are mandatory.

- [ ] **Step 9: Commit**

```bash
git add lambda/revshare-api/code/routes/bulk-runs.mjs lambda/revshare-api/tests/bulk-runs.test.mjs
git commit -m "feat(bulk-runs): resolve roster labels to merchant-view rows and evaluate their terms"
```

---

### Task 4: Dual-run comparison

The spec's validation requirement. With no run history, nothing otherwise proves the new
pipeline agrees with the old — and this check is only possible while both paths exist.

**Files:**
- Create: `infra/compare-pipelines.mjs`

**Interfaces:**
- Consumes: `evaluateRun` from `engine.mjs`; `ruleHasValue` from Task 1; migrated data from Task 2.
- Produces: a per-brand payout diff. Nothing downstream depends on it.

- [ ] **Step 1: Write the comparison script**

Create `infra/compare-pipelines.mjs`:

```js
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
```

- [ ] **Step 2: Run it**

```bash
AWS_DEFAULT_OUTPUT=json node infra/compare-pipelines.mjs --table RevsharePartner --region ap-southeast-7
```
Expected: `DIFFERENT: 0` and exit code 0. **Any difference stops the plan** — report the list rather than continuing; it means a rule or aggregation mode did not copy faithfully.

- [ ] **Step 3: Commit**

```bash
git add infra/compare-pipelines.mjs
git commit -m "test(migration): dual-run payout comparison between partner and contract paths"
```

---

### Task 5: Merchant view dialog writes contracts

**Files:**
- Modify: `frontend/app.js` — `openPartnerEditor`, `termPartner`, `termCellHtml`, `renderContractsScreen`
- Modify: `frontend/service-worker.js`

**Interfaces:**
- Consumes: contract rows carrying `rule`/`aggregationMode`/`noPayout` (Task 2); `PUT /contracts/:id` accepting them (Task 2 Step 1).
- Produces: a Merchant view that never reads `PARTNERS_BY_ID`. Task 7 removes that cache.

- [ ] **Step 1: Read terms from the contract**

Replace `termPartner` and the top of `termCellHtml` so terms come from the row itself:

```js
// The merchant-view row owns its terms. PARTNERS_BY_ID is no longer consulted.
function termCellHtml(c, col) {
  const sub = col.key.split('.')[1];
  if (c.noPayout) return '<span class="ct-none" title="Not paid — skipped in revenue-share runs">None</span>';
  if (ruleIsAbsent(c.rule)) {
    return sub === 'method' ? '<span class="ct-empty">–</span>' : '<span class="muted" title="No terms set yet">not set</span>';
  }
  if (!isRepresentable(c.rule)) {
    return sub === 'method'
      ? '<span class="ct-locked" title="A rule shape the simplified form cannot label">custom</span>'
      : '<span class="ct-terms ct-locked" title="Click for the full breakdown">custom rule ›</span>';
  }
  const f = decompileRule(c.rule);
  if (sub === 'method') return escape(methodToName(f.method));
  return `<span class="ct-terms" title="Click for the full breakdown">${escape(payoutFormula(f))}</span>`;
}
```

Delete `termPartner` — nothing else calls it.

- [ ] **Step 2: Point the dialog at the contract**

In `openPartnerEditor`, replace every partner read/write with the contract. The save becomes one call:

```js
      const saved = await api('/contracts/' + encodeURIComponent(contractId), { method: 'PUT',
        body: JSON.stringify({ rule, noPayout: nopay.checked, aggregationMode: agg.value }) });
      Object.assign(c, saved);
      close(); paintContracts();
```

and the initial values come from `c.rule`, `c.aggregationMode`, `c.noPayout`. Rename the function to `openTermsEditor` and update its two call sites. Remove the partner-creation branch entirely — a merchant view row needs no partner.

- [ ] **Step 3: Point the read-only view at the contract**

In `openTermsView`, replace `termPartner(c)` with `c` and render `c.rule`. Drop the partner name from the subtitle; it now reads `Revenue-share terms`.

- [ ] **Step 4: Stop fetching partners**

In `renderContractsScreen`, drop `api('/partners')` from the `Promise.all` and remove the `PARTNERS_BY_ID` assignment. Keep `/machine-models` — the rule editor needs it.

- [ ] **Step 5: Replace the Partner column with a terms button**

The last column no longer shows a partner. Header becomes `Edit terms`; the cell is one button:

```js
  const editCell = can('manageMerchants')
    ? `<button class="btn-ghost ct-pe-btn" data-id="${escape(c.contractId)}">${ruleIsAbsent(c.rule) && !c.noPayout ? 'Set terms…' : 'Edit…'}</button>`
    : '';
```

- [ ] **Step 6: Verify and deploy**

```bash
node --check frontend/app.js && node --check frontend/service-worker.js
npm test 2>&1 | grep -E "^. (pass|fail)"
AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```
Bump `CACHE_VERSION` to `revshare-v101` first. Backend tests must stay at 110.

Report the browser checks as **PENDING (needs human)**: open Merchant view, confirm Mode and Rev terms still populate for 7-Eleven, open Edit and confirm its three MG rows and `per_store` are shown, save without changing anything and confirm the row is unchanged.

- [ ] **Step 7: Commit**

```bash
git add frontend/app.js frontend/service-worker.js
git commit -m "feat(merchant-view): terms live on the merchant row, not a partner"
```

---

### Task 6: Run wizard and analytics rekeyed

**Files:**
- Modify: `frontend/app.js` — the run wizard's step 3, the bulk-run detail table, `renderRevsharePathScreen`
- Modify: `frontend/service-worker.js`

**Interfaces:**
- Consumes: `merchantsNeedingTerms` from `POST /bulk-runs/prepare`; run results carrying `contractId`/`merchantName` (Task 3).
- Produces: nothing downstream.

- [ ] **Step 1: Rekey the wizard's readiness step**

`wiz.prepare?.partnersNeedingRules` becomes `wiz.prepare?.merchantsNeedingTerms`, and each entry is `{ contractId, name }`. The inline editor that used to open a partner's rule now opens the Merchant view's terms dialog for that `contractId`; the step-4 lock still requires the list to be empty.

- [ ] **Step 2: Rekey the run detail table**

Every `r.partnerName` becomes `r.merchantName` and `r.partnerId` becomes `r.contractId`, in the results table, the per-partner CSV zip filenames and the PDF statement. The zip name stays `<year>_<month>_revshare.zip`.

- [ ] **Step 3: Rekey analytics**

In `renderRevsharePathScreen`, `partnerSeries[r.partnerName]` becomes `series[r.merchantName]`. The "Total (all partners)" option becomes "Total (all merchants)".

- [ ] **Step 4: Verify and deploy**

```bash
node --check frontend/app.js && npm test 2>&1 | grep -E "^. (pass|fail)"
AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```
Bump `CACHE_VERSION` to `revshare-v102`.

Report as **PENDING (needs human)**: run the wizard as far as step 3 with the real roster and confirm the merchants-needing-terms list appears and links to the Merchant view.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/service-worker.js
git commit -m "feat(run-share): wizard and analytics key on merchants, not partners"
```

---

### Task 7: Remove the Partners page

**Files:**
- Modify: `frontend/app.js` — `renderNav`, and delete `renderPartnersList`, `renderPartnerDetail` and the new-partner form
- Modify: `frontend/service-worker.js`

- [ ] **Step 1: Drop the nav entry**

Remove the Partners button and its click handler from `renderNav`. Merchant view is already the landing screen.

- [ ] **Step 2: Delete the screens**

Delete `renderPartnersList`, `renderPartnerDetail`, the new-partner form and any helper used only by them. `renderStructuredRuleEditor` **must stay** — the Merchant view dialog uses it. So must `compileRule`, `decompileRule`, `payoutFormula`, `methodToName` and `PAYOUT_METHOD_META`.

- [ ] **Step 3: Prove nothing dangles**

```bash
node --check frontend/app.js
for f in renderPartnersList renderPartnerDetail PARTNERS_BY_ID termPartner openPartnerEditor; do
  echo -n "$f: "; grep -c "$f" frontend/app.js
done
```
Expected: every count `0`. A non-zero count is a live reference to deleted code — fix before continuing.

- [ ] **Step 4: Verify and deploy**

```bash
npm test 2>&1 | grep -E "^. (pass|fail)"
AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```
Bump `CACHE_VERSION` to `revshare-v103`.

Report as **PENDING (needs human)**: load the app, confirm the nav reads Merchant view / Run share / Analytics / Device Types (/ Users for admins), and that no screen 404s.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/service-worker.js
git commit -m "feat(ui): remove the Partners page — the merchant view is the source of truth"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Rewrite the data-model section (§5)**

Replace the row-family table's description so `CONTRACT` is documented as the payout entity carrying `rule`, `aggregationMode`, `noPayout` and `currency`, and `MERCHANT` as carrying `contractId`. State plainly that `PARTNER` rows are **retained but dormant** — nothing reads them, they exist so a migrated rule can be checked against its original.

- [ ] **Step 2: Rewrite the run-flow section (§1b)**

The wizard resolves a roster's `Merchant label` to a Merchant view row, not a partner. Step 3 lists merchants needing terms. The Partners tab no longer exists. Note that the readiness gate now tests that a rule *pays something*, and why: `!rule || !rule.type` passed a bare `percent ALL 0%`, which is how 39 partners could reach a run and be paid nothing.

- [ ] **Step 3: Record what is deliberately unpaid**

Add a short subsection: 65 brands (436 store rows) exist in the store registry with no Merchant view row. They are not paid, by decision on 2026-08-07 — the sheet is authoritative. They are not deleted; they surface in each run's unmatched list.

- [ ] **Step 4: Update the header facts**

`CACHE_VERSION` to whatever `frontend/service-worker.js` actually says, and the test count to whatever `npm test` actually reports. Verify both with commands rather than assuming.

- [ ] **Step 5: Verify**

```bash
grep -n "CACHE_VERSION" frontend/service-worker.js && npm test 2>&1 | grep -E "^. (pass|fail)"
```
Both must match what CLAUDE.md now claims.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: merchant view is the payout entity; partners dormant"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4 contract gains rule/aggregationMode/noPayout/currency | Task 2 Step 1 |
| §4 store rows gain contractId | Task 2 Step 2 |
| §5 idempotent migration, writes only absent fields | Task 2 Steps 2–4 |
| §5 asserts one contract per partner | Task 2 Step 2 (abort branch) |
| §6 roster resolves label → contract | Task 3 Step 5 |
| §6 readiness tests that a rule pays something | Task 1 + Task 3 Steps 5–6 |
| §6 evaluation from the contract; engine unchanged | Task 3 Step 6 |
| §3 the 436 are not deleted and surface as unmatched | Task 3 Step 3 + Task 8 Step 3 |
| §3 partner rows and routes kept dormant | Global Constraints; Task 7 removes UI only |
| §3 per-partner single-run flow goes | Task 7 Step 2 |
| §7 dialog writes the contract | Task 5 |
| §7 wizard + analytics rekeyed | Task 6 |
| §7 Partners page removed | Task 7 |
| §8 dual-run comparison | Task 4 |

**Placeholder scan:** no TBD/TODO; every code step carries a full body; no "similar to Task N".

**Type consistency:** `contractId`, `merchantName`, `merchantsNeedingTerms`, `newMerchants`, `merchantBrandCount`, `ruleHasValue`, `contractNeedsTerms`, `indexContractsByName`, `resolveLabel` are spelled identically across Tasks 1, 3, 6 and 8. `buildRosterRows` returns `groups` keyed by `contractId` in Task 3 and is consumed as such in the same task's Step 6.

**Ordering risk worth stating:** Task 4's comparison only works while both paths exist, so it **must** run before Task 7 deletes the UI, and after Task 2 migrates. The task order enforces this; do not reorder.

**Known gap:** nothing here verifies the run against a real period, because no period has ever been run. Task 4 compares the two paths against each other on synthetic revenue — it proves the migration was faithful, not that the pipeline is correct. The first real run remains the first real test.
