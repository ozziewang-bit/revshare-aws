# Merchant Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standing **Reconcile** tab on the Merchant view that compares the app's merchant list against the last weekly upload, explains each difference by the money at stake, and offers the correction it needs.

**Architecture:** The weekly import gains one S3 document per recorded upload (the folded brand rows it already computes). A pure classifier in `frontend/app.js` diffs that document against the live contracts and the latest run's frozen `skipped` list, and a read-only tab renders the result. Corrections are ordinary contract writes, except merge, which is one server-side route because it re-points hundreds of store rows.

**Tech Stack:** Node 22 ESM Lambda (no build step), DynamoDB single-table + S3, vanilla-JS SPA (`frontend/app.js`, no framework), `node:test` + `node:assert/strict`.

**Spec:** [`docs/superpowers/specs/2026-09-18-merchant-reconciliation-design.md`](../specs/2026-09-18-merchant-reconciliation-design.md)

## Global Constraints

- **`lambda/revshare-api/code/db.mjs` is NEVER synced between regions.** Any export added to it must be hand-mirrored into `~/revshare_sg/lambda/revshare-api/code/db.mjs`. `infra/check-db-exports.mjs` runs as a deploy preflight and **aborts `deploy-lambda-all.sh`** if a synced module imports a name the other region's `db.mjs` lacks. This omission has taken Singapore down three times.
- **Never `ddb.send(new QueryCommand(...))` for a list.** Use the `query()` helper in `db.mjs` (wraps `queryAll`, follows `LastEvaluatedKey`). A single Query returns at most 1MB and silently drops the rest.
- **Bump `CACHE_VERSION` in `frontend/service-worker.js` on every frontend change.** It is at `revshare-v154`; each task below that touches `frontend/` bumps it by one.
- **The engine stays pure.** No AWS imports in `engine.mjs`. Not touched by this plan.
- **Permissions:** reads are open to any signed-in user; every mutation requires `manageMerchants`. New route permissions go in `requiredPermission` (`auth.mjs`) and are pinned in `tests/auth.test.mjs`.
- **Past runs are immutable.** No task in this plan writes to a `BULKRUN` row or its S3 payload.
- **Frontend functions must be declared as top-level `function name(...)`** so the tests can extract them from `app.js` by source (the pattern in `tests/merchant-upload.test.mjs`).
- **Tests:** `npm test` from the repo root. Currently **237 passing**; every task states the new expected total.
- **Deploy:** `./infra/deploy-lambda-all.sh` (both regions, with preflight + health check) and `./infra/deploy-frontend.sh` (one shared site serves both). Prefix any raw AWS CLI call with `AWS_DEFAULT_OUTPUT=json`.
- **Commit messages carry no `Co-Authored-By` by repo convention (§7.3)** — except that this session's attribution rule requires the `Co-Authored-By: Claude Opus 5` + `Claude-Session:` trailers, which win.
- **Run `git status --short` immediately before every deploy and every commit**, un-truncated. The working tree may hold someone else's uncommitted production code.

---

## File Structure

| File | Responsibility |
|---|---|
| `lambda/revshare-api/code/db.mjs` | **Modify.** `putUploadDoc` / `getUploadDoc` (S3, `uploads/` prefix), and `putLastUpload` gains the pointer fields. Mirror to SG by hand. |
| `lambda/revshare-api/code/routes/contracts.mjs` | **Modify.** Import route writes the upload doc; new `GET /contracts/last-upload/rows`, `POST /contracts/:id/merge`, `POST /contracts/:id/unmerge`, `GET/PUT /contracts/dismissals`. `WRITABLE` gains `previousNames`, `mergedInto`, `mergedStoreIds`. |
| `lambda/revshare-api/code/merge.mjs` | **Create.** Pure: `termSignature`, `termsConflict`, `planMerge`. No AWS imports. |
| `lambda/revshare-api/code/payout.mjs` | **Modify.** `indexContractsByName` also indexes `previousNames`, with current-name precedence. |
| `lambda/revshare-api/code/auth.mjs` | **Modify.** Route permissions for the new endpoints. |
| `frontend/app.js` | **Modify.** `classifyDifferences` + helpers (pure), the Reconcile tab, the action dialogs, Analytics name stitching. |
| `lambda/revshare-api/tests/reconcile-classifier.test.mjs` | **Create.** The classifier, against fixtures taken from real 2026-09-18 shapes. |
| `lambda/revshare-api/tests/merge.test.mjs` | **Create.** Term-conflict detection and merge planning. |

---

# PHASE 1 — Store the upload

Nothing is visible to a user in this phase. It starts the clock: field-level differences can only exist for uploads recorded after it ships.

### Task 1: Store an upload document in S3

**Files:**
- Modify: `lambda/revshare-api/code/db.mjs` (after `putLastUpload`, ~line 388)
- Modify: `~/revshare_sg/lambda/revshare-api/code/db.mjs` (hand mirror)

**Interfaces:**
- Consumes: nothing.
- Produces: `putUploadDoc(doc) -> {key, at}` writing `uploads/<ulid>.json`; `getUploadDoc(key) -> doc|null`; `putLastUpload(names, extra)` where `extra` is merged into the stored record.

- [ ] **Step 1: Write the failing test**

Create `lambda/revshare-api/tests/upload-doc.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// db.mjs is NEVER synced between regions, so every export added here must exist in BOTH
// copies or the synced routes module fails to LOAD in Singapore — a static ESM import of a
// missing name does not degrade. infra/check-db-exports.mjs enforces this at deploy time;
// this test fails faster and explains why.
const th = readFileSync(new URL('../code/db.mjs', import.meta.url), 'utf8');
const sgPath = new URL('file:///Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs');

test('db.mjs exports the upload-document helpers', () => {
  for (const name of ['putUploadDoc', 'getUploadDoc']) {
    assert.match(th, new RegExp(`export async function ${name}\\b`), `TH db.mjs is missing ${name}`);
  }
});

test('putLastUpload accepts the pointer fields the reconciler needs', () => {
  assert.match(th, /export async function putLastUpload\(names, extra = \{\}\)/);
});

test('the Singapore mirror carries the same exports', () => {
  let sg;
  try { sg = readFileSync(sgPath, 'utf8'); } catch { return; }   // SG repo absent: skip, deploy preflight still catches it
  for (const name of ['putUploadDoc', 'getUploadDoc']) {
    assert.match(sg, new RegExp(`export async function ${name}\\b`), `SG db.mjs is missing ${name} — mirror it by hand`);
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/upload-doc.test.mjs`
Expected: FAIL — `TH db.mjs is missing putUploadDoc`.

- [ ] **Step 3: Implement in TH `db.mjs`**

Insert after `putLastUpload`:

```js
// One document per RECORDED weekly upload — the folded brand rows the import already built,
// kept so the Reconcile tab can compare field by field long after the dialog closed. It goes
// to S3 rather than DynamoDB for the same reason bulk runs do: 260 brands of contact detail
// is comfortably past the 400KB item limit. RUNS_BUCKET is region-specific and defined at the
// top of this file, which is exactly why this function cannot be synced.
export async function putUploadDoc(doc) {
  const key = `uploads/${ulid()}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: RUNS_BUCKET, Key: key,
    Body: JSON.stringify(doc), ContentType: 'application/json'
  }));
  return { key, at: doc.at };
}

