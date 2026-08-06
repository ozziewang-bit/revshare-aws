# Contracts Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Contracts tab holding one flat, fully editable table of every merchant's contract terms, seeded by uploading the `All_Merchant` sheet.

**Architecture:** A new `CONTRACT` row family in the existing DynamoDB table, a pure normalizer/matcher module the backend can unit-test, thin CRUD + import routes following the existing `merchants.mjs` shape, and a single-screen frontend grid. The xlsx is parsed in the browser into raw positional cell arrays and normalized on the backend, so every messy coercion rule is covered by `node:test`. No engine change, no migration.

**Tech Stack:** Node 22 ES modules, `node:test` + `node:assert`, DynamoDB via `@aws-sdk/lib-dynamodb`, vanilla browser JS with the self-hosted SheetJS (`XLSX`) already in `frontend/lib/`.

**Spec:** `docs/superpowers/specs/2026-08-06-contracts-register-design.md`

## Global Constraints

- **The importer writes contract fields only.** The sheet's `Share mode`, `Rev-share %`, `Fixed monthly rental`, `Electricity` and `Minimum guarantee` are parsed for preview display but **never written to any partner rule**. This is the load-bearing constraint of the whole feature — 7-Eleven's sheet row says `MG 0` while the app holds `S8=200, S5=150` with `per_store`, and an importer that wrote terms would take the `0`.
- **No change to `lambda/revshare-api/code/engine.mjs`.** The engine stays a pure tree evaluator (CLAUDE.md §7.4).
- **Share-term edits go through the existing `compileRule` in `frontend/app.js`.** Do not write a second rule compiler. One code path, so the grid and the Rule tab cannot drift.
- **Dropped columns, do not build inputs for them:** `A` (`No` — `#NAME?` in all 208 rows), `P` (`COC Clause` — empty in all 208), `V` (unlabeled — empty or `0` in all 208).
- **Sheet models `LL20`/`LL40` normalise to `L20`/`L40`.** The five model columns carried are `S5, S8, M10, L20, L40`, stored in an open map so more can be added without migration.
- **Bump `frontend/service-worker.js` `CACHE_VERSION`** on every shell change (currently `revshare-v73` → `revshare-v74`).
- **No `Co-Authored-By:` trailers in commit messages** (CLAUDE.md §7.3).
- **Prefix AWS CLI calls with `AWS_DEFAULT_OUTPUT=json`** — the user's `~/.aws/config` sets `output=none`.
- **Local commits per task are fine; do not `git push`** until the user says "save progress" (CLAUDE.md §7.1).

**Observation, not a task:** the sheet has an `M10` column and `engine.mjs` `MACHINE_MODELS` includes `M10`, but `frontend/app.js:216` `RS_MODELS` and `lambda/revshare-api/code/routes/merchants.mjs:3` `VALID_MODELS` both omit it. Contract unit counts are plain numbers and are not validated against either list, so nothing here is blocked. Do not widen scope to fix it.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lambda/revshare-api/code/contracts.mjs` | **New.** Pure normalizer + name matcher. No AWS imports. | Create |
| `lambda/revshare-api/tests/contracts.test.mjs` | **New.** Tests for the above. | Create |
| `lambda/revshare-api/code/db.mjs` | DynamoDB wrappers | Add 4 contract helpers |
| `lambda/revshare-api/code/routes/contracts.mjs` | **New.** CRUD + import routes. | Create |
| `lambda/revshare-api/code/index.mjs` | Route dispatch | Wire 6 routes |
| `lambda/revshare-api/code/auth.mjs` | Permission resolver | One line for `/contracts` |
| `lambda/revshare-api/tests/auth.test.mjs` | Permission tests | Add `/contracts` cases |
| `frontend/app.js` | SPA | Nav button + contracts screen + sheet reader |
| `frontend/style.css` | Styles | Grid / frozen column / popover |
| `frontend/service-worker.js` | PWA shell cache | Bump `CACHE_VERSION` |
| `CLAUDE.md` | Handoff doc | Document the tab, routes, row family |

---

### Task 1: Contract normalizer and name matcher (pure)

The browser hands the backend raw positional cell arrays straight off the sheet. All
coercion — dates, booleans, model-name normalisation, blank handling — happens here,
in a module with no AWS imports, so it is fully unit-testable.

**Files:**
- Create: `lambda/revshare-api/code/contracts.mjs`
- Test: `lambda/revshare-api/tests/contracts.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, relied on by Tasks 3 and 7:
  - `CONTRACT_COLUMNS` — frozen array of 23 column keys in sheet order.
  - `normalizeContractRow(cells)` → contract object or `null` when the row has no
    merchant name. Shape:
    `{ merchantName, merchantType, counterParty, installedUnits, units: {S5,S8,M10,L20,L40},
       startDate, endDate, terminationNoticeDays, declineToRenew, autoRenewal,
       contractLink, sheetTerms: { shareMode, revSharePct, fixedRental, electricity, minGuarantee } }`
    Dates are `YYYY-MM-DD` strings or `null`. `sheetTerms` is **preview-only** and is
    never persisted onto a rule.
  - `matchContracts(rows, partners)` → `{ matched: [{row, partnerId, partnerName}], unmatched: [row] }`,
    matching on lowercased trimmed name.

- [ ] **Step 1: Write the failing tests**

Create `lambda/revshare-api/tests/contracts.test.mjs`:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CONTRACT_COLUMNS, normalizeContractRow, matchContracts } from '../code/contracts.mjs';

// Sheet order: No, Merchant, Type, CounterParty, Units, S5, S8, M10, LL20, LL40,
//              Start, End, Notice, DeclineRenew, AutoRenewal, COC, Mode, Pct,
//              Fixed, Elec, MinGuarantee, V, Link
const row = (over = {}) => {
  const c = new Array(23).fill(null);
  c[1] = 'BITEC'; c[2] = 'Exhibition Center'; c[3] = 'บริษัท ปรินทร จำกัด';
  c[4] = 8; c[6] = 8;
  c[10] = '2025-08-21T00:00:00.000Z'; c[11] = '2026-08-20T00:00:00.000Z';
  c[12] = 30; c[13] = false; c[14] = 'No (Need to contact)';
  c[16] = 'hybrid'; c[17] = 0.2; c[18] = 8800; c[19] = 0; c[20] = 0;
  c[22] = 'https://drive.google.com/drive/folders/1dz';
  for (const [k, v] of Object.entries(over)) c[Number(k)] = v;
  return c;
};

test('CONTRACT_COLUMNS has 23 entries in sheet order', () => {
  assert.equal(CONTRACT_COLUMNS.length, 23);
  assert.equal(CONTRACT_COLUMNS[1], 'merchantName');
  assert.equal(CONTRACT_COLUMNS[22], 'contractLink');
});

test('normalizeContractRow maps a full row', () => {
  const c = normalizeContractRow(row());
  assert.equal(c.merchantName, 'BITEC');
  assert.equal(c.merchantType, 'Exhibition Center');
  assert.equal(c.counterParty, 'บริษัท ปรินทร จำกัด');
  assert.equal(c.installedUnits, 8);
  assert.equal(c.units.S8, 8);
  assert.equal(c.startDate, '2025-08-21');
  assert.equal(c.endDate, '2026-08-20');
  assert.equal(c.terminationNoticeDays, 30);
  assert.equal(c.declineToRenew, false);
  assert.equal(c.autoRenewal, 'No (Need to contact)');
  assert.equal(c.contractLink, 'https://drive.google.com/drive/folders/1dz');
});

