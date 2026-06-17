# revshare run-flow redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bulk runs roster-driven (merchant list defines who's paid, so order-less merchants get fixed fees), behind a 4-step wizard, and let historical runs be archived (locked).

**Architecture:** The pure `engine.mjs` is unchanged — the fix is feeding it a row for every roster machine (rentals/revenue 0) then overlaying orders. New backend helpers do the roster upsert + roster∪orders seeding; new routes add `prepare`/`archive`/`unarchive`. Frontend gains a 4-step wizard (period → merchant list → review/fix no-rule partners inline → order list) and archive UI. Applied to both `revshare-api` (TH) and `revshare-api-sg` (SG).

**Tech Stack:** Node 22 ESM Lambda + DynamoDB single-table; vanilla-JS SPA + SheetJS; `node:test`.

**Spec:** `docs/superpowers/specs/2026-06-17-revshare-run-flow-redesign-design.md`. **Conventions:** patch→deploy→validate→commit; bump SW `CACHE_VERSION`; no `Co-Authored-By:` trailers; deploy backend via `./infra/deploy-lambda-all.sh` (syncs+commits SG in `/Users/ozziewang/revshare_sg`), frontend via `./infra/deploy-frontend.sh`.

---

## File structure

| File | Change |
|---|---|
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | add `buildRosterRows` (pure), `applyMerchantRoster` (DB), rewrite `createBulkRunRoute`, add `prepareBulkRunRoute`/`archiveBulkRunRoute`/`unarchiveBulkRunRoute`, guard delete |
| `lambda/revshare-api/code/index.mjs` | register `POST /bulk-runs/prepare`, `POST /bulk-runs/:id/archive`, `…/unarchive`; pass through to `routeBulkRun` |
| `lambda/revshare-api/code/auth.mjs` | `requiredPermission` for the new sub-paths |
| `lambda/revshare-api/tests/bulk-runs.test.mjs` | **new** — tests for `buildRosterRows` + an engine order-less-fee integration test |
| `frontend/app.js` | merchant-list parser + sample, 4-step wizard, inline rule editor in step 3, archive/unarchive UI |
| `frontend/service-worker.js` | bump `CACHE_VERSION` |

The engine row shape (existing, do not change): `{ storeId, machineSerial, model, rentals, revenue }`. Bulk-run record adds `archived/archivedAt/archivedBy`.

---

## Task 1: Pure roster-seeding (`buildRosterRows`) — TDD

**Files:** Modify `lambda/revshare-api/code/routes/bulk-runs.mjs`; Test `lambda/revshare-api/tests/bulk-runs.test.mjs`.

Roster is authoritative: one engine row per roster machine (rentals/revenue 0), orders overlaid by merchant name; orders whose merchant isn't in the roster are unmatched.

- [ ] **Step 1: Write the failing test**