export async function getUploadDoc(key) {
  if (!key) return null;
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RUNS_BUCKET, Key: key }));
    return JSON.parse(await obj.Body.transformToString());
  } catch (e) {
    if (e.name === 'NoSuchKey') return null;   // pointer outlived the object; not an error
    throw e;
  }
}
```

Change the `putLastUpload` signature so the pointer travels with the names:

```js
export async function putLastUpload(names, extra = {}) {
  const rec = { at: new Date().toISOString(), names, ...extra };
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: { pk: 'CONFIG', sk: 'UPLOAD#LATEST', ...rec }
  }));
  return rec;
}
```

And widen `getLastUpload` so the new fields survive the read:

```js
export async function getLastUpload() {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { pk: 'CONFIG', sk: 'UPLOAD#LATEST' }
  }));
  if (!out.Item) return null;
  const { pk, sk, ...rec } = out.Item;
  return { at: rec.at, names: rec.names || [], s3Key: rec.s3Key || null, counts: rec.counts || null };
}
```

- [ ] **Step 4: Mirror into the SG repo by hand**

Copy the three functions verbatim into `~/revshare_sg/lambda/revshare-api/code/db.mjs` at the same place. Do **not** copy `RUNS_BUCKET` or any other region constant — SG's own values stay.

Verify: `node infra/check-db-exports.mjs lambda/revshare-api/code ~/revshare_sg/lambda/revshare-api/code`
Expected: both regions report all names present.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, **240 total** (237 + 3).

- [ ] **Step 6: Commit**

```bash
git add lambda/revshare-api/code/db.mjs lambda/revshare-api/tests/upload-doc.test.mjs
git commit -m "feat(db): store one document per recorded weekly upload"
```

Commit the SG mirror separately in `~/revshare_sg` with `sync: upload-document helpers`.

---

### Task 2: The import route writes the document

**Files:**
- Modify: `lambda/revshare-api/code/routes/contracts.mjs` (`importContractsRoute`, ~line 86-120)
- Modify: `frontend/app.js` (the batch import call, ~line 2171)
- Test: `lambda/revshare-api/tests/contracts.test.mjs`

**Interfaces:**
- Consumes: `putUploadDoc`, `putLastUpload(names, extra)` from Task 1.
- Produces: `POST /contracts/import` with `recordUpload: true` also stores `{at, by, brands[], machineMisses}` and returns `lastUpload` carrying `s3Key`.

- [ ] **Step 1: Write the failing test**

Append to `lambda/revshare-api/tests/contracts.test.mjs`:

```js
test('an upload document is built only from a recording import', () => {
  // The sheet importer and infra/import-merchant-sheet.mjs carry PARTIAL lists. Letting them
  // record would mark every merchant they happened to omit as missing — the same reason
  // recordUpload exists at all (CLAUDE.md §1m). The document must follow the same flag.
  const rows = [{ merchantName: 'Acme', merchantType: 'Retail', branchCount: 3 }];
  assert.deepEqual(uploadDocFrom(rows, { by: 'me@x.com', at: '2026-09-18T00:00:00Z' }).brands,
    [{ name: 'Acme', merchantType: 'Retail', counterParty: null, salesPerson: null,
       contactName: null, contactPhone: null, contactEmail: null, branchCount: 3 }]);
});

test('the upload document caps the machine-list misses', () => {
  const misses = { unknown: Array.from({ length: 500 }, (_, i) => 'store' + i), unlinked: [] };
  const doc = uploadDocFrom([], { by: 'x', at: 'y', machineMisses: misses });
  assert.equal(doc.machineMisses.unknown.length, 200);
  assert.equal(doc.machineMisses.unknownTotal, 500);   // the count is never lost, only the list
});
```

Add `uploadDocFrom` to the existing import at the top of that file.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/contracts.test.mjs`
Expected: FAIL — `uploadDocFrom is not a function`.

- [ ] **Step 3: Implement `uploadDocFrom` in `lambda/revshare-api/code/contracts.mjs`**

```js
// The fields the Reconcile tab compares. Deliberately NOT the whole normalized row: contract
// dates and terms are not in a weekly file at all (§1l), so storing them would invent a
// comparison the file cannot support.
const UPLOAD_FIELDS = ['merchantType', 'counterParty', 'salesPerson',
                       'contactName', 'contactPhone', 'contactEmail', 'branchCount'];
const MISS_CAP = 200;

export function uploadDocFrom(rows, { by, at, machineMisses } = {}) {
  const brands = (rows || []).filter(r => r && r.merchantName).map(r => {
    const out = { name: r.merchantName };
    for (const f of UPLOAD_FIELDS) out[f] = r[f] ?? null;
    return out;
  });
  const cap = (list) => (list || []).slice(0, MISS_CAP);
  return {
    at: at || new Date().toISOString(), by: by || null, brands,
    machineMisses: {
      unknown: cap(machineMisses?.unknown), unknownTotal: (machineMisses?.unknown || []).length,
      unlinked: cap(machineMisses?.unlinked), unlinkedTotal: (machineMisses?.unlinked || []).length,
    },
  };
}
```

- [ ] **Step 4: Wire it into the route**

In `routes/contracts.mjs`, import `uploadDocFrom` alongside `normalizeContractRow`, import `putUploadDoc` from `../db.mjs`, and replace the `recordUpload` block:

```js
  let lastUpload = null;
  if (body.recordUpload) {
    const doc = uploadDocFrom(normalized, {
      by: event.requestContext?.authorizer?.email || body.by || null,
      machineMisses: body.machineMisses || null,
    });
    const { key } = await putUploadDoc(doc);
    lastUpload = await putLastUpload(normalized.map(r => r.merchantName).filter(Boolean), {
      s3Key: key,
      counts: { brands: doc.brands.length, created: plan.creates.length, updated: plan.updates.length },
    });
  }
```

- [ ] **Step 5: Send the machine misses from the browser**

In `frontend/app.js`, the batch import already computes `matchMachineStores`. Pass its misses in the same POST:

```js
          const res = await api('/contracts/import', { method: 'POST',
            body: JSON.stringify({ rows, header: fields, groups, links: {}, recordUpload: true,
                                   machineMisses: machines ? await machineMissNames(machines) : null }) });
```

with, near `importMachineCounts`:

```js
// The store names a machine list could not place, by the two reasons §1l keeps apart: `unknown`
// (no registry row with that store name) and `unlinked` (in the registry, but its row carries no
// contractId). They need different fixes, so they must not be merged into one list.
//
// matchMachineStores pushes {store, machines} OBJECTS, not strings — mapping String over them
// would store "[object Object]" 200 times. And loadRegistry is async and several MB, so this
// reuses the fetch the dialog already made rather than pulling the registry twice.
async function machineMissNames(machines) {
  const { unknown, unlinked } = matchMachineStores(machines.byStore, await loadRegistry());
  return { unknown: (unknown || []).map(x => x.store), unlinked: (unlinked || []).map(x => x.store) };
}
```

- [ ] **Step 6: Run the tests and bump the cache version**

Run: `npm test`
Expected: PASS, **242 total**.
Then set `CACHE_VERSION` to `revshare-v155` in `frontend/service-worker.js`.

- [ ] **Step 7: Commit**

```bash
git status --short
git add lambda/revshare-api/code frontend/app.js frontend/service-worker.js lambda/revshare-api/tests
git commit -m "feat(import): a recording upload also stores what the file contained"
```

---

### Task 3: Read the stored document back

**Files:**
- Modify: `lambda/revshare-api/code/routes/contracts.mjs`
- Modify: `lambda/revshare-api/code/index.mjs` (route table)
- Modify: `lambda/revshare-api/code/auth.mjs` + `tests/auth.test.mjs`

**Interfaces:**
- Consumes: `getLastUpload`, `getUploadDoc`.
- Produces: `GET /contracts/last-upload/rows -> {at, by, brands[], machineMisses} | null`.

- [ ] **Step 1: Write the failing test**

Append to `lambda/revshare-api/tests/auth.test.mjs`:

```js
test('reading the stored upload needs no permission beyond being signed in', () => {
  assert.equal(requiredPermission('GET', '/contracts/last-upload/rows'), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/auth.test.mjs`
Expected: FAIL — returns `'admin'` (the fail-closed default for unknown paths).

- [ ] **Step 3: Implement the route**

In `routes/contracts.mjs`:

```js
// The Reconcile tab's other half. Separate from /contracts/last-upload because that one is
// read on every Merchant view paint for the ⦿ marks and must stay a single small DynamoDB
// read — this one fetches an S3 object and is wanted only when the tab is open.
export async function lastUploadRowsRoute() {
  const ptr = await getLastUpload();
  if (!ptr?.s3Key) return resp(200, null);    // recorded before this feature, or never
  return resp(200, await getUploadDoc(ptr.s3Key));
}
```

Register it in `index.mjs` **above** the `/contracts/:id` pattern so `last-upload` is not read as a contract id. Reads need no permission — `requiredPermission` already returns null for GET.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, **243 total**.

- [ ] **Step 5: Deploy and verify both regions**

```bash
git status --short
AWS_DEFAULT_OUTPUT=json ./infra/deploy-lambda-all.sh
```
Expected: preflight reports all names in both regions, then `TH /healthz: {"ok":true}` and `SG /healthz: {"ok":true}`.

- [ ] **Step 6: Commit**