test('normalizeContractRow keeps sheet terms separate and never as a rule', () => {
  const c = normalizeContractRow(row());
  assert.equal(c.sheetTerms.shareMode, 'hybrid');
  assert.equal(c.sheetTerms.revSharePct, 0.2);
  assert.equal(c.sheetTerms.fixedRental, 8800);
  assert.equal(c.rule, undefined);
  assert.equal(c.gpPercent, undefined);
});

test('normalizeContractRow returns null when merchant name is blank', () => {
  assert.equal(normalizeContractRow(row({ 1: null })), null);
  assert.equal(normalizeContractRow(row({ 1: '   ' })), null);
});

test('normalizeContractRow normalises LL20/LL40 to L20/L40', () => {
  const c = normalizeContractRow(row({ 8: 4, 9: 3 }));
  assert.equal(c.units.L20, 4);
  assert.equal(c.units.L40, 3);
});

test('normalizeContractRow treats blank numbers as null, not zero', () => {
  const c = normalizeContractRow(row({ 4: null, 12: null }));
  assert.equal(c.installedUnits, null);
  assert.equal(c.terminationNoticeDays, null);
});

test('normalizeContractRow accepts Excel serial dates', () => {
  // 45890 = 2025-08-21 in the 1900 date system
  const c = normalizeContractRow(row({ 10: 45890 }));
  assert.equal(c.startDate, '2025-08-21');
});

test('normalizeContractRow coerces truthy/falsy declineToRenew', () => {
  assert.equal(normalizeContractRow(row({ 13: true })).declineToRenew, true);
  assert.equal(normalizeContractRow(row({ 13: 'TRUE' })).declineToRenew, true);
  assert.equal(normalizeContractRow(row({ 13: null })).declineToRenew, false);
});

test('normalizeContractRow ignores the three dead columns', () => {
  const c = normalizeContractRow(row({ 0: '#NAME?', 15: 'x', 21: 0 }));
  assert.equal(c.no, undefined);
  assert.equal(c.cocClause, undefined);
  assert.equal(JSON.stringify(c).includes('#NAME?'), false);
});

test('matchContracts links by case-insensitive trimmed name', () => {
  const rows = [
    normalizeContractRow(row({ 1: 'BITEC' })),
    normalizeContractRow(row({ 1: '  7-Eleven ' })),
    normalizeContractRow(row({ 1: 'Big C' })),
  ];
  const partners = [
    { partnerId: 'p1', name: 'bitec' },
    { partnerId: 'p2', name: '7-Eleven' },
    { partnerId: 'p3', name: 'BIG-C' },
  ];
  const { matched, unmatched } = matchContracts(rows, partners);
  assert.equal(matched.length, 2);
  assert.equal(matched.find(m => m.row.merchantName === 'BITEC').partnerId, 'p1');
  assert.equal(matched.find(m => m.row.merchantName === '7-Eleven').partnerId, 'p2');
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].merchantName, 'Big C');   // 'Big C' != 'BIG-C'
});

test('matchContracts handles an empty partner list', () => {
  const { matched, unmatched } = matchContracts([normalizeContractRow(row())], []);
  assert.equal(matched.length, 0);
  assert.equal(unmatched.length, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `Cannot find module '../code/contracts.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `lambda/revshare-api/code/contracts.mjs`:

```js
// Pure contract-sheet normalizer + partner matcher. No AWS imports — unit-tested.
// Source: the `All_Merchant` sheet of the merchant workbook. Two header rows; data
// starts at row 3. The browser sends raw positional cell arrays; every coercion is here.

// Sheet order. `_dead` marks columns that are empty or broken in all 208 rows and are
// deliberately not carried: A (No — #NAME?), P (COC Clause), V (unlabeled).
export const CONTRACT_COLUMNS = Object.freeze([
  '_dead', 'merchantName', 'merchantType', 'counterParty', 'installedUnits',
  'S5', 'S8', 'M10', 'LL20', 'LL40',
  'startDate', 'endDate', 'terminationNoticeDays', 'declineToRenew', 'autoRenewal',
  '_dead', 'shareMode', 'revSharePct', 'fixedRental', 'electricity', 'minGuarantee',
  '_dead', 'contractLink',
]);

const str = v => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};
const num = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = v => v === true || String(v).trim().toLowerCase() === 'true';

// Excel's 1900 date system, with its deliberate leap-year bug: serial 60 is the
// non-existent 1900-02-29, so serials above it are one day ahead of the true count.
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    return new Date(EXCEL_EPOCH_UTC + Math.round(v) * 86400000).toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function normalizeContractRow(cells) {
  const at = i => (Array.isArray(cells) ? cells[i] : undefined);
  const merchantName = str(at(1));
  if (!merchantName) return null;   // blank name => not a merchant row

  const units = {};
  for (const [i, model] of [[5, 'S5'], [6, 'S8'], [7, 'M10'], [8, 'L20'], [9, 'L40']]) {
    const n = num(at(i));
    if (n != null) units[model] = n;
  }

  return {
    merchantName,
    merchantType: str(at(2)),
    counterParty: str(at(3)),
    installedUnits: num(at(4)),
    units,
    startDate: toDate(at(10)),
    endDate: toDate(at(11)),
    terminationNoticeDays: num(at(12)),
    declineToRenew: bool(at(13)),
    autoRenewal: str(at(14)),
    contractLink: str(at(22)),
    // Preview only. Never written to a partner rule — see the plan's Global Constraints.
    sheetTerms: {
      shareMode: str(at(16)),
      revSharePct: num(at(17)),
      fixedRental: num(at(18)),
      electricity: num(at(19)),
      minGuarantee: num(at(20)),
    },
  };
}

const key = s => String(s || '').toLowerCase().trim();

export function matchContracts(rows, partners) {
  const byName = new Map((partners || []).map(p => [key(p.name), p]));
  const matched = [], unmatched = [];
  for (const row of rows || []) {
    if (!row) continue;
    const p = byName.get(key(row.merchantName));
    if (p) matched.push({ row, partnerId: p.partnerId, partnerName: p.name });
    else unmatched.push(row);
  }
  return { matched, unmatched };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 79`, `fail 0` (68 existing + 11 new).

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/contracts.mjs lambda/revshare-api/tests/contracts.test.mjs
git commit -m "feat(contracts): pure sheet normalizer + partner name matcher"
```

---

### Task 2: Contract storage and CRUD routes

Follows the `merchants.mjs` shape exactly — same `pk`/`sk` convention, same
`resp()` helper, same partial-merge update.

**Files:**
- Modify: `lambda/revshare-api/code/db.mjs` (add after the merchant helpers, ~line 111)
- Create: `lambda/revshare-api/code/routes/contracts.mjs`
- Modify: `lambda/revshare-api/code/index.mjs` (imports + dispatch chain)
- Modify: `lambda/revshare-api/code/auth.mjs:30` area (permission resolver)
- Test: `lambda/revshare-api/tests/auth.test.mjs`

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces, relied on by Task 3 and the frontend tasks:
  - `db.mjs`: `listContracts()`, `getContract(contractId)`, `putContract(contract)`,
    `deleteContract(contractId)`. Rows are `pk: 'CONTRACT'`, `sk: 'CONTRACT#<id>'`,
    with `merchantNameLower`, `createdAt`, `updatedAt` stamped by `putContract`.
  - `routes/contracts.mjs`: `listContractsRoute()`, `createContractRoute(event)`,
    `updateContractRoute(event)`, `deleteContractRoute(event)`.
  - Routes: `GET/POST /contracts`, `PUT/DELETE /contracts/:contractId`.
  - Writes require `manageMerchants`.

- [ ] **Step 1: Write the failing permission tests**

Append to `lambda/revshare-api/tests/auth.test.mjs`:

```js
test('requiredPermission: contract reads are open', () => {
  assert.equal(requiredPermission('GET', '/contracts'), null);
  assert.equal(requiredPermission('GET', '/contracts/abc'), null);
});

test('requiredPermission: contract writes need manageMerchants', () => {
  assert.equal(requiredPermission('POST', '/contracts'), 'manageMerchants');
  assert.equal(requiredPermission('PUT', '/contracts/abc'), 'manageMerchants');
  assert.equal(requiredPermission('DELETE', '/contracts/abc'), 'manageMerchants');
  assert.equal(requiredPermission('POST', '/contracts/import'), 'manageMerchants');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `/contracts` currently falls through to the fail-closed `'admin'`.

- [ ] **Step 3: Add the permission rule**

In `lambda/revshare-api/code/auth.mjs`, in `requiredPermission`, add immediately
**after** the `/merchants` line (order matters — it must precede the fail-closed
`return 'admin'`):

```js
  if (path.startsWith('/contracts')) return 'manageMerchants';
```

- [ ] **Step 4: Run to verify the permission tests pass**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 83`, `fail 0`.

- [ ] **Step 5: Add the db helpers**

In `lambda/revshare-api/code/db.mjs`, after `deleteMerchant` (~line 111), add:

```js
// ── Contracts ─────────────────────────────────────────────────────────────

export async function listContracts() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p',
    ExpressionAttributeValues: { ':p': 'CONTRACT' },
  }));
  return out.Items || [];
}

export async function getContract(contractId) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'CONTRACT', sk: `CONTRACT#${contractId}` }
  }));
  return out.Item || null;
}