`lambda/revshare-api/tests/bulk-runs.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterRows } from '../code/routes/bulk-runs.mjs';

// roster: A & B both partner p1 (S8); C partner p2 (S5). Orders only for A and an unknown store.
const roster = [
  { merchantId: 'mA', name: 'Store A', nameLower: 'store a', partnerId: 'p1', model: 'S8' },
  { merchantId: 'mB', name: 'Store B', nameLower: 'store b', partnerId: 'p1', model: 'S8' },
  { merchantId: 'mC', name: 'Store C', nameLower: 'store c', partnerId: 'p2', model: 'S5' },
];
const orders = [
  { merchantName: 'Store A', netAmount: 100 },
  { merchantName: 'Store A', netAmount: 50 },
  { merchantName: 'Ghost Store', netAmount: 9 },
];

test('every roster machine becomes a row; order-less rows are 0; partners grouped', () => {
  const { groups, unmatched, unmatchedOrderCount } = buildRosterRows(roster, orders);
  const p1 = groups['p1'];
  const a = p1.find(r => r.merchantId === 'mA');
  const b = p1.find(r => r.merchantId === 'mB');
  assert.equal(a.rentals, 2); assert.equal(a.revenue, 150);
  assert.equal(b.rentals, 0); assert.equal(b.revenue, 0);   // order-less but present
  assert.equal(groups['p2'][0].merchantId, 'mC');
  assert.equal(groups['p2'][0].rentals, 0);
});

test('orders not in roster are unmatched, not paid', () => {
  const { unmatched, unmatchedOrderCount, unmatchedRevenue } = buildRosterRows(roster, orders);
  assert.deepEqual(unmatched, ['Ghost Store']);
  assert.equal(unmatchedOrderCount, 1);
  assert.equal(unmatchedRevenue, 9);
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `npm test` → FAIL (`buildRosterRows` not exported).

- [ ] **Step 3: Implement `buildRosterRows`** (add to bulk-runs.mjs, export it)

```js
// Roster-authoritative grouping: one row per roster machine (0/0), orders overlaid by
// merchant name; orders with no roster merchant are unmatched (not paid).
export function buildRosterRows(roster, orders) {
  const groups = {};                 // partnerId -> [ {merchantId, merchantName, model, rentals, revenue} ]
  const byName = {};                 // nameLower -> row (for overlay)
  for (const m of roster) {
    if (!m.partnerId) continue;      // unassigned (no Merchant label) — surfaced separately, not paid
    const row = { merchantId: m.merchantId, merchantName: m.name, model: m.model || 'S8', rentals: 0, revenue: 0 };
    (groups[m.partnerId] = groups[m.partnerId] || []).push(row);
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

- [ ] **Step 4: Run — verify pass** (`npm test` → PASS)

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/routes/bulk-runs.mjs lambda/revshare-api/tests/bulk-runs.test.mjs
git commit -m "feat(bulk-runs): buildRosterRows — roster-authoritative seeding (order-less machines included)"
```

---

## Task 2: Engine order-less-fee integration test

Prove the end goal: a roster machine with 0 orders still gets per-machine fixed fees through the real engine. No engine change — just a guard test.

**Files:** Test `lambda/revshare-api/tests/bulk-runs.test.mjs` (append).

- [ ] **Step 1: Write the test**

```js
import { evaluateRun } from '../code/engine.mjs';

test('order-less machine still earns placement (flat_per_machine) via the engine', () => {
  // rule: placement 100/machine for S8, per_store
  const rule = { type: 'flat_per_machine', rows: [{ model: 'S8', amount: 100 }] };
  const { groups } = buildRosterRows(
    [ { merchantId: 'mA', name: 'A', nameLower: 'a', partnerId: 'p1', model: 'S8' },
      { merchantId: 'mB', name: 'B', nameLower: 'b', partnerId: 'p1', model: 'S8' } ],
    [ { merchantName: 'A', netAmount: 100 } ]   // only A has orders
  );
  const rows = groups['p1'].map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
  const res = evaluateRun({ rule, rows, aggregationMode: 'per_store', allowedModels: new Set(['S8']) });
  assert.equal(res.totalPayout, 200);   // both machines paid 100 each, incl. order-less B
});
```

- [ ] **Step 2: Run — should PASS already** (engine handles it). Run `npm test`. If it fails, STOP — the rule/engine shape assumption is wrong; inspect `engine.mjs` `evalFlatPerMachine` and fix the test's rule shape to match (do NOT change the engine).

- [ ] **Step 3: Commit**

```bash
git add lambda/revshare-api/tests/bulk-runs.test.mjs
git commit -m "test(bulk-runs): order-less machine earns per-machine fee through the engine"
```

---

## Task 3: `applyMerchantRoster` — upsert registry + create missing partners

**Files:** Modify `lambda/revshare-api/code/routes/bulk-runs.mjs`.

DB-touching helper shared by `prepare` and `create`. Input: parsed roster `[{ name, nameEn, partnerName, model, externalId }]` (already Approved-filtered by the client). Resolves/creates partners by label name, upserts merchants, returns the resolved roster + readiness.

- [ ] **Step 1: Implement** (add imports `listPartners, putPartner` already present; add `listMerchants, putMerchant` — `listMerchants` already imported, add `putMerchant`)

Update the import line at top of bulk-runs.mjs to include `putMerchant, putPartner`:
```js
import { listMerchants, listPartners, getPartner, putPartner, putMerchant, putBulkRun, listBulkRuns, getBulkRun, deleteBulkRun, listMachineModels, ulid } from '../db.mjs';
```

Add:
```js
// Apply an uploaded merchant roster: create missing partners (by Merchant label = partner
// name, empty rule), upsert each merchant (partner + machine model), and report readiness.
// Returns { roster:[{merchantId,name,nameLower,partnerId,model}], partnersNeedingRules:[],
//           unassigned:[name], newPartners:[name] }.
export async function applyMerchantRoster(merchants) {
  const [partners, existingMerchants] = await Promise.all([listPartners(), listMerchants()]);
  const partnerByName = {};
  for (const p of partners) if (!p.archived) partnerByName[(p.name || '').toLowerCase().trim()] = p;
  const merchantByName = {};
  for (const m of existingMerchants) merchantByName[m.nameLower] = m;

  const roster = [], unassigned = [], newPartners = [];
  const seenPartner = {};   // partnerId -> partner (rule-readiness)

  for (const src of merchants) {
    const label = (src.partnerName || '').trim();
    if (!label || label === '-') { unassigned.push(src.name); continue; }
    let partner = partnerByName[label.toLowerCase()];
    if (!partner) {
      partner = await putPartner({ partnerId: ulid(), name: label, currency: 'THB', aggregationMode: 'per_store', rule: null, notes: '', archived: false, noPayout: false });
      partnerByName[label.toLowerCase()] = partner;
      newPartners.push(label);
    }
    const ex = merchantByName[(src.name || '').toLowerCase().trim()];
    const merchantId = ex?.merchantId || ulid();
    const saved = await putMerchant({ merchantId, createdAt: ex?.createdAt, name: src.name, partnerId: partner.partnerId, machineModel: src.model || null, externalId: src.externalId || ex?.externalId || null, notes: ex?.notes || '' });
    roster.push({ merchantId, name: src.name, nameLower: saved.nameLower, partnerId: partner.partnerId, model: src.model || null });
    seenPartner[partner.partnerId] = partner;
  }

  const partnersNeedingRules = Object.values(seenPartner)
    .filter(p => !p.noPayout && (!p.rule || !p.rule.type))
    .map(p => ({ partnerId: p.partnerId, name: p.name }));

  return { roster, partnersNeedingRules, unassigned, newPartners };
}
```
(Note: `aggregationMode: 'per_store'` for new partners — matches the "summed per merchant" intent for fixed fees; existing partners keep their own mode.)

- [ ] **Step 2: Syntax check** — `node --check lambda/revshare-api/code/routes/bulk-runs.mjs`

- [ ] **Step 3: Commit**

```bash
git add lambda/revshare-api/code/routes/bulk-runs.mjs
git commit -m "feat(bulk-runs): applyMerchantRoster — upsert registry + create missing partners (by Merchant label)"
```

---

## Task 4: `prepareBulkRunRoute` (step 2 of the wizard)

**Files:** Modify `lambda/revshare-api/code/routes/bulk-runs.mjs`.

- [ ] **Step 1: Implement**

```js
// POST /bulk-runs/prepare — apply the uploaded merchant list, return rule-readiness for the wizard.
export async function prepareBulkRunRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const merchants = Array.isArray(body.merchants) ? body.merchants : [];
  if (!merchants.length) return resp(400, { error: 'no_merchants' });
  const { roster, partnersNeedingRules, unassigned, newPartners } = await applyMerchantRoster(merchants);
  const partnerCount = new Set(roster.map(r => r.partnerId)).size;
  return resp(200, { rosterCount: roster.length, partnerCount, newPartners, unassigned, partnersNeedingRules });
}
```

- [ ] **Step 2: Commit** — `git commit -am "feat(bulk-runs): prepareBulkRunRoute"`

---

## Task 5: Rewrite `createBulkRunRoute` (roster-driven)

**Files:** Modify `lambda/revshare-api/code/routes/bulk-runs.mjs`.

- [ ] **Step 1: Replace the body of `createBulkRunRoute`**

```js
export async function createBulkRunRoute(event) {
  const body = JSON.parse(event.body || '{}');
  const { orders = [], merchants = [], periodStart, periodEnd } = body;
  if (!periodStart || !periodEnd) return resp(400, { error: 'missing_fields', required: ['periodStart','periodEnd'] });
  if (!merchants.length) return resp(400, { error: 'no_merchants' });

  // Re-apply roster (idempotent) so the registry is current and we have resolved ids.
  const { roster, unassigned } = await applyMerchantRoster(merchants);
  const machineModelsList = await listMachineModels();
  const allowedModels = new Set(machineModelsList.map(m => m.code));

  const { groups, unmatched, unmatchedOrderCount, unmatchedRevenue } = buildRosterRows(roster, orders);

  const results = [], ruleSnapshots = {}, warnings = [];
  for (const [partnerId, merchantRows] of Object.entries(groups)) {
    const partner = await getPartner(partnerId);
    if (!partner) { warnings.push(`Partner ${partnerId} not found, skipped`); continue; }
    if (partner.noPayout) continue;
    if (!partner.rule || !partner.rule.type) { warnings.push(`Partner "${partner.name}" has no rule, skipped`); continue; }
    const engineRows = merchantRows.map(m => ({ storeId: m.merchantId, machineSerial: m.merchantId, model: m.model, rentals: m.rentals, revenue: m.revenue }));
    let result;
    try { result = evaluateRun({ rule: partner.rule, rows: engineRows, aggregationMode: partner.aggregationMode, allowedModels }); }
    catch (e) { warnings.push(`Partner "${partner.name}" calculation error: ${e.message}`); continue; }
    ruleSnapshots[partnerId] = partner.rule;
    results.push({ partnerId, partnerName: partner.name, currency: partner.currency,
      merchantCount: merchantRows.length,
      rentals: merchantRows.reduce((s, m) => s + m.rentals, 0),
      revenue: merchantRows.reduce((s, m) => s + m.revenue, 0),
      payout: result.totalPayout, merchants: merchantRows, engineResult: result });
  }

  const totalPayout = results.reduce((s, r) => s + r.payout, 0);
  const runId = ulid();
  const bulkRun = {
    runId, periodStart, periodEnd, uploadedAt: new Date().toISOString(),
    orderCount: orders.length,
    merchantCount: Object.values(groups).flat().length,
    partnerCount: results.length,
    rosterCount: roster.length, unassignedCount: unassigned.length,
    unmatchedCount: unmatched.length, unmatchedOrderCount, unmatchedRevenue,
    totalPayout, results, unmatched, unassigned, warnings, ruleSnapshots,
    archived: false, archivedAt: null, archivedBy: null,
  };
  await putBulkRun(bulkRun);
  return resp(201, bulkRun);
}
```

The old `groupOrders` export can stay (unused) or be deleted; leave it to avoid touching tests.

- [ ] **Step 2: `npm test`** (Task 1/2 tests still pass) + `node --check`.

- [ ] **Step 3: Commit** — `git commit -am "feat(bulk-runs): roster-driven createBulkRunRoute (roster ∪ orders)"`

---

## Task 6: Archive / unarchive + delete guard

**Files:** Modify `lambda/revshare-api/code/routes/bulk-runs.mjs`.

- [ ] **Step 1: Implement**

```js
export async function archiveBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  const run = await getBulkRun(id);
  if (!run) return resp(404, { error: 'not_found' });
  run.archived = true; run.archivedAt = new Date().toISOString(); run.archivedBy = event.userEmail || null;
  await putBulkRun(run);
  return resp(200, { ok: true, archived: true });
}
export async function unarchiveBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  const run = await getBulkRun(id);
  if (!run) return resp(404, { error: 'not_found' });
  run.archived = false; run.archivedAt = null; run.archivedBy = null;
  await putBulkRun(run);
  return resp(200, { ok: true, archived: false });
}
```

Guard delete — replace `deleteBulkRunRoute` body:
```js
export async function deleteBulkRunRoute(event) {
  const id = event.pathParameters?.runId;
  if (!id) return resp(400, { error: 'missing_runId' });
  const run = await getBulkRun(id);
  if (run && run.archived) return resp(409, { error: 'archived', message: 'Unarchive before deleting.' });
  await deleteBulkRun(id);
  return resp(200, { ok: true });
}
```
(`event.userEmail` — set in index.mjs after auth; if not present, falls back to null. Verify index sets it; if it uses a different name like `event.user.email`, use that.)

- [ ] **Step 2: Commit** — `git commit -am "feat(bulk-runs): archive/unarchive + delete guard"`

---

## Task 7: Register routes + permissions

**Files:** Modify `lambda/revshare-api/code/index.mjs`, `lambda/revshare-api/code/auth.mjs`.

- [ ] **Step 1: index.mjs — import + routes.** Update import:
```js
import { createBulkRunRoute, listBulkRunsRoute, getBulkRunRoute, deleteBulkRunRoute, prepareBulkRunRoute, archiveBulkRunRoute, unarchiveBulkRunRoute } from './routes/bulk-runs.mjs';
```
Add routes (place the specific `/prepare` and action routes *before* the generic `/bulk-runs/:id` matchers):
```js
    else if (method === 'POST'   && path === '/bulk-runs/prepare')                              result = await prepareBulkRunRoute(event);
    else if (method === 'POST'   && path === '/bulk-runs')                                      result = await createBulkRunRoute(event);
    else if (method === 'GET'    && path === '/bulk-runs')                                      result = await listBulkRunsRoute();
    else if (method === 'POST'   && /^\/bulk-runs\/[^/]+\/archive$/.test(path))                result = await routeBulkRun(event, archiveBulkRunRoute);
    else if (method === 'POST'   && /^\/bulk-runs\/[^/]+\/unarchive$/.test(path))              result = await routeBulkRun(event, unarchiveBulkRunRoute);
    else if (method === 'GET'    && /^\/bulk-runs\/[^/]+$/.test(path))                         result = await routeBulkRun(event, getBulkRunRoute);
    else if (method === 'DELETE' && /^\/bulk-runs\/[^/]+$/.test(path))                         result = await routeBulkRun(event, deleteBulkRunRoute);