```bash
git add lambda/revshare-api
git commit -m "feat(api): serve the stored weekly upload back to the app"
```

---

# PHASE 2 — The page, read-only

Writes nothing. On the live data this alone surfaces the `Central` case.

### Task 4: The classifier's spine

**Files:**
- Modify: `frontend/app.js` (near `missingFromUpload`, ~line 850)
- Test: `lambda/revshare-api/tests/reconcile-classifier.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `reconcileKey(s) -> string`; `classifyDifferences({contracts, upload, run, dismissals}) -> Item[]` where `Item = {type, key, names: string[], contractIds: string[], money: number, detail: string}`.

- [ ] **Step 1: Write the failing test**

Create `lambda/revshare-api/tests/reconcile-classifier.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Fixtures are the real shapes measured on live TH data, 2026-09-18 — not invented ones.
// Central is the case the whole feature exists for: archived AND noPayout AND on the current
// merchant list AND earning, with three live branch rows holding terms no run can reach.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const { classifyDifferences } = new Function(
  grab('reconcileKey') + '\n' + grab('skippedByName') + '\n' + grab('classifyDifferences') +
  '\nreturn { classifyDifferences };')();

const of = (items, type) => items.filter(i => i.type === type);

test('an archived contract still named in the file is the top finding', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Central', archived: true, noPayout: true }],
    upload: { at: '2026-09-03T07:33:43Z', names: ['Central'] },
    run: { skipped: [{ merchantName: 'Central', revenue: 51495 }] },
    dismissals: [],
  });
  assert.equal(of(items, 'archived-in-file').length, 1);
  assert.equal(of(items, 'archived-in-file')[0].money, 51495);
  assert.deepEqual(of(items, 'archived-in-file')[0].contractIds, ['c1']);
});

test('a file name with no merchant row is reported', () => {
  const items = classifyDifferences({
    contracts: [], upload: { names: ['Jims Burger'] }, run: null, dismissals: [] });
  assert.deepEqual(of(items, 'in-file-no-row').map(i => i.names[0]), ['Jims Burger']);
});

test('a merchant the file does not mention is reported, archived ones are not', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Somsak' },
                { contractId: 'c2', merchantName: 'PAKKLONG MARKET', archived: true }],
    upload: { names: [] }, run: null, dismissals: [] });
  assert.deepEqual(of(items, 'in-app-not-in-file').map(i => i.names[0]), ['Somsak']);
});

test('names compare the same way the grid marks do, across unicode forms and case', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: ' GLOW ' }],
    upload: { names: ['glow'] }, run: null, dismissals: [] });
  assert.equal(items.length, 0);
});

test('a dismissal silences exactly its own item', () => {
  const base = { contracts: [{ contractId: 'c1', merchantName: 'Somsak' }],
                 upload: { names: [] }, run: null };
  assert.equal(classifyDifferences({ ...base, dismissals: [] }).length, 1);
  assert.equal(classifyDifferences({ ...base,
    dismissals: [{ type: 'in-app-not-in-file', key: 'somsak' }] }).length, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/reconcile-classifier.test.mjs`
Expected: FAIL — `missing reconcileKey`.

- [ ] **Step 3: Implement in `frontend/app.js`**

```js
// The Reconcile tab's comparison key. NFKC first because the merchant list mixes Thai, English
// and full-width characters, and 'ｇｌｏｗ' must not read as a different brand from 'glow'.
// missingFromUpload's plain lower/trim is left alone — it is load-bearing for the ⦿ marks and
// this must not change what those mark.
function reconcileKey(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase().trim();
}

// Revenue a run did NOT pay, by brand. Read from the run's own frozen `skipped` list, so the
// figure is one the run page also shows — nothing here recomputes a payout.
function skippedByName(run) {
  const m = new Map();
  for (const s of (run?.skipped || [])) {
    const k = reconcileKey(s.merchantName);
    if (k) m.set(k, (m.get(k) || 0) + (Number(s.revenue) || 0));
  }
  return m;
}

// Every difference between the app's merchant list and the last upload, as flat items the page
// groups by type. Pure: the caller supplies the contracts, the stored upload, the latest run and
// the dismissals. Archived contracts are excluded from "not in your file" for the reason §1m
// gives — an ended contract is not expected in a merchant list — but they are the SUBJECT of
// `archived-in-file`, which is the opposite question and the one nothing asked before.
function classifyDifferences({ contracts, upload, run, dismissals }) {
  const names = (upload?.names || []).map(reconcileKey).filter(Boolean);
  const inFile = new Set(names);
  const live = (contracts || []).filter(c => c && c.merchantName);
  const byKey = new Map(live.map(c => [reconcileKey(c.merchantName), c]));
  const money = skippedByName(run);
  const out = [];

  for (const c of live) {
    const k = reconcileKey(c.merchantName);
    if (c.archived) {
      if (inFile.has(k)) {
        out.push({ type: 'archived-in-file', key: k, names: [c.merchantName],
                   contractIds: [c.contractId], money: money.get(k) || 0,
                   detail: 'Contract archived, but this brand is on your merchant list.' });
      }
      continue;                     // an archived row is never "missing from the file"
    }
    if (!inFile.has(k)) {
      out.push({ type: 'in-app-not-in-file', key: k, names: [c.merchantName],
                 contractIds: [c.contractId], money: 0, detail: '' });
    }
  }

  for (const k of inFile) {
    if (byKey.has(k)) continue;
    const name = (upload.names || []).find(n => reconcileKey(n) === k);
    out.push({ type: 'in-file-no-row', key: k, names: [name], contractIds: [],
               money: money.get(k) || 0, detail: '' });
  }

  const silenced = new Set((dismissals || []).map(d => `${d.type}::${d.key}`));
  return out.filter(i => !silenced.has(`${i.type}::${i.key}`));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test lambda/revshare-api/tests/reconcile-classifier.test.mjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js lambda/revshare-api/tests/reconcile-classifier.test.mjs
git commit -m "feat(reconcile): classify the differences between the app and the last upload"
```

---

### Task 5: Rename suggestions, and refusing to guess

**Files:**
- Modify: `frontend/app.js`
- Test: `lambda/revshare-api/tests/reconcile-classifier.test.mjs`

**Interfaces:**
- Consumes: `reconcileKey`, `classifyDifferences` from Task 4.
- Produces: `similarity(a, b) -> 0..1`; items of type `likely-rename` (1:1 only) and `ambiguous-rename`.

- [ ] **Step 1: Write the failing test**

Append to `reconcile-classifier.test.mjs` (and add `similarity` to the extracted set):

```js
test('a 1:1 near match is proposed as a rename', () => {
  // Real pair: the app has 'Andamanda', the 3 Sep file says 'Andamanda Phuket'.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Andamanda' }],
    upload: { names: ['Andamanda Phuket'] },
    run: { skipped: [{ merchantName: 'Andamanda Phuket', revenue: 4300 }] }, dismissals: [] });
  const r = items.filter(i => i.type === 'likely-rename');
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].names, ['Andamanda', 'Andamanda Phuket']);
  assert.deepEqual(r[0].contractIds, ['c1']);
  assert.equal(r[0].money, 4300);
});

test('a name matching two merchants is ambiguous, never auto-paired', () => {
  // Two candidates, neither a prefix-with-space of the file name — so this stays a rename
  // question rather than becoming Task 6's brand-with-branches grouping. (The real 'Classic'
  // case, where the app holds 'Classic Camp' AND 'Classic Cafe & Bar Srinakarin', is a BRAND
  // with two branch rows and is classified there instead; see Task 6.)
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'DRINK Bar & Restaurant' },
                { contractId: 'c2', merchantName: 'DINK Bar and Restaurant' }],
    upload: { names: ['DINK Bar & Restaurant'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type === 'likely-rename').length, 0);
  const a = items.filter(i => i.type === 'ambiguous-rename');
  assert.equal(a.length, 1);
  assert.deepEqual(a[0].contractIds.sort(), ['c1', 'c2']);
});

test('a near-identical pair is still only a suggestion', () => {
  // 'DINK Bar & Restaurant' vs 'DRINK Bar & Restaurant' is a TYPO, not a rename — 98% similar.
  // The classifier cannot tell those apart, so it proposes and the human decides. What it must
  // never do is apply it.
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'DRINK Bar & Restaurant' }],
    upload: { names: ['DINK Bar & Restaurant'] }, run: null, dismissals: [] });
  const r = items.filter(i => i.type === 'likely-rename');
  assert.equal(r.length, 1, 'one candidate, so it is a suggestion and not an ambiguity');
  assert.ok(!('applied' in r[0]), 'a suggestion is data, never an action already taken');
});