export async function putContract(contract) {
  const now = new Date().toISOString();
  const item = {
    pk: 'CONTRACT',
    sk: `CONTRACT#${contract.contractId}`,
    ...contract,
    merchantNameLower: (contract.merchantName || '').toLowerCase().trim(),
    updatedAt: now,
    createdAt: contract.createdAt || now
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
}

export async function deleteContract(contractId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'CONTRACT', sk: `CONTRACT#${contractId}` }
  }));
}
```

- [ ] **Step 6: Create the routes**

Create `lambda/revshare-api/code/routes/contracts.mjs`:

```js
import { listContracts, getContract, putContract, deleteContract, ulid } from '../db.mjs';

// Fields a client may write. `sheetTerms` is import-preview data and is not stored;
// share terms live on the partner's rule, never on the contract row.
const WRITABLE = [
  'merchantName', 'merchantType', 'counterParty', 'partnerId', 'installedUnits',
  'units', 'startDate', 'endDate', 'terminationNoticeDays', 'declineToRenew',
  'autoRenewal', 'contractLink', 'notes',
];

function pick(body) {
  const out = {};
  for (const k of WRITABLE) if (k in body) out[k] = body[k];
  return out;
}

export async function listContractsRoute() {
  const items = await listContracts();
  items.sort((a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  return resp(200, items);
}

export async function createContractRoute(event) {
  const body = JSON.parse(event.body || '{}');
  if (!String(body.merchantName || '').trim()) {
    return resp(400, { error: 'missing_fields', required: ['merchantName'] });
  }
  const contract = { contractId: ulid(), partnerId: null, units: {}, notes: '', ...pick(body) };
  return resp(201, await putContract(contract));
}

export async function updateContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const body = JSON.parse(event.body || '{}');
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  return resp(200, await putContract({ ...existing, ...pick(body), contractId: id }));
}

export async function deleteContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const existing = await getContract(id);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteContract(id);
  return resp(204, null);
}

function resp(statusCode, body) {
  return { statusCode, body: body === null ? '' : JSON.stringify(body) };
}
```

- [ ] **Step 7: Wire the routes**

In `lambda/revshare-api/code/index.mjs`, add to the imports near the `merchants.mjs`
import block (~line 20):

```js
import {
  listContractsRoute, createContractRoute, updateContractRoute, deleteContractRoute,
} from './routes/contracts.mjs';
```

Add to the dispatch chain immediately after the `/merchants` block (~line 77):

```js
    else if (method === 'GET'    && path === '/contracts')                                     result = await listContractsRoute();
    else if (method === 'POST'   && path === '/contracts')                                     result = await createContractRoute(event);
    else if (method === 'PUT'    && /^\/contracts\/[^/]+$/.test(path))                        result = await routeContract(event, updateContractRoute);
    else if (method === 'DELETE' && /^\/contracts\/[^/]+$/.test(path))                        result = await routeContract(event, deleteContractRoute);
```

And add the path-parameter helper next to `routeMerchant` (~line 126):

```js
function routeContract(event, handler) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/contracts\/([^/]+)/);
  return handler({ ...event, pathParameters: { contractId: m ? m[1] : null } });
}
```

- [ ] **Step 8: Verify the module loads and tests pass**

Run:
```bash
node -e "import('./lambda/revshare-api/code/index.mjs').then(()=>console.log('index OK')).catch(e=>{console.error(e);process.exit(1)})" && npm test 2>&1 | grep -E "^. (pass|fail)"
```
Expected: `index OK`, then `pass 83`, `fail 0`.

- [ ] **Step 9: Commit**

```bash
git add lambda/revshare-api/code/db.mjs lambda/revshare-api/code/routes/contracts.mjs \
        lambda/revshare-api/code/index.mjs lambda/revshare-api/code/auth.mjs \
        lambda/revshare-api/tests/auth.test.mjs
git commit -m "feat(contracts): CONTRACT row family + CRUD routes"
```

---

### Task 3: Import route

Bulk upsert from the parsed sheet. Matches on `merchantNameLower` so re-import
updates in place rather than duplicating, and **never touches a partner rule**.

**Files:**
- Modify: `lambda/revshare-api/code/routes/contracts.mjs`
- Modify: `lambda/revshare-api/code/index.mjs` (one dispatch line)
- Test: `lambda/revshare-api/tests/contracts.test.mjs`

**Interfaces:**
- Consumes: `normalizeContractRow`, `matchContracts` from Task 1;
  `listContracts`, `putContract` from Task 2.
- Produces: `POST /contracts/import`, body
  `{ rows: [[...23 cells...], ...], links: { "<merchantNameLower>": "<partnerId>|null" } }`,
  returning `{ created, updated, linked, unmatched: [names] }`.
  `buildImportPlan(normalizedRows, existingContracts, partners, links)` is exported
  pure so it can be tested without DynamoDB.

- [ ] **Step 1: Write the failing tests**

Append to `lambda/revshare-api/tests/contracts.test.mjs`:

```js
import { buildImportPlan } from '../code/contracts.mjs';

const mk = (name, over = {}) => ({
  merchantName: name, merchantType: null, counterParty: null, installedUnits: null,
  units: {}, startDate: null, endDate: null, terminationNoticeDays: null,
  declineToRenew: false, autoRenewal: null, contractLink: null,
  sheetTerms: { shareMode: 'hybrid', revSharePct: 0.5, fixedRental: 0, electricity: 0, minGuarantee: 0 },
  ...over,
});

test('buildImportPlan creates contracts for new merchants', () => {
  const plan = buildImportPlan([mk('BITEC')], [], [{ partnerId: 'p1', name: 'BITEC' }], {});
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.creates[0].merchantName, 'BITEC');
  assert.equal(plan.creates[0].partnerId, 'p1');
});