```
Ensure `routeBulkRun` extracts `runId` from `/bulk-runs/<id>/...` — its regex `/\/bulk-runs\/([^/]+)/` already captures the id before any `/archive` suffix, so it works unchanged.

- [ ] **Step 2: auth.mjs — `requiredPermission`.** Add BEFORE the generic `/bulk-runs/` line:
```js
  if (path === '/bulk-runs' || path === '/bulk-runs/prepare') return 'runCalcs';
  if (/^\/bulk-runs\/[^/]+\/unarchive$/.test(path)) return 'admin';
  if (/^\/bulk-runs\/[^/]+\/archive$/.test(path)) return 'runCalcs';
  if (path.startsWith('/bulk-runs/')) return 'deleteRuns';   // DELETE
```

- [ ] **Step 3:** `node --check` both files. **Commit** — `git commit -am "feat(api): register bulk-run prepare/archive/unarchive routes + permissions"`

---

## Task 8: Deploy backend (both regions) + smoke test

- [ ] **Step 1:** `./infra/deploy-lambda-all.sh` (commit SG repo if it reports changes).
- [ ] **Step 2:** `curl -sS https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod/healthz` → `{"ok":true}` (and the SG `4qcyojfg79` healthz). Auth-gated routes can't be curled without a token — rely on the frontend test in Task 13.
- [ ] **Step 3:** Commit SG: `git -C /Users/ozziewang/revshare_sg add -A && git -C /Users/ozziewang/revshare_sg commit -m "feat: roster-driven runs + archive (synced from revshare-aws)"`

---

## Task 9: Frontend — merchant-list parser + sample

**Files:** Modify `frontend/app.js`.

- [ ] **Step 1: Add the parser** (reuses existing `readExcel`). Parses the "Businessmen list" columns; Approved-only; model from `device type.` trailing code.

```js
const RS_MODELS = ['S5','S8','S10','T8','T10','T20','T35','L20','L40'];
function parseDeviceModel(deviceType) {
  const s = String(deviceType || '').toUpperCase();
  // trailing model code, e.g. "ADVERTISING PLAYER-S5" -> S5
  const hit = RS_MODELS.filter(m => s.endsWith(m) || s.includes('-' + m) || s.includes(' ' + m));
  return hit.length ? hit.sort((a,b)=>b.length-a.length)[0] : null;
}
async function parseMerchantList(file) {
  const wb = await readExcel(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
  return rows
    .filter(r => String(r['Merchant Review State'] || '').trim().toLowerCase() === 'approved')
    .map(r => ({
      name: String(r['merchant name.'] || '').trim(),
      nameEn: String(r['merchant name (English)'] || '').trim(),
      partnerName: String(r['Merchant label'] || '').trim(),
      model: parseDeviceModel(r['device type.']),
      externalId: String(r['ID'] || '').trim(),
    }))
    .filter(r => r.name);
}
```

- [ ] **Step 2: Sample download** — mirror the 40 columns in file order with one example row. Add a `MERCHANT_LIST_COLUMNS` array (the 40 headers, copy from the spec/template) and a button handler that emits `XLSX.utils.aoa_to_sheet([MERCHANT_LIST_COLUMNS, exampleRow])`. Example row: a row with `merchant name.`='Example Store', `Merchant label`='Example Partner', `device type.`='Advertising Player-S8', `Merchant Review State`='Approved', others blank.

- [ ] **Step 3:** `node --check frontend/app.js`. **Commit** — `git commit -am "feat(ui): merchant-list (Businessmen list) parser + sample download"`

---

## Task 10: Frontend — 4-step wizard

**Files:** Modify `frontend/app.js` (`renderNewBulkRunForm` rewrite).

- [ ] **Step 1: Replace `renderNewBulkRunForm`** with a wizard holding state `{ periodStart, periodEnd, merchants, prepare, orders }`. Render four step panels; only the active/unlocked one is interactive:
  1. **Period** — year/month selects (reuse existing) → sets period → enable Step 2.
  2. **Merchant list** — file input → `parseMerchantList` → `POST /bulk-runs/prepare {merchants}` → store `prepare` result → show preview (`rosterCount`, `partnerCount`, `newPartners.length`, `unassigned.length`) → render Step 3.
  3. **Review rules** (Task 11) — if `prepare.partnersNeedingRules.length` > 0, list them with inline editors and keep Step 4 locked; else show "All partners have rules ✓" and unlock Step 4.
  4. **Order list** — file input → `parseOrderReport` → preview count → **Run** button → `POST /bulk-runs {periodStart, periodEnd, merchants, orders}` → `renderBulkRunDetail(run.runId)`.

Gating: Step 4's file input/Run is disabled while `partnersNeedingRules` is non-empty (re-checked after each inline save by re-fetching `/bulk-runs/prepare` is overkill — instead, after an inline rule save, remove that partner from the in-memory `partnersNeedingRules` list and re-render; unlock when empty).

- [ ] **Step 2:** `node --check`. **Commit** — `git commit -am "feat(ui): 4-step new-run wizard (period → merchant list → review → orders)"`

---

## Task 11: Frontend — inline rule editor in step 3

**Files:** Modify `frontend/app.js`.

Reuse the existing rule-editing logic. `renderRuleTab` is currently nested inside the partner-detail renderer and tied to `#rule`/PUT `/partners/:id`. Extract a reusable `renderRuleEditorInto(container, partner, onSaved)` that builds the share-terms + payout-method form (the same controls `renderRuleTab` uses: `decompileRule(partner.rule)`, the term inputs, `compileRule(form)`) and on Save does `await api('/partners/'+partner.partnerId, { method:'PUT', body: JSON.stringify({ rule, noPayout }) })` then calls `onSaved()`.

- [ ] **Step 1:** Factor the rule-form builder out of `renderRuleTab` into `renderRuleEditorInto(container, partner, onSaved)`; have `renderRuleTab` call it (no behavior change for the partner page).
- [ ] **Step 2:** In wizard Step 3, for each `partnersNeedingRules` entry, fetch the partner (`api('/partners/'+id)`), render an inline editor via `renderRuleEditorInto`; `onSaved` → drop it from the pending list, re-render, unlock Step 4 when empty.
- [ ] **Step 3:** `node --check`. **Commit** — `git commit -am "feat(ui): inline rule editor in the run wizard (fix no-rule partners)"`

---

## Task 12: Frontend — archive / unarchive UI

**Files:** Modify `frontend/app.js`.

- [ ] **Step 1: Run list & detail** — for each run show a **🔒 Locked** badge when `run.archived`. On the run detail:
  - If not archived: **Archive** button → `POST /bulk-runs/<id>/archive` → refresh; keep Delete.
  - If archived: hide/disable Delete; show **Unarchive** button **only when** `me.permissions.admin` (or `can('admin')`) → `POST /bulk-runs/<id>/unarchive` → refresh.
  - Delete handler: if the API returns 409 archived, show "Unarchive first".
- [ ] **Step 2:** `node --check`. **Commit** — `git commit -am "feat(ui): archive/unarchive runs + locked state"`

---

## Task 13: SW bump, deploy, validate

- [ ] **Step 1:** Bump `frontend/service-worker.js` `CACHE_VERSION` `revshare-v69` → `revshare-v70`.
- [ ] **Step 2:** `./infra/deploy-frontend.sh`.
- [ ] **Step 3: Validate end-to-end (user-confirmed)** on https://d2t76jfby056ul.cloudfront.net: New run → pick month → upload the real Businessmen list (preview shows roster/partners/new/unassigned) → Step 3 lists any no-rule partners, fix one inline → unlock → upload order report → Run. Confirm the run detail shows order-less merchants paid (fixed fees) and unmatched orders flagged. Archive the run → Delete blocked → Unarchive (as admin). **User confirms it works.**
- [ ] **Step 4: Commit** — `git commit -am "chore: sw v70 for roster-driven run flow"`

---

## Task 14: Docs

- [ ] Update `CLAUDE.md` (§1b run flow, §6 routes): roster-driven runs, 4-step wizard, merchant-list (Businessmen list) upload, archive lock, new routes/permissions. Commit.

---

## Self-review notes
- **Spec coverage:** wizard (T10), merchant list parse + roster update (T9, T3), review-rules gate + inline edit (T10/T11), roster seeding / order-less fees (T1/T2/T5), mismatch=unmatched (T1/T5), archive lock + admin unarchive + delete guard (T6/T7/T12), both regions (T8), engine untouched + tests (T1/T2). 
- **Deferred-resolved:** merchant-list columns now known (T9) — no placeholders.
- **Type consistency:** roster row `{merchantId,name,nameLower,partnerId,model}` is produced by `applyMerchantRoster`/used by `buildRosterRows`; engine row `{storeId,machineSerial,model,rentals,revenue}` matches existing `evaluateRun`. Run record adds `archived/archivedAt/archivedBy` used by T6/T12.
- **Open risk to verify during build:** the exact admin-email field on `event` (Task 6 `event.userEmail`) and the `can()/me.permissions` shape on the frontend (Task 12) — confirm against `index.mjs`/`app.js` when implementing.