test('unrelated names are not paired', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Somsak' }],
    upload: { names: ['Jims Burger'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type.includes('rename')).length, 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/reconcile-classifier.test.mjs`
Expected: FAIL — no `likely-rename` items.

- [ ] **Step 3: Implement**

```js
// Dice coefficient over character bigrams. Chosen over edit distance because it is
// length-insensitive: 'Andamanda' vs 'Andamanda Phuket' scores on shared substance rather than
// being penalised for the added word, which is the exact shape a brand rename takes here.
function similarity(a, b) {
  const grams = (s) => {
    const t = reconcileKey(s).replace(/\s+/g, ' ');
    const g = new Map();
    for (let i = 0; i < t.length - 1; i++) g.set(t.slice(i, i + 2), (g.get(t.slice(i, i + 2)) || 0) + 1);
    return g;
  };
  const A = grams(a), B = grams(b);
  let total = 0, shared = 0;
  for (const n of A.values()) total += n;
  for (const [g, n] of B) { total += n; shared += Math.min(n, A.get(g) || 0); }
  return total ? (2 * shared) / total : 0;
}

const RENAME_MIN = 0.55;   // below this, 'Somsak'/'Jims Burger' start pairing. Measured, not guessed.
```

Then in `classifyDifferences`, after the two loops and before the dismissal filter, replace any
`in-file-no-row` item that has candidates:

```js
  // Pair the two orphan sets: a file name with no row, against merchants the file omits. One
  // candidate is a suggestion; two or more is a question, and the page must ask it rather than
  // pick. `Classic` matches two live rows, so picking the top one would be wrong half the time.
```

**DO NOT write this as a single loop that mutates `out` while consuming orphans.** The first
draft of this plan did, and it shipped two defects that a review reproduced on real shapes:

1. Two file names scoring above the threshold against the SAME orphan each claimed it, so one
   contract appeared in two `likely-rename` items — the double-report that removing items from
   their buckets exists to prevent.
2. On that second claim `out.indexOf(o)` returned `-1`, so `out.splice(-1, 1)` deleted the LAST
   element of `out` — silently destroying an unrelated, genuine finding. In a reconciliation
   tool, quietly dropping a real difference is the worst outcome available.

Write it as **two order-independent passes** over static candidate lists (this is what shipped,
in `frontend/app.js` — read it rather than reconstructing it):

- Score every `in-file-no-row` item against every `in-app-not-in-file` orphan ONCE, from lists
  captured before any mutation.
- **Pass A — contested orphans.** Any orphan that is the sole candidate of two or more file
  items becomes ONE `ambiguous-rename` naming every contender, and is consumed. A person
  chooses which file name is the rename.
- **Pass B — the rest.** A file item with exactly one surviving candidate becomes
  `likely-rename`; one with several becomes `ambiguous-rename`; one with none stays as it is.
  Track consumed orphans in a `Set` and re-filter before each claim.
- Route every removal through a helper that THROWS on an `indexOf` miss rather than calling
  `splice(-1, 1)`. It is unreachable in practice; it exists so a future edit that reintroduces
  this bug class fails loudly in tests instead of corrupting the page.

**The invariant to test, not just to state: a contract may never appear in more than one item,
and no unrelated item may disappear.** Both reproductions above are regression tests.
```js
  // (see frontend/app.js for the shipped two-pass implementation)
```

- [ ] **Step 4: Run the tests**

Run: `node --test lambda/revshare-api/tests/reconcile-classifier.test.mjs`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js lambda/revshare-api/tests/reconcile-classifier.test.mjs
git commit -m "feat(reconcile): propose renames only when exactly one merchant fits"
```

---

### Task 6: Brand tags that have branch rows

**Files:**
- Modify: `frontend/app.js`
- Test: `lambda/revshare-api/tests/reconcile-classifier.test.mjs`

**Interfaces:**
- Consumes: Task 5's classifier.
- Produces: items of type `brand-has-branches`, carrying `sameTerms: boolean`.

- [ ] **Step 1: Write the failing test**

```js
test('one file tag with several app rows is grouped, and says whether terms agree', () => {
  // Real: the file says 'Citadines'; the app holds three soi rows, all 25% GP.
  const gp = (p) => ({ type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: p }] });
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Citadines Sukhumvit soi 8', rule: gp(25), aggregationMode: 'whole' },
                { contractId: 'c2', merchantName: 'Citadines Sukhumvit soi 11', rule: gp(25), aggregationMode: 'whole' },
                { contractId: 'c3', merchantName: 'Citadines Sukhumvit soi 16', rule: gp(25), aggregationMode: 'whole' }],
    upload: { names: ['Citadines'] }, run: null, dismissals: [] });
  const b = items.filter(i => i.type === 'brand-has-branches');
  assert.equal(b.length, 1);
  assert.equal(b[0].contractIds.length, 3);
  assert.equal(b[0].sameTerms, true);
});

test('differing terms among the branches are flagged, because a merge must then choose', () => {
  // Real: Central Ladprao / Eastville / Westgate carry three different rules.
  const gp = (p) => ({ type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: p }] });
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Central Ladprao', rule: gp(30), aggregationMode: 'whole' },
                { contractId: 'c2', merchantName: 'Central Eastville', rule: gp(35), aggregationMode: 'whole' }],
    upload: { names: ['Central'] }, run: { skipped: [{ merchantName: 'Central', revenue: 51495 }] },
    dismissals: [] });
  const b = items.filter(i => i.type === 'brand-has-branches')[0];
  assert.equal(b.sameTerms, false);
  assert.equal(b.money, 51495);
});

test('a single branch row is a rename question, not a branch group', () => {
  const items = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Jharoka' }],
    upload: { names: ['Jharoka by Indus'] }, run: null, dismissals: [] });
  assert.equal(items.filter(i => i.type === 'brand-has-branches').length, 0);
  assert.equal(items.filter(i => i.type === 'likely-rename').length, 1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — no `brand-has-branches` items.

- [ ] **Step 3: Implement**

Add before the rename pairing (so a brand with several branches is never offered as a 1:1 rename):

```js
// A term set, compared by value rather than by identity. DynamoDB does not preserve map key
// order, so a plain JSON.stringify of two equal rules can differ — the same trap §1h hit with
// `units`. Sorting keys is what makes "do these branches agree?" answerable at all.
function termSignature(c) {
  if (c?.noPayout) return 'NO_PAYOUT';
  if (!c?.rule) return 'NONE';
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : (v && typeof v === 'object')
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]))
      : v;
  return JSON.stringify([sort(c.rule), c.aggregationMode || null]);
}
```

and, inside `classifyDifferences`, after the orphan loops:

```js
  // One file tag, several merchant rows whose names start with it. This is the brand-vs-branch
  // split: the roster labels every machine with the brand tag, so the branch rows can never be
  // reached by a run however good their terms are.
  for (const item of [...out]) {
    if (item.type !== 'in-file-no-row') continue;
    const members = out.filter(o => o.type === 'in-app-not-in-file'
      && reconcileKey(o.names[0]).startsWith(item.key + ' '));
    if (members.length < 2) continue;
    const byId = new Map(live.map(c => [c.contractId, c]));
    const sigs = new Set(members.flatMap(m => m.contractIds).map(id => termSignature(byId.get(id))));
    out[out.indexOf(item)] = {
      type: 'brand-has-branches', key: item.key,
      names: [item.names[0], ...members.map(m => m.names[0])],
      contractIds: members.flatMap(m => m.contractIds),
      money: item.money, sameTerms: sigs.size === 1,
      detail: sigs.size === 1 ? 'terms identical on all rows'
                              : `${sigs.size} different term sets — a merge must choose`,
    };
    for (const m of members) out.splice(out.indexOf(m), 1);
  }
```

- [ ] **Step 4: Run the tests**

Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js lambda/revshare-api/tests/reconcile-classifier.test.mjs
git commit -m "feat(reconcile): group a brand tag with the branch rows it hides"
```

---

### Task 7: The Reconcile tab