test('buildImportPlan updates an existing contract in place, keeping its id', () => {
  const existing = [{ contractId: 'c1', merchantNameLower: 'bitec', merchantName: 'BITEC', notes: 'keep me' }];
  const plan = buildImportPlan([mk('BITEC', { counterParty: 'Prinn Co' })], existing, [], {});
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].contractId, 'c1');
  assert.equal(plan.updates[0].counterParty, 'Prinn Co');
  assert.equal(plan.updates[0].notes, 'keep me');   // fields not in the sheet survive
});

test('buildImportPlan NEVER emits rule or share-term fields', () => {
  const plan = buildImportPlan([mk('7-Eleven')], [], [{ partnerId: 'p2', name: '7-Eleven' }], {});
  const written = JSON.stringify(plan.creates[0]);
  for (const k of ['rule', 'sheetTerms', 'shareMode', 'revSharePct', 'minGuarantee',
                   'gpPercent', 'electricity', 'mgRows', 'aggregationMode']) {
    assert.equal(written.includes(k), false, `import must not write ${k}`);
  }
});

test('buildImportPlan honours explicit link overrides for unmatched names', () => {
  const plan = buildImportPlan([mk('Big C')], [], [{ partnerId: 'p3', name: 'BIG-C' }],
                               { 'big c': 'p3' });
  assert.equal(plan.creates[0].partnerId, 'p3');
  assert.equal(plan.unmatched.length, 0);
});

test('buildImportPlan reports unmatched names with no override', () => {
  const plan = buildImportPlan([mk('Big C')], [], [{ partnerId: 'p3', name: 'BIG-C' }], {});
  assert.equal(plan.creates[0].partnerId, null);
  assert.deepEqual(plan.unmatched, ['Big C']);
});