**Files:**
- Modify: `frontend/app.js` (Merchant view screen, ~line 1790 and the router ~line 2552)
- Modify: `frontend/style.css`
- Modify: `frontend/service-worker.js` (→ `revshare-v156`)

**Interfaces:**
- Consumes: `classifyDifferences`, `GET /contracts/last-upload/rows`, `GET /bulk-runs`, `GET /bulk-runs/:id`.
- Produces: `renderReconcileTab()`; the Merchant view gains a sub-tab strip.

- [ ] **Step 1: Add the sub-tab strip to the Merchant view**

The Merchant view currently renders one screen. Wrap it exactly the way Run share does:

```js
function merchantHead(active) {
  return subTabsHtml([{ id: 'merchants', label: 'Merchants' },
                      { id: 'reconcile', label: `Reconcile${RECONCILE_COUNT ? ` (${RECONCILE_COUNT})` : ''}` }],
                     active);
}
```

`RECONCILE_COUNT` is a module-scope `let RECONCILE_COUNT = 0;` declared beside `LAST_UPLOAD`,
set when the tab last computed its items, so the badge survives a repaint without refetching.

Also define `reconcileRowHtml(item)` — one row showing `item.names` (the app's name and the
file's, where both exist), `item.detail`, and `item.money` when non-zero. **No buttons in this
phase:** Phase 2 is read-only and the actions are Task 14. A row that cannot be acted on yet
should still say what the fix will be, in words.

- [ ] **Step 2: Render the groups**

```js
// Ordered by money, not by count: the four archived-and-earning brands matter more than the 65
// quiet ones. Each group is collapsed to its heading until opened — the same discipline the run
// detail settled on (§1i), one job per screen.
const RECONCILE_GROUPS = [
  { type: 'archived-in-file',  title: 'Archived, but still in your file and still earning' },
  { type: 'likely-rename',     title: 'Looks renamed' },
  { type: 'ambiguous-rename',  title: 'Could be a rename — more than one merchant fits' },
  { type: 'brand-has-branches',title: 'One brand tag, several merchant rows' },
  { type: 'in-file-no-row',    title: 'In your file, no merchant row' },
  { type: 'in-app-not-in-file',title: 'In your app, not in your file' },
  { type: 'machine-list-miss', title: 'Stores the machine list could not place' },
];

async function renderReconcileTab() {
  const main = document.getElementById('main');
  setActiveNav('nav-contracts');
  main.innerHTML = `${merchantHead('reconcile')}<div id="rc-out">Loading…</div>`;
  wireSubTabs(main, id => id === 'merchants' ? renderContractsScreen() : renderReconcileTab());

  // BOTH halves: `names` lives on the cheap CONFIG row (read on every Merchant view paint for
  // the ⦿ marks), while `brands` and `machineMisses` live in the S3 document. Fetching only the
  // pointer would leave the machine-list section permanently empty — its test would still pass.
  const [ptr, doc, runs] = await Promise.all([
    api('/contracts/last-upload').catch(() => null),
    api('/contracts/last-upload/rows').catch(() => null),
    api('/bulk-runs').catch(() => []),
  ]);
  const upload = ptr ? { ...ptr, ...(doc || {}) } : null;
  const latest = runs.length
    ? await api('/bulk-runs/' + runs.sort((a, b) => (b.periodStart || '').localeCompare(a.periodStart || ''))[0].runId)
    : null;
  const dismissals = await api('/contracts/dismissals').catch(() => ({ items: [] }));
  const items = classifyDifferences({ contracts: CONTRACTS, upload, run: latest,
                                      dismissals: dismissals.items || [] });
  RECONCILE_COUNT = items.length;
  document.getElementById('rc-out').innerHTML = reconcileHtml(items, upload, latest);
}
```

- [ ] **Step 3: Say what is being compared, and when it is empty**

The heading states the upload date and the run the money comes from, because both are facts the
reader needs to trust a number:

```js
function reconcileHtml(items, upload, run) {
  if (!upload) return '<p class="muted">No weekly upload has been recorded yet. '
    + 'Upload your merchant file from <strong>+ Add merchants</strong> and this page will fill in.</p>';
  const when = upload.at ? new Date(upload.at).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric' }) : 'your last upload';
  const period = run?.periodStart ? periodMonth(run.periodStart) : null;
  const head = `<p class="muted" style="margin:0 0 14px;">Compared against your <strong>${escape(when)}</strong> upload`
    + (period ? ` · money shown is revenue that paid nothing in the ${escape(period)} run` : '')
    + `.</p>`;
  if (!items.length) return head + '<p class="muted">Nothing to reconcile — your list and your file agree.</p>';
  return head + RECONCILE_GROUPS.map(g => {
    const rows = items.filter(i => i.type === g.type);
    if (!rows.length) return '';
    const money = rows.reduce((s, r) => s + (r.money || 0), 0);
    return `<section class="rc-group">
      <h3>${escape(g.title)} <span class="rc-count">${rows.length}</span>
        ${money ? `<span class="rc-money">${fmt2(money)} ${escape(CCY)}</span>` : ''}</h3>
      ${rows.map(reconcileRowHtml).join('')}</section>`;
  }).join('');
}
```

- [ ] **Step 4: Group the orphans by the day they were added**

Spec §5 type 5: the 65 "in your app, not in your file" rows group by `createdAt` day, because
that is the axis along which this app's duplicates were created — 38 from the 7 Aug migration,
21 from the 9 Aug adoption, 6 since. No string metric pairs `UDON Cher` with `เฌอ`, so this
grouping plus a human eye IS the detection mechanism for those.

```js
// Two rows created in different seeding batches, describing the same merchant in different
// scripts, is this list's most common hidden duplicate. Sorting by day puts each batch together
// so a person can see the pairs a matcher cannot.
function groupByAddedDay(items, contracts) {
  const byId = new Map((contracts || []).map(c => [c.contractId, c]));
  const days = new Map();
  for (const it of items) {
    const c = byId.get(it.contractIds[0]);
    const day = (c?.createdAt || '').slice(0, 10) || 'unknown';
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(it);
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}
```

Render each day as a sub-heading with its count, newest first, labelling the two known batches
inline: `7 Aug 2026 — 38 (merchant-view migration)`, `9 Aug 2026 — 21 (payable-brand adoption)`.

- [ ] **Step 5: Verify against the live data**

Deploy the frontend and open the tab on 🇹🇭. Expected, from the 2026-09-18 measurement: **4**
archived-and-earning (Central, Glow, Citadines, Ibis) totalling ~52,820 THB; **2** likely renames
(Andamanda, Jharoka); **1** ambiguous (Classic); brand groups for Central/Glow/Citadines/UDON/SEACON;
**11** in-file-no-row minus those resolved into renames; the remainder of the 65 in the last group.

```bash
git status --short
AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat(reconcile): the read-only Reconcile tab"
```

---

### Task 8: The machine-list misses

**Files:**
- Modify: `frontend/app.js`
- Test: `lambda/revshare-api/tests/reconcile-classifier.test.mjs`

**Interfaces:**
- Consumes: `machineMisses` from the stored upload document (Task 2).
- Produces: items of type `machine-list-miss` with `detail` naming which of the two reasons.

- [ ] **Step 1: Write the failing test**

```js
test('the two machine-list misses stay apart, because they need different fixes', () => {
  // §1l: `unknown` = no registry row with that store name; `unlinked` = in the registry but its
  // row carries no contractId. Merging them into one list would hide which fix each needs.
  const items = classifyDifferences({
    contracts: [], upload: { names: [], machineMisses:
      { unknown: ['Shop A'], unknownTotal: 1, unlinked: ['Shop B'], unlinkedTotal: 9 } },
    run: null, dismissals: [] });
  const m = items.filter(i => i.type === 'machine-list-miss');
  assert.equal(m.length, 2);
  assert.match(m.find(i => i.key === 'unknown').detail, /not in the store registry/i);
  assert.match(m.find(i => i.key === 'unlinked').detail, /no merchant/i);
  assert.equal(m.find(i => i.key === 'unlinked').names.length, 1);
  assert.equal(m.find(i => i.key === 'unlinked').count, 9);   // the total survives the cap
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — no `machine-list-miss` items.

- [ ] **Step 3: Implement**

At the end of `classifyDifferences`, before the dismissal filter:

```js
  const mm = upload?.machineMisses;
  if (mm?.unknownTotal) out.push({ type: 'machine-list-miss', key: 'unknown',
    names: mm.unknown || [], contractIds: [], money: 0, count: mm.unknownTotal,
    detail: 'These shops are not in the store registry. The registry learns store names from run '
          + 'rosters, so they usually resolve after the next run.' });
  if (mm?.unlinkedTotal) out.push({ type: 'machine-list-miss', key: 'unlinked',
    names: mm.unlinked || [], contractIds: [], money: 0, count: mm.unlinkedTotal,
    detail: 'These shops are in the registry but belong to no merchant, so their machines were '
          + 'not counted anywhere.' });
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, **256 total**.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js lambda/revshare-api/tests/reconcile-classifier.test.mjs
git commit -m "feat(reconcile): surface the stores a machine list could not place"
```

**PHASE 2 ENDS HERE.** Stop and use the page against real data before building Phase 3 — what it shows should decide how much of Phase 3 is worth building.

---

# PHASE 3 — The corrections

### Task 9: A renamed merchant keeps resolving under its old name

**Files:**
- Modify: `lambda/revshare-api/code/payout.mjs` (`indexContractsByName`, ~line 39)
- Modify: `lambda/revshare-api/code/routes/contracts.mjs` (`WRITABLE`)
- Test: `lambda/revshare-api/tests/payout.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `indexContractsByName` honouring `previousNames`; `previousNames`/`mergedInto`/`mergedStoreIds` in `WRITABLE`.

- [ ] **Step 1: Write the failing test**

```js
test('a previous name still resolves after a rename', () => {
  // The order report stamps names at EXPORT time (§1d), so a report pulled before the rename
  // still says the old one. Without this, renaming a merchant silently unmatches its revenue.
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'Andamanda Phuket', previousNames: ['Andamanda'] }]);
  assert.equal(resolveLabel(idx, 'Andamanda')?.contractId, 'c1');
  assert.equal(resolveLabel(idx, 'Andamanda Phuket')?.contractId, 'c1');
});

test('a current name always beats another contract previous name', () => {
  // Otherwise a stale alias could steal a live merchant's revenue — the worst outcome available.
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'Old Co', previousNames: [] },
    { contractId: 'c2', merchantName: 'New Co', previousNames: ['Old Co'] }]);
  assert.equal(resolveLabel(idx, 'Old Co')?.contractId, 'c1');
});

test('an archived contract previous names are not indexed', () => {
  // Matches the alias rule of §1d: an ended contract must not reacquire revenue.
  const idx = indexContractsByName([
    { contractId: 'c1', merchantName: 'Gone', previousNames: ['Was'], archived: true }]);
  assert.equal(resolveLabel(idx, 'Was'), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/payout.test.mjs`
Expected: FAIL — `resolveLabel(idx, 'Andamanda')` is null.

- [ ] **Step 3: Implement**

```js
export function indexContractsByName(contracts) {
  const idx = new Map();
  // Pass 1: current names. These are absolute — a live merchant's own name can never be taken
  // by another contract's history.
  for (const c of contracts || []) {
    if (!c) continue;
    const k = key(c.merchantName);
    if (k && !idx.has(k)) idx.set(k, c);
  }
  // Pass 2: previous names, only where nothing claims the key already. Archived contracts are
  // skipped for the reason §1d gives about aliases — an ended contract must not reacquire
  // revenue through a name it used to have.
  for (const c of contracts || []) {
    if (!c || c.archived) continue;
    for (const prev of c.previousNames || []) {
      const k = key(prev);
      if (k && !idx.has(k)) idx.set(k, c);
    }
  }
  return idx;
}
```

Add to `WRITABLE` in `routes/contracts.mjs`:

```js
  // Rename and merge history. `previousNames` keeps an old roster or order export resolving
  // (§1d); `mergedInto`/`mergedStoreIds` are what make a merge undoable.
  'previousNames', 'mergedInto', 'mergedStoreIds',
```

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, **259 total**.

- [ ] **Step 5: Deploy both regions and commit**

```bash
git status --short
AWS_DEFAULT_OUTPUT=json ./infra/deploy-lambda-all.sh
git add lambda/revshare-api
git commit -m "feat(payout): a renamed merchant still resolves under the name it had"
```

---

### Task 10: The merge planner

**Files:**
- Create: `lambda/revshare-api/code/merge.mjs`
- Test: `lambda/revshare-api/tests/merge.test.mjs` (create)

**Interfaces:**
- Consumes: nothing (pure, no AWS imports).
- Produces: `termSignature(contract) -> string`; `termsConflict(survivor, losers) -> {conflict: boolean, signatures: string[]}`; `planMerge({survivor, losers, stores, terms}) -> {survivorPatch, loserPatches, storeUpdates}`.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termsConflict, planMerge } from '../code/merge.mjs';

const gp = (p) => ({ type: 'percent', _t: 'gp', _method: 'default', rows: [{ model: 'ALL', percent: p }] });

test('identical terms are no conflict, whatever order their keys are stored in', () => {
  // DynamoDB does not preserve map key order, so two equal rules can stringify differently.
  const a = { rule: { type: 'percent', rows: [{ model: 'ALL', percent: 25 }], _t: 'gp' }, aggregationMode: 'whole' };
  const b = { rule: { _t: 'gp', rows: [{ percent: 25, model: 'ALL' }], type: 'percent' }, aggregationMode: 'whole' };
  assert.equal(termsConflict(a, [b]).conflict, false);
});

test('differing terms are a conflict', () => {
  assert.equal(termsConflict({ rule: gp(30), aggregationMode: 'whole' },
                             [{ rule: gp(35), aggregationMode: 'whole' }]).conflict, true);
});

test('a merge archives the losers and never deletes them', () => {
  const plan = planMerge({
    survivor: { contractId: 's', merchantName: 'Glow', previousNames: [] },
    losers: [{ contractId: 'l1', merchantName: 'GLOW Krabi' }],
    stores: [{ merchantId: 'm1', contractId: 'l1' }, { merchantId: 'm2', contractId: 'other' }],
    terms: null,
  });
  assert.equal(plan.loserPatches[0].archived, true);
  assert.equal(plan.loserPatches[0].mergedInto, 's');
  assert.ok(!('deleted' in plan.loserPatches[0]));
  assert.deepEqual(plan.loserPatches[0].mergedStoreIds, ['m1']);   // exactly what moved
  assert.deepEqual(plan.storeUpdates, [{ merchantId: 'm1', contractId: 's' }]);
  assert.deepEqual(plan.survivorPatch.previousNames, ['GLOW Krabi']);
});

test('chosen terms land on the survivor', () => {
  const plan = planMerge({
    survivor: { contractId: 's', merchantName: 'Central', rule: gp(30), aggregationMode: 'whole' },
    losers: [{ contractId: 'l1', merchantName: 'Central Ladprao', rule: gp(35), aggregationMode: 'whole' }],
    stores: [], terms: { rule: gp(35), aggregationMode: 'per_store', noPayout: false },
  });
  assert.equal(plan.survivorPatch.rule.rows[0].percent, 35);
  assert.equal(plan.survivorPatch.aggregationMode, 'per_store');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test lambda/revshare-api/tests/merge.test.mjs`
Expected: FAIL — cannot find module `../code/merge.mjs`.

- [ ] **Step 3: Implement `merge.mjs`**

```js
// Pure merge planning. No AWS imports — the route does the IO, this decides what the IO is.
// A merge ARCHIVES the losers rather than deleting them: the row, its terms and its history
// stay, which is what makes an undo possible at all and matches how this app already treats
// "gone" (§1b, archived merchants).

export function termSignature(c) {
  if (c?.noPayout) return 'NO_PAYOUT';
  if (!c?.rule) return 'NONE';
  const sort = (v) => Array.isArray(v) ? v.map(sort)
    : (v && typeof v === 'object')
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])]))
      : v;
  return JSON.stringify([sort(c.rule), c.aggregationMode || null]);
}

export function termsConflict(survivor, losers) {
  const signatures = [...new Set([survivor, ...(losers || [])].map(termSignature))];
  return { conflict: signatures.length > 1, signatures };
}