test('buildImportPlan skips null rows', () => {
  const plan = buildImportPlan([null, mk('BITEC'), null], [], [], {});
  assert.equal(plan.creates.length, 1);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL — `buildImportPlan is not exported`.

- [ ] **Step 3: Add `buildImportPlan` to `contracts.mjs`**

Append to `lambda/revshare-api/code/contracts.mjs`:

```js
// Turn normalized sheet rows into create/update sets. Pure — no IO, so it is unit-tested.
// `links` maps a lowercased sheet merchant name to a partnerId the user picked in the
// review step, for names that did not match automatically.
// Share terms are deliberately absent from everything this returns.
export function buildImportPlan(rows, existingContracts, partners, links = {}) {
  const byName = new Map((partners || []).map(p => [key(p.name), p]));
  const byContract = new Map((existingContracts || []).map(c => [c.merchantNameLower, c]));
  const creates = [], updates = [], unmatched = [];

  for (const row of rows || []) {
    if (!row) continue;
    const k = key(row.merchantName);
    const override = Object.prototype.hasOwnProperty.call(links, k) ? links[k] : undefined;
    const auto = byName.get(k);
    const partnerId = override !== undefined ? override : (auto ? auto.partnerId : null);
    if (partnerId == null && override === undefined && !auto) unmatched.push(row.merchantName);

    const { sheetTerms, ...contractFields } = row;   // drop preview-only terms
    const existing = byContract.get(k);
    if (existing) updates.push({ ...existing, ...contractFields, partnerId });
    else creates.push({ ...contractFields, partnerId, notes: '' });
  }
  return { creates, updates, unmatched };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 89`, `fail 0`.

- [ ] **Step 5: Add the import route**

Append to `lambda/revshare-api/code/routes/contracts.mjs` (and extend its import line
to pull in `listPartners` and the two pure helpers):

```js
// at the top, replace the existing import line with:
import { listContracts, getContract, putContract, deleteContract, listPartners, ulid } from '../db.mjs';
import { normalizeContractRow, buildImportPlan } from '../contracts.mjs';
```

```js
export async function importContractsRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) return resp(400, { error: 'no_rows' });

  const normalized = rawRows.map(normalizeContractRow).filter(Boolean);
  const [existing, partners] = await Promise.all([listContracts(), listPartners()]);
  const plan = buildImportPlan(normalized, existing, partners, body.links || {});

  // Bounded concurrency — 208 rows would otherwise open 208 sockets at once.
  const all = [...plan.creates.map(c => ({ ...c, contractId: ulid() })), ...plan.updates];
  for (let i = 0; i < all.length; i += 10) {
    await Promise.all(all.slice(i, i + 10).map(putContract));
  }

  return resp(200, {
    created: plan.creates.length,
    updated: plan.updates.length,
    linked: all.filter(c => c.partnerId).length,
    unmatched: plan.unmatched,
  });
}
```

- [ ] **Step 6: Wire it**

In `lambda/revshare-api/code/index.mjs`, add `importContractsRoute` to the contracts
import block, and add this dispatch line **before** the `/^\/contracts\/[^/]+$/` PUT
and DELETE lines so `import` is not read as a contractId:

```js
    else if (method === 'POST'   && path === '/contracts/import')                              result = await importContractsRoute(event);
```

- [ ] **Step 7: Verify**

Run:
```bash
node -e "import('./lambda/revshare-api/code/index.mjs').then(()=>console.log('index OK')).catch(e=>{console.error(e);process.exit(1)})" && npm test 2>&1 | grep -E "^. (pass|fail)"
```
Expected: `index OK`, `pass 89`, `fail 0`.

- [ ] **Step 8: Deploy the backend and smoke-test**

```bash
AWS_DEFAULT_OUTPUT=json ./infra/deploy-lambda-all.sh
curl -sS https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod/healthz
```
Expected: both functions deployed, `{"ok":true}`.

- [ ] **Step 9: Commit**

```bash
git add lambda/revshare-api/code/contracts.mjs lambda/revshare-api/code/routes/contracts.mjs \
        lambda/revshare-api/code/index.mjs lambda/revshare-api/tests/contracts.test.mjs
git commit -m "feat(contracts): import route, contract fields only — never writes rules"
```

---

### Task 4: Contracts tab — read-only grid

Ship something viewable before making it editable. Nav button, fetch, wide table
with a frozen first column, search, type filter, and sort by contract end date.

**Files:**
- Modify: `frontend/app.js` — `renderNav` (~line 440), plus a new
  `renderContractsScreen()` next to `renderDeviceTypesScreen` (~line 537)
- Modify: `frontend/style.css`
- Modify: `frontend/service-worker.js` (`CACHE_VERSION` → `revshare-v74`)

**Interfaces:**
- Consumes: `GET /contracts` from Task 2.
- Produces, relied on by Tasks 5–7: module-scope `let CONTRACTS = []` cache;
  `renderContractsScreen()`; `contractRowHtml(c)` returning one `<tr>`;
  `CONTRACT_GRID_COLUMNS` — the ordered column descriptor array
  `[{ key, label, type, width }]` used by both the header and the row renderer.

- [ ] **Step 1: Add the nav button**

In `renderNav()` in `frontend/app.js`, add the button after Device Types and before
Users, and register its handler alongside the others:

```js
    <button id="nav-contracts" class="nav-btn">Contracts</button>
```
```js
  nav.querySelector('#nav-contracts').addEventListener('click', () => { setActiveNav('nav-contracts'); renderContractsScreen(); });
```

- [ ] **Step 2: Add the column descriptors and screen renderer**

Add near the other screen renderers in `frontend/app.js`:

```js
// ── Contracts ──────────────────────────────────────────────────────────────
let CONTRACTS = [];

const CONTRACT_GRID_COLUMNS = [
  { key: 'merchantName',          label: 'Merchant',      type: 'text',   width: 190 },
  { key: 'merchantType',          label: 'Type',          type: 'select', width: 150 },
  { key: 'counterParty',          label: 'Counter party', type: 'text',   width: 220 },
  { key: 'installedUnits',        label: 'Units',         type: 'number', width: 70  },
  { key: 'units.S5',              label: 'S5',            type: 'number', width: 60  },
  { key: 'units.S8',              label: 'S8',            type: 'number', width: 60  },
  { key: 'units.M10',             label: 'M10',           type: 'number', width: 60  },
  { key: 'units.L20',             label: 'L20',           type: 'number', width: 60  },
  { key: 'units.L40',             label: 'L40',           type: 'number', width: 60  },
  { key: 'startDate',             label: 'Start',         type: 'date',   width: 120 },
  { key: 'endDate',               label: 'End',           type: 'date',   width: 120 },
  { key: 'terminationNoticeDays', label: 'Notice (d)',    type: 'number', width: 90  },
  { key: 'declineToRenew',        label: 'Decline',       type: 'bool',   width: 80  },
  { key: 'autoRenewal',           label: 'Auto-renewal',  type: 'select', width: 170 },
  { key: 'contractLink',          label: 'Contract',      type: 'url',    width: 110 },
];

const MERCHANT_TYPES = ['F&B', 'Hospitality', 'Lifestyle', 'Shopping Malls', 'Nightlife',
                        'Exhibition Center', 'Convenience Store', 'other'];
const AUTO_RENEWAL_OPTIONS = ['Yes', 'No (Need to contact)'];

const cellValue = (c, key) => key.includes('.')
  ? (c[key.split('.')[0]] || {})[key.split('.')[1]]
  : c[key];

// Days until the contract ends; null when there is no end date.
function daysToEnd(c) {
  if (!c.endDate) return null;
  return Math.round((new Date(c.endDate) - new Date()) / 86400000);
}

function contractRowHtml(c) {
  const d = daysToEnd(c);
  const cls = d == null ? '' : (d < 0 ? 'ct-expired' : (d <= 60 ? 'ct-soon' : ''));
  const cells = CONTRACT_GRID_COLUMNS.map((col, i) => {
    const v = cellValue(c, col.key);
    let disp;
    if (col.type === 'bool') disp = v ? '✓' : '';
    else if (col.type === 'url') disp = v ? `<a href="${escape(v)}" target="_blank" rel="noopener">open ↗</a>` : '';
    else disp = v == null || v === '' ? '' : escape(String(v));
    const sticky = i === 0 ? ' ct-sticky' : '';
    const flag = col.key === 'endDate' ? ` ${cls}` : '';
    return `<td class="ct-cell${sticky}${flag}" data-id="${escape(c.contractId)}" data-key="${col.key}">${disp}</td>`;
  }).join('');
  const link = c.partnerId ? '' : '<span class="badge badge-warn">unlinked</span>';
  return `<tr data-id="${escape(c.contractId)}">${cells}<td class="ct-cell">${link}</td></tr>`;
}

async function renderContractsScreen() {
  const el = document.getElementById('main');
  el.innerHTML = '<h1>Contracts</h1><p class="muted">Loading…</p>';
  CONTRACTS = await api('/contracts');
  const head = CONTRACT_GRID_COLUMNS
    .map((c, i) => `<th style="min-width:${c.width}px"${i === 0 ? ' class="ct-sticky"' : ''}>${c.label}</th>`)
    .join('') + '<th>Link</th>';
  el.innerHTML = `
    <h1>Contracts</h1>
    <div class="ct-toolbar">
      <input id="ct-search" class="input" placeholder="Search merchant…" style="max-width:240px">
      <select id="ct-type" class="input" style="max-width:200px">
        <option value="">All types</option>
        ${MERCHANT_TYPES.map(t => `<option>${t}</option>`).join('')}
      </select>
      <select id="ct-sort" class="input" style="max-width:200px">
        <option value="name">Sort: merchant</option>
        <option value="end">Sort: contract end</option>
      </select>
      <span class="muted" id="ct-count"></span>
    </div>
    <div class="ct-scroll"><table class="ct-table"><thead><tr>${head}</tr></thead>
      <tbody id="ct-body"></tbody></table></div>`;
  ['ct-search', 'ct-type', 'ct-sort'].forEach(id =>
    el.querySelector('#' + id).addEventListener('input', paintContracts));
  paintContracts();
}

function paintContracts() {
  const q = (document.getElementById('ct-search')?.value || '').toLowerCase().trim();
  const type = document.getElementById('ct-type')?.value || '';
  const sort = document.getElementById('ct-sort')?.value || 'name';
  let rows = CONTRACTS.filter(c =>
    (!q || (c.merchantName || '').toLowerCase().includes(q)) &&
    (!type || c.merchantType === type));
  rows.sort(sort === 'end'
    ? (a, b) => (a.endDate || '9999').localeCompare(b.endDate || '9999')
    : (a, b) => (a.merchantName || '').localeCompare(b.merchantName || ''));
  document.getElementById('ct-body').innerHTML = rows.map(contractRowHtml).join('');
  document.getElementById('ct-count').textContent = `${rows.length} of ${CONTRACTS.length}`;
}
```

- [ ] **Step 3: Add the styles**

Append to `frontend/style.css`:

```css
/* ============ CONTRACTS GRID ============ */
.ct-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
.ct-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; }
.ct-table { border-collapse: separate; border-spacing: 0; font-size: 13px; white-space: nowrap; }
.ct-table th { position: sticky; top: 0; z-index: 2; background: var(--bg-soft, #f5f5f4);
  text-align: left; font-weight: 600; padding: 9px 10px; border-bottom: 1px solid var(--border); }
.ct-cell { padding: 7px 10px; border-bottom: 1px solid var(--border); }
.ct-sticky { position: sticky; left: 0; z-index: 1; background: var(--surface, #fff); }
.ct-table thead .ct-sticky { z-index: 3; background: var(--bg-soft, #f5f5f4); }
.ct-expired { color: #c23434; font-weight: 600; }
.ct-soon { color: #b45309; font-weight: 600; }
```

- [ ] **Step 4: Bump the cache version**

`frontend/service-worker.js:1` → `const CACHE_VERSION = 'revshare-v74';`

- [ ] **Step 5: Verify and deploy**

```bash
node --check frontend/app.js && node --check frontend/service-worker.js && \
AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```
Expected: both parse, deploy succeeds. Then open the site, hard-reload, click
**Contracts** — expect an empty table with headers (nothing imported yet), no console
errors, and the Merchant column staying put while scrolling right.

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js frontend/style.css frontend/service-worker.js
git commit -m "feat(contracts): read-only contracts grid + nav tab; sw v74"
```

---

### Task 5: Inline editing of contract fields

Every contract cell becomes editable in place. Share-term cells arrive in Task 6.

**Files:**
- Modify: `frontend/app.js` — `contractRowHtml`, plus new `startCellEdit` / `saveCell`
- Modify: `frontend/style.css`

**Interfaces:**
- Consumes: `CONTRACT_GRID_COLUMNS`, `CONTRACTS`, `paintContracts` from Task 4;
  `PUT /contracts/:id` from Task 2.
- Produces: `saveCell(contractId, key, value)` → updates the local cache and PUTs.

- [ ] **Step 1: Add the edit handlers**

Add to `frontend/app.js` after `paintContracts`:

```js
// One cell at a time. Click → input; blur or Enter commits; Escape reverts.
function startCellEdit(td) {
  if (td.querySelector('input, select')) return;
  const id = td.dataset.id, key = td.dataset.key;
  const col = CONTRACT_GRID_COLUMNS.find(c => c.key === key);
  if (!col || !can('manageMerchants')) return;
  const c = CONTRACTS.find(x => x.contractId === id);
  const cur = cellValue(c, key);

  let field;
  if (col.type === 'select') {
    const opts = key === 'merchantType' ? MERCHANT_TYPES : AUTO_RENEWAL_OPTIONS;
    field = document.createElement('select');
    field.innerHTML = '<option value=""></option>' +
      opts.map(o => `<option${o === cur ? ' selected' : ''}>${o}</option>`).join('');
  } else if (col.type === 'bool') {
    field = document.createElement('input'); field.type = 'checkbox'; field.checked = !!cur;
  } else {
    field = document.createElement('input');
    field.type = col.type === 'number' ? 'number' : (col.type === 'date' ? 'date' : 'text');
    field.value = cur == null ? '' : String(cur);
  }
  field.className = 'ct-input';
  td.innerHTML = ''; td.appendChild(field); field.focus();

  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const raw = col.type === 'bool' ? field.checked : field.value;
    const val = col.type === 'number' ? (raw === '' ? null : Number(raw))
              : (col.type === 'bool' ? raw : (String(raw).trim() || null));
    await saveCell(id, key, val);
  };
  field.addEventListener('blur', commit);
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); field.blur(); }
    if (e.key === 'Escape') { done = true; paintContracts(); }
  });
}