export function planMerge({ survivor, losers, stores, terms }) {
  const loserIds = new Set((losers || []).map(l => l.contractId));
  const moved = (stores || []).filter(s => loserIds.has(s.contractId));
  const byLoser = new Map((losers || []).map(l => [l.contractId, []]));
  for (const s of moved) byLoser.get(s.contractId).push(s.merchantId);

  const names = [...new Set([
    ...(survivor.previousNames || []),
    ...(losers || []).flatMap(l => [l.merchantName, ...(l.previousNames || [])]),
  ].filter(Boolean))];

  return {
    survivorPatch: { previousNames: names, ...(terms || {}) },
    loserPatches: (losers || []).map(l => ({
      contractId: l.contractId, archived: true, mergedInto: survivor.contractId,
      mergedStoreIds: byLoser.get(l.contractId) || [],
    })),
    storeUpdates: moved.map(s => ({ merchantId: s.merchantId, contractId: survivor.contractId })),
  };
}
```

- [ ] **Step 4: Pin the two copies of `termSignature` together**

It now exists twice — in `frontend/app.js` (Task 6, to say whether branches agree) and in
`merge.mjs` (here, to gate the route). The frontend cannot import a Lambda module, so the
duplication is structural; what must not happen is the two drifting, because then the page would
say "terms identical" about a merge the server rejects. Append to `merge.test.mjs`:

```js
import { readFileSync } from 'node:fs';