async function saveCell(contractId, key, value) {
  const c = CONTRACTS.find(x => x.contractId === contractId);
  if (!c) return;
  const before = JSON.parse(JSON.stringify(c));
  if (key.includes('.')) {
    const [obj, sub] = key.split('.');
    c[obj] = { ...(c[obj] || {}) };
    if (value == null) delete c[obj][sub]; else c[obj][sub] = value;
  } else {
    c[key] = value;
  }
  paintContracts();
  try {
    const body = key.includes('.') ? { units: c.units } : { [key]: value };
    await api('/contracts/' + encodeURIComponent(contractId), { method: 'PUT', body: JSON.stringify(body) });
  } catch (err) {
    Object.assign(c, before);
    paintContracts();
    alert('Could not save: ' + err.message);
  }
}
```

- [ ] **Step 2: Wire the click handler**

In `renderContractsScreen`, after `paintContracts();`, add:

```js
  el.querySelector('#ct-body').addEventListener('click', ev => {
    const td = ev.target.closest('td.ct-cell');
    if (td && td.dataset.key) startCellEdit(td);
  });
```

- [ ] **Step 3: Add the input style**

Append to `frontend/style.css`:

```css
.ct-input { width: 100%; min-width: 60px; font: inherit; padding: 3px 5px;
  border: 1px solid var(--accent, #3b5bdb); border-radius: 5px; background: var(--surface, #fff); }
```

- [ ] **Step 4: Verify and deploy**

```bash
node --check frontend/app.js && AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```
Then, in the app: create one contract by hand via the browser console
(`await api('/contracts', {method:'POST', body:JSON.stringify({merchantName:'Test Co'})})`),
reload Contracts, and confirm you can edit its type, dates, notice days and the
Decline checkbox, that values survive a reload, and that Escape reverts.
Delete it afterwards:
`await api('/contracts/<id>', {method:'DELETE'})`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/style.css
git commit -m "feat(contracts): inline cell editing for contract fields"
```

---

### Task 6: Share-term columns

Five more columns, written through the **existing** `compileRule`. MG and Placement
open a per-model popover when the partner holds per-model values, so 7-Eleven's
`S8=200, S5=150` cannot be flattened to one number.

**Files:**
- Modify: `frontend/app.js` — `CONTRACT_GRID_COLUMNS`, `contractRowHtml`,
  `renderContractsScreen`, plus new `termCellHtml` / `openModelPopover` / `saveTerms`
- Modify: `frontend/style.css`

**Interfaces:**
- Consumes: `compileRule(form)` and `decompileRule(rule)` at `frontend/app.js:29`/`:64`
  (do **not** write a second compiler); `PUT /partners/:id`; `GET /partners/:id`.
- Produces: `PARTNERS_BY_ID` — a `Map` of partnerId → partner, loaded alongside
  contracts; `saveTerms(partnerId, patch)` which decompiles the current rule, applies
  the patch, recompiles and PUTs.

- [ ] **Step 1: Load partners with the contracts**

In `renderContractsScreen`, replace the single fetch with both, and cache the map:

```js
  const [contracts, partners] = await Promise.all([api('/contracts'), api('/partners')]);
  CONTRACTS = contracts;
  PARTNERS_BY_ID = new Map(partners.map(p => [p.partnerId, p]));
```

Declare the cache next to `let CONTRACTS = [];`:

```js
let PARTNERS_BY_ID = new Map();
```

- [ ] **Step 2: Add the five term columns**

Append to `CONTRACT_GRID_COLUMNS`, after `contractLink`:

```js
  { key: 'term.method',      label: 'Mode',         type: 'term-mode',  width: 160 },
  { key: 'term.gpPercent',   label: 'Rev-share %',  type: 'term-num',   width: 100 },
  { key: 'term.placement',   label: 'Fixed rental', type: 'term-model', width: 130 },
  { key: 'term.electricity', label: 'Electricity',  type: 'term-num',   width: 100 },
  { key: 'term.mg',          label: 'Min guarantee',type: 'term-model', width: 140 },
```

- [ ] **Step 3: Render term cells from the partner's rule**

Add to `frontend/app.js`:

```js
// Term cells read the partner's stored rule — the contract row never stores share terms.
function termForm(c) {
  const p = c.partnerId ? PARTNERS_BY_ID.get(c.partnerId) : null;
  return p ? decompileRule(p.rule) : null;
}

function termCellHtml(c, col) {
  const f = termForm(c);
  if (!f) return '<span class="muted" title="Link this row to a partner to edit terms">—</span>';
  const sub = col.key.split('.')[1];
  if (sub === 'method') return escape(methodToName(f.method));
  if (sub === 'gpPercent') return f.gpPercent ? escape(String(f.gpPercent)) : '';
  if (sub === 'electricity') return f.electricity ? escape(String(f.electricity)) : '';
  const rows = sub === 'mg' ? (f.mgRows || []) : (f.placementRows || []);
  if (!rows.length) return '';
  if (rows.length === 1 && rows[0].model === 'ALL') return escape(String(rows[0].amount));
  return `<span class="ct-multi">per-machine (${rows.length}) ▾</span>`;
}
```

In `contractRowHtml`, branch on the term columns:

```js
    let disp;
    if (col.type && col.type.startsWith('term-')) disp = termCellHtml(c, col);
    else if (col.type === 'bool') disp = v ? '✓' : '';
```

- [ ] **Step 4: Write terms back through `compileRule`**

Add to `frontend/app.js`:

```js
// Decompile the partner's current rule, apply one change, recompile with the SAME
// compiler the Rule tab uses, and PUT. Never builds a rule tree by hand.
async function saveTerms(partnerId, patch) {
  const p = PARTNERS_BY_ID.get(partnerId);
  if (!p) return;
  const form = { ...decompileRule(p.rule), ...patch };
  const rule = compileRule(form);
  const updated = await api('/partners/' + encodeURIComponent(partnerId),
    { method: 'PUT', body: JSON.stringify({ rule }) });
  PARTNERS_BY_ID.set(partnerId, { ...p, ...updated, rule });
  paintContracts();
}
```

Extend `startCellEdit` — insert this immediately after the `col` lookup, before the
existing `field` construction:

```js
  if (col.type && col.type.startsWith('term-')) {
    if (!c.partnerId) { alert('Link this row to a partner before editing share terms.'); return; }
    const sub = col.key.split('.')[1];
    const f = decompileRule(PARTNERS_BY_ID.get(c.partnerId).rule);
    if (col.type === 'term-model') return openModelPopover(td, c.partnerId, sub, f);
    if (col.type === 'term-mode') {
      const sel = document.createElement('select');
      sel.className = 'ct-input';
      sel.innerHTML = PAYOUT_METHOD_META.map(m =>
        `<option value="${m.val}"${m.val === f.method ? ' selected' : ''}>${m.title}</option>`).join('')
        + '<option value="" disabled>Sliding Scale (not supported yet)</option>';
      td.innerHTML = ''; td.appendChild(sel); sel.focus();
      sel.addEventListener('change', () => saveTerms(c.partnerId, { method: sel.value }));
      sel.addEventListener('blur', () => paintContracts());
      return;
    }
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'ct-input';
    inp.value = sub === 'gpPercent' ? (f.gpPercent || '') : (f.electricity || '');
    td.innerHTML = ''; td.appendChild(inp); inp.focus();
    let saved = false;
    inp.addEventListener('blur', () => {
      if (saved) return; saved = true;
      saveTerms(c.partnerId, { [sub]: Number(inp.value || 0) });
    });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    return;
  }
```

- [ ] **Step 5: Add the per-model popover**

Add to `frontend/app.js`:

```js
// MG and Placement are per machine model. A flat cell would collapse
// 7-Eleven's S8=200 / S5=150 into one number, so those cells open this instead.
function openModelPopover(td, partnerId, sub, form) {
  const rowsKey = sub === 'mg' ? 'mgRows' : 'placementRows';
  const rows = (form[rowsKey] || []).map(r => ({ ...r }));
  const pop = document.createElement('div');
  pop.className = 'ct-pop';
  const draw = () => {
    pop.innerHTML = rows.map((r, i) => `
      <div class="ct-pop-row">
        <select data-i="${i}" class="ct-pop-model">
          ${['ALL', ...RS_MODELS].map(m => `<option${m === r.model ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
        <input data-i="${i}" class="ct-pop-amt" type="number" value="${r.amount ?? ''}">
        <button data-del="${i}" class="btn-icon" title="Remove">×</button>
      </div>`).join('')
      + `<div class="ct-pop-actions">
           <button id="ct-pop-add" class="btn btn-sm">+ model</button>
           <button id="ct-pop-save" class="btn btn-sm btn-primary">Save</button>
         </div>`;
  };
  draw();
  td.innerHTML = ''; td.appendChild(pop);
  pop.addEventListener('click', ev => {
    const del = ev.target.dataset.del;
    if (del != null) { rows.splice(Number(del), 1); draw(); }
    if (ev.target.id === 'ct-pop-add') { rows.push({ model: 'ALL', amount: 0 }); draw(); }
    if (ev.target.id === 'ct-pop-save') {
      pop.querySelectorAll('.ct-pop-model').forEach(s => { rows[Number(s.dataset.i)].model = s.value; });
      pop.querySelectorAll('.ct-pop-amt').forEach(inp => { rows[Number(inp.dataset.i)].amount = Number(inp.value || 0); });
      saveTerms(partnerId, { [rowsKey]: rows.filter(r => r.model && Number(r.amount) > 0) });
    }
  });
}
```

- [ ] **Step 6: Style the popover**

Append to `frontend/style.css`:

```css
.ct-multi { color: var(--accent, #3b5bdb); cursor: pointer; }
.ct-pop { position: absolute; z-index: 30; background: var(--surface, #fff);
  border: 1px solid var(--border); border-radius: 9px; padding: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,.14); min-width: 230px; }
.ct-pop-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.ct-pop-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
```

- [ ] **Step 7: Verify and deploy**

```bash
node --check frontend/app.js && AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```

Then in the app — **this is the load-bearing check**:
1. Create a contract linked to **7-Eleven** (console:
   `await api('/contracts',{method:'POST',body:JSON.stringify({merchantName:'7-Eleven',partnerId:'<7-eleven id>'})})`).
2. Open Contracts. Its **Min guarantee** cell must read `per-machine (N) ▾`, **not** a
   single number.
3. Click it — the popover must list its real per-model rows (S8=200, S5=150).
4. Close without saving, then open the partner's **Rule** tab and confirm the rule is
   byte-for-byte unchanged.
5. Change **Rev-share %** in the grid, then check the Rule tab shows the same value —
   proving both editors share one compiler.

- [ ] **Step 8: Commit**

```bash
git add frontend/app.js frontend/style.css
git commit -m "feat(contracts): editable share-term columns via compileRule + per-model popover"
```

---

### Task 7: Sheet upload and match review

**Files:**
- Modify: `frontend/app.js` — `renderContractsScreen` toolbar, plus
  `parseAllMerchantSheet` / `renderImportReview`
- Modify: `frontend/style.css`

**Interfaces:**
- Consumes: `readExcel(file)` at `frontend/app.js:199`; `POST /contracts/import` from
  Task 3; `GET /partners`.
- Produces: `parseAllMerchantSheet(file)` → `{ rows: [[...23 cells...]], skipped }`;
  the review UI that collects `links` before posting.

- [ ] **Step 1: Add the sheet reader**

The sheet has two header rows and merged group cells, so header-keyed parsing is
unreliable. Read positionally instead.

```js
// `All_Merchant` has a two-row header (row 1 groups, row 2 sub-headers); data starts
// at row 3. Merged group cells make header-keyed parsing unreliable, so read by index
// and let the backend normalizer do every coercion.
async function parseAllMerchantSheet(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets['All_Merchant'];
  if (!ws) throw new Error('Sheet "All_Merchant" not found in this workbook');
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: false });
  const body = aoa.slice(2);
  const rows = body
    .map(r => { const c = new Array(23).fill(null); for (let i = 0; i < 23; i++) c[i] = r[i] ?? null; return c; })
    .filter(c => String(c[1] || '').trim());
  return { rows, skipped: body.length - rows.length };
}
```

Note: `readExcel` uses `readAsBinaryString` + `XLSX.read(..., {type:'binary'})`, which
returns Excel serial numbers for dates. `normalizeContractRow` already handles that —
do not add `cellDates`.

- [ ] **Step 2: Add the upload control**

In `renderContractsScreen`'s toolbar HTML, add before the count span:

```js
      ${can('manageMerchants') ? '<label class="btn btn-sm">Upload sheet<input id="ct-file" type="file" accept=".xlsx" hidden></label>' : ''}
```

and after the filter listeners:

```js
  el.querySelector('#ct-file')?.addEventListener('change', async ev => {
    const file = ev.target.files[0]; if (!file) return;
    ev.target.value = '';
    try {
      const { rows, skipped } = await parseAllMerchantSheet(file);
      await renderImportReview(rows, skipped);
    } catch (err) { alert('Could not read that file: ' + err.message); }
  });
```

- [ ] **Step 3: Add the review screen**

```js
// Nothing is written until the user confirms. Unmatched names get a partner dropdown;
// the chosen links are posted alongside the rows.
async function renderImportReview(rows, skipped) {
  const partners = await api('/partners');
  const byName = new Map(partners.map(p => [p.name.toLowerCase().trim(), p]));
  const names = rows.map(r => String(r[1]).trim());
  const unmatched = names.filter(n => !byName.has(n.toLowerCase().trim()));
  const el = document.getElementById('main');
  const opts = partners.map(p => `<option value="${escape(p.partnerId)}">${escape(p.name)}</option>`).join('');
  el.innerHTML = `
    <h1>Import contracts</h1>
    <p><strong>${rows.length}</strong> merchant rows read${skipped ? `, ${skipped} blank rows skipped` : ''}.
       <strong>${names.length - unmatched.length}</strong> matched an existing partner automatically.</p>
    <p class="muted">Share terms in this sheet are ignored — importing never changes a partner's rule.</p>
    ${unmatched.length ? `<h2>${unmatched.length} unmatched — link or leave unlinked</h2>
      <table class="table"><tbody>${unmatched.map(n => `
        <tr><td>${escape(n)}</td><td>
          <select class="input ct-link" data-name="${escape(n.toLowerCase().trim())}">
            <option value="">— keep unlinked —</option>${opts}
          </select></td></tr>`).join('')}</tbody></table>` : ''}
    <div style="margin-top:18px;display:flex;gap:10px;">
      <button id="ct-import-go" class="btn btn-primary">Import ${rows.length} rows</button>
      <button id="ct-import-cancel" class="btn">Cancel</button>
    </div>`;
  el.querySelector('#ct-import-cancel').addEventListener('click', renderContractsScreen);
  el.querySelector('#ct-import-go').addEventListener('click', async ev => {
    ev.target.disabled = true; ev.target.textContent = 'Importing…';
    const links = {};
    el.querySelectorAll('.ct-link').forEach(s => { if (s.value) links[s.dataset.name] = s.value; });
    try {
      const r = await api('/contracts/import', { method: 'POST', body: JSON.stringify({ rows, links }) });
      alert(`Imported. ${r.created} created, ${r.updated} updated, ${r.linked} linked to partners.`);
      renderContractsScreen();
    } catch (err) {
      alert('Import failed: ' + err.message);
      ev.target.disabled = false; ev.target.textContent = `Import ${rows.length} rows`;
    }
  });
}
```

- [ ] **Step 4: Verify and deploy**

```bash
node --check frontend/app.js && AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```

Then upload `1) New_Merchant (60%).xlsx`:
- expect **208 rows read**, **131 matched**, **77 listed for linking**
- import, then confirm the grid fills and BITEC shows counter party
  `บริษัท ปรินทร จำกัด`, start `2025-08-21`, end `2026-08-20`, notice `30`
- **then open 7-Eleven's Rule tab and confirm its rule is unchanged** — MG still
  per-machine, aggregation still `per_store`
- re-upload the same file and confirm `updated: 208, created: 0` — no duplicates

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js frontend/style.css
git commit -m "feat(contracts): All_Merchant sheet upload + match review"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the tab to the UI list in §1b**

After the **Device Types** bullet:

```markdown
- **Contracts** — one flat, fully editable grid of every merchant's contract terms
  (type, counter party, per-model unit counts, start/end, termination notice,
  decline-to-renew, auto-renewal, contract-doc link) plus the partner's share terms.
  Seeded by uploading the `All_Merchant` sheet of the merchant workbook.
  **The importer writes contract fields only and never touches a partner rule** —
  the sheet's share terms are shown in the preview and discarded. Mapping sheet terms
  onto app rules is deliberately deferred. Share-term cells write through the same
  `compileRule` the Rule tab uses; MG and Placement open a per-model popover so
  per-machine values (7-Eleven: S8=200, S5=150) can't be flattened. Rows with no
  linked partner have their term cells disabled. `Sliding Scale` (4 merchants, ladder
  15/20/25/30/35% at 99/199/299/399/400+) is listed but disabled — the engine has
  `tiered_percent` but no editor.
```

- [ ] **Step 2: Add the row family to §5**

Add to the row-family table:

```markdown
| `CONTRACT` | `CONTRACT#<contractId>` | Merchant contract terms + optional `partnerId` link. No share terms — those live on the partner rule. |
```

- [ ] **Step 3: Add the routes to §6**

```markdown
| GET | `/contracts` | List all contracts |
| POST | `/contracts` | Create contract. Requires `manageMerchants`. |
| PUT | `/contracts/:id` | Update contract fields (partial merge). Requires `manageMerchants`. |
| DELETE | `/contracts/:id` | Delete contract. Requires `manageMerchants`. |
| POST | `/contracts/import` | Bulk upsert from the parsed `All_Merchant` sheet, contract fields only. Requires `manageMerchants`. |
```

- [ ] **Step 4: Update the header and test count**

Set `CACHE_VERSION` to `revshare-v74` in the header line and the test count in §1b to
the actual number from `npm test`.

- [ ] **Step 5: Verify the doc's claims**

```bash
grep -n "CACHE_VERSION" frontend/service-worker.js && npm test 2>&1 | grep -E "^. (pass|fail)"
```
Both must match what CLAUDE.md now says.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: contracts register tab, CONTRACT row family, /contracts routes"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 flat editable grid, frozen column, search/filter/sort | Task 4 |
| §2 every column editable | Tasks 5 (contract fields) + 6 (share terms) |
| §3 column list and editors | Task 4 Step 2 descriptors; Task 6 Step 2 term columns |
| §3 dropped columns (`No`, COC, V) | Task 1 `CONTRACT_COLUMNS` `_dead` markers + test |
| §4 import writes contract fields only | Task 3 — `buildImportPlan` strips `sheetTerms`, with an explicit test |
| §4 name matching, 131/77, review before write | Task 1 `matchContracts`; Task 7 review screen |
| §4 idempotent re-import | Task 3 `buildImportPlan` update path + Task 7 Step 4 check |
| §5 same `compileRule`, no second compiler | Task 6 `saveTerms` |
| §5 Sliding Scale listed but disabled | Task 6 Step 4 mode dropdown |
| §5 MG/Placement per-model popover | Task 6 Step 5 |
| §5 unlinked rows disabled | Task 6 Step 4 guard + `termCellHtml` `—` |
| §6 `CONTRACT` row family, optional `partnerId` | Task 2 |
| §7 five routes, `manageMerchants` | Tasks 2 and 3 |
| §8 out of scope | Global Constraints + Task 8 doc text |

**Placeholder scan:** no TBD/TODO; every code step carries a full body; no "similar to
Task N".

**Type consistency:** `contractId`, `merchantName`, `merchantNameLower`, `partnerId`,
`units` (map), `sheetTerms` (stripped before write) are spelled identically in Tasks
1–3. `CONTRACT_GRID_COLUMNS`, `CONTRACTS`, `PARTNERS_BY_ID`, `cellValue`,
`paintContracts`, `saveCell`, `saveTerms`, `termForm` are consistent across Tasks 4–7.
`term.*` column keys in Task 6 match the `col.type.startsWith('term-')` branches in
both `contractRowHtml` and `startCellEdit`.

**Known risk to watch during execution:** Task 6 attaches the per-model popover
*inside* a `<td>` of a horizontally-scrolling table. If it clips at the right-hand
edge, the fix is to append it to `document.body` with fixed positioning from
`td.getBoundingClientRect()` rather than to fight `overflow`. Flagged here so the
implementer does not rediscover it.