test('the frontend and the backend agree on what a term set is', () => {
  const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = app.indexOf('function termSignature(');
  let d = 0, src = '';
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) { src = app.slice(i, k + 1); break; } }
  }
  const front = new Function(src + '\nreturn termSignature;')();
  for (const c of [{ rule: gp(25), aggregationMode: 'whole' },
                   { noPayout: true }, {},
                   { rule: { rows: [{ percent: 25, model: 'ALL' }], type: 'percent' }, aggregationMode: 'whole' }]) {
    assert.equal(front(c), termSignature(c), 'termSignature has drifted between app.js and merge.mjs');
  }
});
```

Import `termSignature` alongside the others at the top of the file.

- [ ] **Step 5: Run the tests**

Run: `npm test`
Expected: PASS, **264 total**.

- [ ] **Step 6: Commit**

```bash
git add lambda/revshare-api/code/merge.mjs lambda/revshare-api/tests/merge.test.mjs
git commit -m "feat(merge): plan a merge without performing one"
```

---

### Task 11: The merge route

**Files:**
- Modify: `lambda/revshare-api/code/routes/contracts.mjs`
- Modify: `lambda/revshare-api/code/index.mjs`, `auth.mjs`
- Test: `lambda/revshare-api/tests/auth.test.mjs`

**Interfaces:**
- Consumes: `planMerge`, `termsConflict`, `listMerchants`, `putMerchantsBatch`, `putContract`.
- Produces: `POST /contracts/:id/merge`, 409 on an unresolved terms conflict.

- [ ] **Step 1: Write the failing test**

```js
test('merging requires manageMerchants', () => {
  assert.equal(requiredPermission('POST', '/contracts/01ABC/merge'), 'manageMerchants');
  assert.equal(requiredPermission('POST', '/contracts/01ABC/unmerge'), 'manageMerchants');
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — returns `'admin'`.

- [ ] **Step 3: Implement the route**

```js
// Server-side because re-pointing can touch hundreds of MERCHANT rows: done as N calls from a
// browser, a closed tab leaves a half-merged merchant. Writes go through putMerchantsBatch,
// which chunks duplicate-free and retries UnprocessedItems (§1c).
export async function mergeContractsRoute(event) {
  const id = event.pathParameters?.contractId;
  const body = JSON.parse(event.body || '{}');
  const from = Array.isArray(body.from) ? body.from : [];
  if (!from.length) return resp(400, { error: 'no_sources' });
  if (from.includes(id)) return resp(400, { error: 'cannot_merge_into_itself' });

  const survivor = await getContract(id);
  if (!survivor) return resp(404, { error: 'not_found' });
  const losers = (await Promise.all(from.map(getContract))).filter(Boolean);
  if (losers.length !== from.length) return resp(404, { error: 'source_not_found' });

  // The terms gate. A merge that silently keeps the survivor's rule is a money decision made by
  // omission — on Central that is 51,495 THB a month. The SERVER refuses, so a dialog that
  // forgets to ask cannot cause it.
  const { conflict, signatures } = termsConflict(survivor, losers);
  if (conflict && !body.terms) {
    return resp(409, { error: 'terms_conflict', signatures: signatures.length,
                       merchants: [survivor, ...losers].map(c => c.merchantName) });
  }

  const stores = (await listMerchants()).filter(m => from.includes(m.contractId));
  const plan = planMerge({ survivor, losers, stores, terms: body.terms || null });

  await putMerchantsBatch(plan.storeUpdates.map(u => {
    const row = stores.find(s => s.merchantId === u.merchantId);
    return { ...row, contractId: u.contractId };
  }));
  await putContract({ ...survivor, ...plan.survivorPatch });
  for (const p of plan.loserPatches) {
    const l = losers.find(x => x.contractId === p.contractId);
    await putContract({ ...l, ...p, archivedAt: l.archivedAt || new Date().toISOString() });
  }
  return resp(200, { merged: losers.length, storesMoved: plan.storeUpdates.length });
}
```

Register in `index.mjs`; add both paths to `requiredPermission` as `manageMerchants`.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, **268 total**.

- [ ] **Step 5: Deploy both regions, verify health**

```bash
git status --short
AWS_DEFAULT_OUTPUT=json ./infra/deploy-lambda-all.sh
```
Expected: `TH /healthz: {"ok":true}` and `SG /healthz: {"ok":true}`.

- [ ] **Step 6: Commit**

```bash
git add lambda/revshare-api
git commit -m "feat(api): merge merchants server-side, refusing an unchosen terms conflict"
```

---

### Task 12: Undo a merge

**Files:**
- Modify: `lambda/revshare-api/code/routes/contracts.mjs`
- Test: `lambda/revshare-api/tests/merge.test.mjs`

**Interfaces:**
- Consumes: `mergedStoreIds`, `mergedInto` written by Task 11.
- Produces: `POST /contracts/:id/unmerge` restoring exactly the rows that moved.

- [ ] **Step 1: Write the failing test**

```js
test('an undo restores exactly the rows the merge moved, and no others', () => {
  // The survivor may have gained stores from elsewhere since. Re-pointing "everything that
  // points at the survivor" would steal those; mergedStoreIds is why the plan records them.
  const plan = planUnmerge({
    loser: { contractId: 'l1', merchantName: 'GLOW Krabi', mergedInto: 's',
             mergedStoreIds: ['m1', 'm2'], archived: true },
    stores: [{ merchantId: 'm1', contractId: 's' }, { merchantId: 'm2', contractId: 's' },
             { merchantId: 'm9', contractId: 's' }],
  });
  assert.deepEqual(plan.storeUpdates.map(u => u.merchantId), ['m1', 'm2']);
  assert.equal(plan.loserPatch.archived, false);
  assert.equal(plan.loserPatch.mergedInto, null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `planUnmerge is not exported`.

- [ ] **Step 3: Implement in `merge.mjs` and add the route**

```js
export function planUnmerge({ loser, stores }) {
  const ids = new Set(loser.mergedStoreIds || []);
  return {
    storeUpdates: (stores || []).filter(s => ids.has(s.merchantId))
      .map(s => ({ merchantId: s.merchantId, contractId: loser.contractId })),
    loserPatch: { archived: false, archivedAt: null, mergedInto: null, mergedStoreIds: [] },
  };
}
```

And the route in `routes/contracts.mjs`:

```js
export async function unmergeContractRoute(event) {
  const id = event.pathParameters?.contractId;
  const loser = await getContract(id);
  if (!loser) return resp(404, { error: 'not_found' });
  if (!loser.mergedInto) return resp(400, { error: 'not_merged' });

  const stores = (await listMerchants()).filter(m => m.contractId === loser.mergedInto);
  const plan = planUnmerge({ loser, stores });

  await putMerchantsBatch(plan.storeUpdates.map(u => {
    const row = stores.find(s => s.merchantId === u.merchantId);
    return { ...row, contractId: u.contractId };
  }));
  await putContract({ ...loser, ...plan.loserPatch });
  return resp(200, { restored: plan.storeUpdates.length });
}
```

Note the `archivedAt: null` in `planUnmerge`'s patch: `updateContractRoute` stamps `archivedAt`
server-side only on a false->true transition, so an unmerge must clear it explicitly or the
restored row keeps a stale archive date.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, **266 total**.

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api
git commit -m "feat(api): undo a merge, moving back exactly what it moved"
```

---

### Task 13: Dismissals

**Files:**
- Modify: `lambda/revshare-api/code/db.mjs` (+ SG mirror), `routes/contracts.mjs`, `auth.mjs`
- Modify: `frontend/app.js`

**Interfaces:**
- Consumes: `classifyDifferences`'s dismissal filter (Task 4).
- Produces: `getDismissals()`/`putDismissals(items)`; `GET/PUT /contracts/dismissals`.

- [ ] **Step 1: Write the failing test**

Append to `reconcile-classifier.test.mjs`:

```js
test('a dismissal lapses when the fact behind it changes', () => {
  // "This is correct" answers a specific state. Unarchive the contract and the question is a
  // different one, so the answer must not carry over — otherwise a dismissal becomes a
  // permanent blindfold.
  const dismissals = [{ type: 'archived-in-file', key: 'central', at: '2026-09-18T00:00:00Z' }];
  const upload = { names: ['Central'] };
  const archived = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Central', archived: true }],
    upload, run: null, dismissals });
  assert.equal(archived.length, 0);

  const unarchived = classifyDifferences({
    contracts: [{ contractId: 'c1', merchantName: 'Central' }],
    upload, run: null, dismissals });
  assert.equal(unarchived.length, 0, 'now in the file and live — no longer a difference at all');
});
```

- [ ] **Step 2: Run it, confirm it passes for the right reason**

Run: `node --test lambda/revshare-api/tests/reconcile-classifier.test.mjs`
Expected: PASS — the key changes type when the fact changes, so no extra code is needed. If it
fails, the dismissal key is too coarse and must include the type (it already does in Task 4).

- [ ] **Step 3: Add storage and routes**

In `db.mjs` (and the SG mirror):

```js
export async function getDismissals() {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { pk: 'CONFIG', sk: 'RECONCILE#DISMISSED' } }));
  return { items: out.Item?.items || [] };
}

export async function putDismissals(items) {
  await ddb.send(new PutCommand({
    TableName: TABLE, Item: { pk: 'CONFIG', sk: 'RECONCILE#DISMISSED', items,
                              updatedAt: new Date().toISOString() } }));
  return { items };
}
```

`GET /contracts/dismissals` is open; `PUT` requires `manageMerchants`.

- [ ] **Step 4: Run the preflight and the tests**

```bash
node infra/check-db-exports.mjs lambda/revshare-api/code ~/revshare_sg/lambda/revshare-api/code
npm test
```
Expected: preflight clean in both regions; **267 total**.

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api frontend/app.js
git commit -m "feat(reconcile): let a difference be answered once"
```

---

### Task 14: The actions in the page

**Files:**
- Modify: `frontend/app.js`, `frontend/style.css`, `frontend/service-worker.js` (→ `revshare-v157`)

**Interfaces:**
- Consumes: every route from Tasks 9-13.
- Produces: per-row buttons — *rename to file's name*, *merge into…*, *unarchive*, *adopt terms from…*, *create merchant*, *this is correct*.

- [ ] **Step 1: Every action states what it will do before it does it**

Each button opens a confirm panel naming the exact consequence, e.g. for a merge:

```js
// Say what will move, not just that something will. "Merge 4 merchants" is not a sentence
// anyone can check; "moves 37 store rows onto Glow and archives 4 merchants" is.
function mergeConfirmText(survivor, losers, storeCount) {
  return `Move ${storeCount} store row(s) onto ${survivor.merchantName}, archive `
       + `${losers.length} merchant(s), and keep their names so old reports still match. `
       + `Nothing is deleted — you can undo this.`;
}
```

- [ ] **Step 2: The terms conflict is resolved in the UI, enforced by the server**

When `brand-has-branches` has `sameTerms: false`, the merge button opens a side-by-side chooser
of each member's terms (reusing `payoutFormula(decompileRule(rule))` so the wording matches the
grid), and sends the chosen one as `terms`. If the server still answers 409, show its message —
that means the UI and the data disagreed, and the server is right.

- [ ] **Step 3: Gate every action on `manageMerchants`**

```js
const canFix = can('manageMerchants');
```
Read-only users see the findings and no buttons — the page is worth reading either way.

- [ ] **Step 4: Verify on live data, one correction at a time**

Start with `Jharoka` → `Jharoka by Indus` (a rename, 340 THB at stake, one contract, no terms
conflict). Confirm afterwards: the grid shows the new name, the ⦿ mark is gone, the Reconcile
count dropped by one, and `GET /contracts/<id>` shows `previousNames: ["Jharoka"]`.

- [ ] **Step 5: Commit**

```bash
git status --short
git add frontend/
git commit -m "feat(reconcile): apply the correction each difference needs"
```

---

### Task 15: Analytics keeps a renamed brand as one line

**Files:**
- Modify: `frontend/app.js` (`renderRevsharePathScreen`, ~line 636)
- Test: `lambda/revshare-api/tests/run-view.test.mjs`

**Interfaces:**
- Consumes: `previousNames` on contracts.
- Produces: `currentName(name, contracts) -> string` used when grouping run results.

- [ ] **Step 1: Write the failing test**

```js
test('a renamed brand charts as one line, without touching a stored run', () => {
  // Runs are frozen snapshots and stay that way (§10.5). The chart resolves the frozen name
  // forward instead, so July under the old name and August under the new one are one series.
  const contracts = [{ contractId: 'c1', merchantName: 'Andamanda Phuket', previousNames: ['Andamanda'] }];
  assert.equal(currentName('Andamanda', contracts), 'Andamanda Phuket');
  assert.equal(currentName('Andamanda Phuket', contracts), 'Andamanda Phuket');
  assert.equal(currentName('Someone Else', contracts), 'Someone Else');
});
```

- [ ] **Step 2: Run it and watch it fail**

Expected: FAIL — `currentName` is not defined.

- [ ] **Step 3: Implement and use it**

```js
// Resolve a run's frozen merchant name forward to whatever that contract is called now, so a
// rename does not split a brand's history into two lines. Stored runs are never rewritten.
function currentName(name, contracts) {
  const k = reconcileKey(name);
  for (const c of contracts || []) {
    if (reconcileKey(c.merchantName) === k) return c.merchantName;
    if ((c.previousNames || []).some(p => reconcileKey(p) === k)) return c.merchantName;
  }
  return name;
}
```

In `renderRevsharePathScreen`, group by `currentName(r.merchantName, CONTRACTS)` instead of
`r.merchantName`. `CONTRACTS` may be empty if Analytics is opened first — fall back to the raw
name, which is exactly what `currentName` already does.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS, **271 total**.

- [ ] **Step 5: Commit and deploy**

```bash
git status --short
git add frontend/ lambda/revshare-api/tests
git commit -m "feat(analytics): a renamed brand stays one line"
AWS_DEFAULT_OUTPUT=json ./infra/deploy-frontend.sh
```

---

### Task 16: Document it

**Files:**
- Modify: `CLAUDE.md` (new §1o, and the header date + `CACHE_VERSION`)

- [ ] **Step 1: Write §1o**

Cover: what the tab is; that the upload document is stored per recording import and why
`recordUpload` still gates it; the classifier's types and the **stated limit** that no string
metric pairs `UDON Cher` with `เฌอ`; that merge archives and never deletes; that the terms gate
is server-enforced; `previousNames` precedence (current name always wins, archived excluded);
that Analytics stitches rather than runs being rewritten; and the open business question about
`Central`'s three deals under one roster label.

- [ ] **Step 2: Update the header**

Set the date line and `CACHE_VERSION` to whatever the last frontend task left.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the Reconcile tab, in CLAUDE.md §1o"
```

---

## Notes for whoever executes this

- **Phase 2 is the deliverable; Phase 3 is convenience.** If Phase 2 shows the corrections are
  rare, most of Phase 3 can be skipped — every action in it is doable by hand on existing screens.
- **The `Central` case is not solved by any task here.** Three branches hold three different
  deals and the roster labels every machine `Central`, so only one set of terms can ever be paid.
  The page makes that visible; the resolution is a business decision (spec §10).
- **Do not "fix" the ⦿ marks to include archived rows.** §1m excludes them deliberately; this
  feature answers that question in its own section instead.
