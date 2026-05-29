# Device Types Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store machine model definitions (code + display name) in DynamoDB, expose a CRUD API, add a Device Types management page to the frontend, and update all model dropdowns to show display names fetched from the API.

**Architecture:** New `CONFIG / MODEL#<code>` DDB row family with 4 helper functions in `db.mjs`. New `routes/machine-models.mjs` handles CRUD + auto-seed. `evaluateRun` gains an optional `allowedModels` Set param (backward-compatible). Runs and bulk-runs routes fetch models from DDB and pass to engine. Frontend gains a 4th nav item and a `renderDeviceTypesScreen`. All existing merchant form functions receive `machineModels` objects (code + displayName) instead of a bare string array.

**Tech Stack:** AWS DynamoDB (DocumentClient), Node 22 ESM Lambda, vanilla JS frontend.

---

## File map

| File | What changes |
|---|---|
| `lambda/revshare-api/code/db.mjs` | Add `listMachineModels`, `getMachineModel`, `putMachineModel`, `deleteMachineModel` |
| `lambda/revshare-api/code/engine.mjs` | `validateRows(rows, models)` + `evaluateRun({ …, allowedModels })` |
| `lambda/revshare-api/code/routes/machine-models.mjs` | New — 4 CRUD handlers + auto-seed |
| `lambda/revshare-api/code/index.mjs` | Import + register machine-models routes + `routeMachineModel` helper |
| `lambda/revshare-api/code/routes/runs.mjs` | Fetch models, pass `allowedModels` to `evaluateRun` in create + rerun |
| `lambda/revshare-api/code/routes/bulk-runs.mjs` | Add `listMachineModels` to parallel fetch, pass `allowedModels` |
| `lambda/revshare-api/tests/engine.test.mjs` | Add test for `allowedModels` override |
| `frontend/app.js` | `renderNav` (4th item), `renderDeviceTypesScreen`, update `renderMerchantsTab`, `showMerchantForm`, `showBatchRowsPanel`, `showBatchCsvPanel`, `parseMerchantCsv` |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` to `revshare-v19` |

---

## Task 1: DDB helpers for machine models

**Files:**
- Modify: `lambda/revshare-api/code/db.mjs`

- [ ] **Step 1: Run baseline tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 2: Append machine-models helpers to `db.mjs`**

Add at the end of the file (after the Bulk Runs section):

```js
// ── Machine Models ────────────────────────────────────────────────────────

export async function listMachineModels() {
  const out = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'CONFIG', ':s': 'MODEL#' },
  }));
  return (out.Items || [])
    .map(({ code, displayName }) => ({ code, displayName }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function getMachineModel(code) {
  const out = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { pk: 'CONFIG', sk: `MODEL#${code}` }
  }));
  return out.Item ? { code: out.Item.code, displayName: out.Item.displayName } : null;
}

export async function putMachineModel({ code, displayName }) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'CONFIG', sk: `MODEL#${code}`, code, displayName }
  }));
}

export async function deleteMachineModel(code) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { pk: 'CONFIG', sk: `MODEL#${code}` }
  }));
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 4: Commit**

```bash
git add lambda/revshare-api/code/db.mjs
git commit -m "feat: machine model DDB helpers"
```

---

## Task 2: Engine — optional `allowedModels` param

**Files:**
- Modify: `lambda/revshare-api/code/engine.mjs` (lines 200–215)
- Modify: `lambda/revshare-api/tests/engine.test.mjs`

- [ ] **Step 1: Write the failing test first**

In `lambda/revshare-api/tests/engine.test.mjs`, add after the existing `MACHINE_MODELS` test:

```js
test('evaluateRun respects allowedModels override', () => {
  const customModels = new Set(['CUSTOM']);
  const rule = { type: 'percent', rows: [{ model: 'ALL', percent: 10 }] };
  const rows = [{ storeId: 's1', machineSerial: 'x', model: 'CUSTOM', rentals: 1, revenue: 100 }];
  const result = evaluateRun({ rule, rows, aggregationMode: 'whole', allowedModels: customModels });
  assert.strictEqual(result.totalPayout, 10);
});

test('evaluateRun rejects unknown model when allowedModels provided', () => {
  const customModels = new Set(['CUSTOM']);
  const rule = { type: 'percent', rows: [{ model: 'ALL', percent: 10 }] };
  const rows = [{ storeId: 's1', machineSerial: 'x', model: 'S5', rentals: 1, revenue: 100 }];
  assert.throws(
    () => evaluateRun({ rule, rows, aggregationMode: 'whole', allowedModels: customModels }),
    /unknown machine model: S5/
  );
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test
```
Expected: `pass 47, fail 2` — the two new tests fail.

- [ ] **Step 3: Update `validateRows` and `evaluateRun` in `engine.mjs`**

Find `validateRows` (line ~200) and change it to accept a `models` argument:

```js
function validateRows(rows, models) {
  for (const row of rows) {
    if (!models.has(row.model))
      throw new Error(`unknown machine model: ${row.model}`);
    if (!Number.isInteger(row.rentals) || row.rentals < 0)
      throw new Error(`rentals must be a non-negative integer, got: ${row.rentals}`);
    if (!Number.isFinite(row.revenue))
      throw new Error(`revenue must be a finite number, got: ${row.revenue}`);
  }
}
```

Find `evaluateRun` (line ~211) and update its signature and the `validateRows` call:

```js
export function evaluateRun({ rule, rows, aggregationMode, allowedModels }) {
  if (!rule || typeof rule !== 'object' || !rule.type)
    throw new Error('rule must be a node with a type field');

  const models = allowedModels instanceof Set ? allowedModels : MACHINE_MODELS;
  validateRows(rows, models);
```

Leave everything else in `evaluateRun` unchanged.

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: `pass 49, fail 0`.

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/engine.mjs lambda/revshare-api/tests/engine.test.mjs
git commit -m "feat: evaluateRun accepts optional allowedModels param"
```

---

## Task 3: New machine-models route file

**Files:**
- Create: `lambda/revshare-api/code/routes/machine-models.mjs`

- [ ] **Step 1: Create the file**

```js
import { listMachineModels, getMachineModel, putMachineModel, deleteMachineModel } from '../db.mjs';
import { MACHINE_MODELS } from '../engine.mjs';

async function seedIfEmpty() {
  const existing = await listMachineModels();
  if (existing.length > 0) return existing;
  await Promise.all([...MACHINE_MODELS].map(code => putMachineModel({ code, displayName: code })));
  return [...MACHINE_MODELS]
    .map(code => ({ code, displayName: code }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function listMachineModelsRoute() {
  const models = await seedIfEmpty();
  return resp(200, models);
}

export async function createMachineModelRoute(event) {
  const { code, displayName } = JSON.parse(event.body || '{}');
  if (!code || !displayName) return resp(400, { error: 'missing_fields', required: ['code', 'displayName'] });
  const existing = await getMachineModel(code);
  if (existing) return resp(409, { error: 'code_exists' });
  await putMachineModel({ code, displayName });
  return resp(201, { code, displayName });
}

export async function updateMachineModelRoute(event) {
  const code = event.pathParameters?.code;
  const { displayName } = JSON.parse(event.body || '{}');
  if (!displayName) return resp(400, { error: 'missing_fields', required: ['displayName'] });
  const existing = await getMachineModel(code);
  if (!existing) return resp(404, { error: 'not_found' });
  await putMachineModel({ code, displayName });
  return resp(200, { code, displayName });
}

export async function deleteMachineModelRoute(event) {
  const code = event.pathParameters?.code;
  const existing = await getMachineModel(code);
  if (!existing) return resp(404, { error: 'not_found' });
  await deleteMachineModel(code);
  return resp(204, null);
}

function resp(statusCode, body) {
  if (statusCode === 204) return { statusCode, headers: {}, body: '' };
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 3: Commit**

```bash
git add lambda/revshare-api/code/routes/machine-models.mjs
git commit -m "feat: machine-models CRUD route with auto-seed"
```

---

## Task 4: Wire machine-models route in `index.mjs`

**Files:**
- Modify: `lambda/revshare-api/code/index.mjs`

- [ ] **Step 1: Add import at top of `index.mjs`**

After the existing imports, add:

```js
import {
  listMachineModelsRoute, createMachineModelRoute,
  updateMachineModelRoute, deleteMachineModelRoute
} from './routes/machine-models.mjs';
```

- [ ] **Step 2: Add routes in the handler dispatch block**

Find the line `// Bulk runs` and add the machine-models routes immediately before the final `else result = resp(404, ...)` line:

```js
    // Machine models
    else if (method === 'GET'    && path === '/machine-models')                         result = await listMachineModelsRoute();
    else if (method === 'POST'   && path === '/machine-models')                         result = await createMachineModelRoute(event);
    else if (method === 'PUT'    && /^\/machine-models\/[^/]+$/.test(path))             result = await routeMachineModel(event, updateMachineModelRoute);
    else if (method === 'DELETE' && /^\/machine-models\/[^/]+$/.test(path))             result = await routeMachineModel(event, deleteMachineModelRoute);
```

- [ ] **Step 3: Add the `routeMachineModel` helper function**

Add after the existing `routeBulkRun` function (around line 94):

```js
async function routeMachineModel(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/machine-models\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), code: m?.[1] };
  return fn(event);
}
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/index.mjs
git commit -m "feat: wire machine-models routes in Lambda handler"
```

---

## Task 5: Update `runs.mjs` to pass `allowedModels`

**Files:**
- Modify: `lambda/revshare-api/code/routes/runs.mjs`

- [ ] **Step 1: Add `listMachineModels` to the import**

Change line 1 from:

```js
import { getPartner, putRun, listRuns, getRun, ulid } from '../db.mjs';
```

To:

```js
import { getPartner, putRun, listRuns, getRun, listMachineModels, ulid } from '../db.mjs';
```

- [ ] **Step 2: Fetch models and pass `allowedModels` in `createRunRoute`**

Find the block in `createRunRoute` that calls `evaluateRun` (around line 22). Add the models fetch before the try/catch and pass `allowedModels`:

```js
  const machineModels = await listMachineModels();
  const allowedModels = new Set(machineModels.map(m => m.code));

  let result;
  try {
    result = evaluateRun({
      rule: partner.rule,
      rows: parsed,
      aggregationMode: partner.aggregationMode,
      allowedModels
    });
  } catch (e) {
    return resp(400, { error: 'eval', message: e.message });
  }
```

- [ ] **Step 3: Fetch models and pass `allowedModels` in `rerunRoute`**

Find the `evaluateRun` call in `rerunRoute` (around line 70). Add the models fetch before it:

```js
  const machineModels = await listMachineModels();
  const allowedModels = new Set(machineModels.map(m => m.code));
  const result = evaluateRun({
    rule: partner.rule,
    rows: parsed,
    aggregationMode: partner.aggregationMode,
    allowedModels
  });
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/routes/runs.mjs
git commit -m "feat: runs route passes allowedModels from DDB to evaluateRun"
```

---

## Task 6: Update `bulk-runs.mjs` to pass `allowedModels`

**Files:**
- Modify: `lambda/revshare-api/code/routes/bulk-runs.mjs`

- [ ] **Step 1: Add `listMachineModels` to the import**

Change line 1 from:

```js
import { listMerchants, listPartners, getPartner, putBulkRun, listBulkRuns, getBulkRun, ulid } from '../db.mjs';
```

To:

```js
import { listMerchants, listPartners, getPartner, putBulkRun, listBulkRuns, getBulkRun, listMachineModels, ulid } from '../db.mjs';
```

- [ ] **Step 2: Add `listMachineModels` to the parallel fetch in `createBulkRunRoute`**

Find:

```js
  const [allMerchants, allPartners] = await Promise.all([listMerchants(), listPartners()]);
```

Replace with:

```js
  const [allMerchants, allPartners, machineModelsList] = await Promise.all([listMerchants(), listPartners(), listMachineModels()]);
  const allowedModels = new Set(machineModelsList.map(m => m.code));
```

- [ ] **Step 3: Pass `allowedModels` to `evaluateRun` in `createBulkRunRoute`**

Find:

```js
      result = evaluateRun({ rule: partner.rule, rows: engineRows, aggregationMode: partner.aggregationMode });
```

Replace with:

```js
      result = evaluateRun({ rule: partner.rule, rows: engineRows, aggregationMode: partner.aggregationMode, allowedModels });
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 5: Commit**

```bash
git add lambda/revshare-api/code/routes/bulk-runs.mjs
git commit -m "feat: bulk-runs route passes allowedModels from DDB to evaluateRun"
```

---

## Task 7: Deploy Lambda

- [ ] **Step 1: Deploy**

```bash
./infra/deploy-lambda.sh
```
Expected: `deployed revshare-api`

- [ ] **Step 2: Smoke-check API**

```bash
curl -s https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod/machine-models | python3 -m json.tool | head -20
```
Expected: JSON array of 10 model objects (auto-seeded), each with `code` and `displayName`.

---

## Task 8: Frontend — Device Types page + 4th nav item

**Files:**
- Modify: `frontend/app.js`

- [ ] **Step 1: Add `Device Types` as 4th nav item in `renderNav()`**

Find `renderNav()` and replace its `nav.innerHTML` with:

```js
  nav.innerHTML = `
    <button id="nav-partners" class="nav-btn active">Partners</button>
    <button id="nav-bulk-runs" class="nav-btn">Share Calculation</button>
    <button id="nav-device-types" class="nav-btn">Device Types</button>
    <button id="nav-import" class="nav-btn">Import</button>`;
  nav.querySelector('#nav-partners').addEventListener('click', () => { setActiveNav('nav-partners'); renderPartnersList(); });
  nav.querySelector('#nav-bulk-runs').addEventListener('click', () => { setActiveNav('nav-bulk-runs'); renderBulkRunsList(); });
  nav.querySelector('#nav-device-types').addEventListener('click', () => { setActiveNav('nav-device-types'); renderDeviceTypesScreen(); });
  nav.querySelector('#nav-import').addEventListener('click', () => { setActiveNav('nav-import'); renderImportScreen(); });
```

- [ ] **Step 2: Add `renderDeviceTypesScreen` function**

Insert after `renderImportScreen` (around line 188):

```js
async function renderDeviceTypesScreen() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <div class="page-head">
      <h2>Device Types</h2>
      <button id="add-model-btn" class="btn-primary">+ Add device type</button>
    </div>
    <div id="model-form-slot"></div>
    <div id="models-out">Loading…</div>`;

  document.getElementById('add-model-btn').addEventListener('click', showAddModelForm);

  async function loadModels() {
    const out = document.getElementById('models-out');
    if (!out) return;
    const models = await api('/machine-models');
    if (!models.length) { out.innerHTML = '<p class="muted">No device types yet.</p>'; return; }
    out.innerHTML = `
      <table class="ts">
        <thead><tr><th>Display Name</th><th>Code</th><th></th></tr></thead>
        <tbody>
          ${models.map(m => `
            <tr id="model-row-${escape(m.code)}">
              <td>${escape(m.displayName)}</td>
              <td><span class="badge badge-neutral">${escape(m.code)}</span></td>
              <td>
                <button class="btn-ghost edit-model" data-code="${escape(m.code)}" data-dn="${escape(m.displayName)}">Edit</button>
                <button class="btn-ghost del-model" data-code="${escape(m.code)}" style="color:var(--loss)">Delete</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
    out.querySelectorAll('.edit-model').forEach(btn => {
      btn.addEventListener('click', () => showEditModelForm(btn.dataset.code, btn.dataset.dn));
    });
    out.querySelectorAll('.del-model').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete device type "${btn.dataset.code}"? Merchants with this model will keep their existing value.`)) return;
        await api('/machine-models/' + btn.dataset.code, { method: 'DELETE' });
        loadModels();
      });
    });
  }

  function showAddModelForm() {
    const slot = document.getElementById('model-form-slot');
    slot.innerHTML = `
      <div class="batch-panel" style="max-width:480px;margin-bottom:16px;">
        <div class="batch-panel-head">
          <div class="batch-panel-title">Add device type</div>
          <button id="mf-close" class="btn-ghost">✕</button>
        </div>
        <label style="display:block;margin-bottom:10px;font-size:12.5px;color:var(--ink-soft);">Display name
          <input id="mf-dn" style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13.5px;" placeholder="e.g. Advertising Player-S5">
        </label>
        <label style="display:block;margin-bottom:14px;font-size:12.5px;color:var(--ink-soft);">Code (immutable)
          <input id="mf-code" style="display:block;margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13.5px;font-family:var(--font-mono);" placeholder="e.g. S5">
        </label>
        <div style="display:flex;gap:8px;">
          <button id="mf-save" class="btn-primary">Save</button>
          <button id="mf-cancel" class="btn-ghost">Cancel</button>
        </div>
        <div id="mf-err" style="margin-top:8px;font-size:13px;color:var(--loss);"></div>
      </div>`;
    slot.querySelector('#mf-close').addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('#mf-cancel').addEventListener('click', () => { slot.innerHTML = ''; });
    slot.querySelector('#mf-save').addEventListener('click', async () => {
      const displayName = slot.querySelector('#mf-dn').value.trim();
      const code = slot.querySelector('#mf-code').value.trim().toUpperCase();
      const err = slot.querySelector('#mf-err');
      if (!displayName || !code) { err.textContent = 'Both fields are required.'; return; }
      try {
        await api('/machine-models', { method: 'POST', body: JSON.stringify({ code, displayName }) });
        slot.innerHTML = '';
        loadModels();
      } catch (e) {
        err.textContent = e.message.includes('409') ? 'Code already exists.' : escape(e.message);
      }
    });
  }

  function showEditModelForm(code, currentDn) {
    const row = document.getElementById(`model-row-${code}`);
    if (!row) return;
    row.innerHTML = `
      <td><input id="mf-edit-dn" style="width:100%;padding:6px 9px;border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px;" value="${escape(currentDn)}"></td>
      <td><span class="badge badge-neutral">${escape(code)}</span></td>
      <td style="display:flex;gap:4px;">
        <button id="mf-edit-save" class="btn-primary" style="padding:5px 12px;font-size:12px;">Save</button>
        <button id="mf-edit-cancel" class="btn-ghost" style="padding:5px 12px;font-size:12px;">Cancel</button>
      </td>`;
    row.querySelector('#mf-edit-cancel').addEventListener('click', () => loadModels());
    row.querySelector('#mf-edit-save').addEventListener('click', async () => {
      const displayName = row.querySelector('#mf-edit-dn').value.trim();
      if (!displayName) return;
      await api('/machine-models/' + code, { method: 'PUT', body: JSON.stringify({ displayName }) });
      loadModels();
    });
  }

  loadModels();
}
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "feat: Device Types page and 4th nav item"
```

---

## Task 9: Frontend — update merchant dropdowns to use DDB models

**Files:**
- Modify: `frontend/app.js`

All four functions (`renderMerchantsTab`, `showMerchantForm`, `showBatchRowsPanel`, `showBatchCsvPanel`) and the pure helper `parseMerchantCsv` need updating.

- [ ] **Step 1: Update `renderMerchantsTab` to fetch machine models from API**

Find the current `renderMerchantsTab` and replace:

```js
  const all = await api('/merchants');
  const merchants = all.filter(m => m.partnerId === partnerId);
  const MODELS = ['S5','S8','S10','T8','T10','T20','T35','L20','L40'];
```

With:

```js
  const [all, machineModels] = await Promise.all([api('/merchants'), api('/machine-models')]);
  const merchants = all.filter(m => m.partnerId === partnerId);
```

Then find the three call sites that pass `MODELS` and change each to `machineModels`:

```js
// in #add-merchant-btn handler:
showMerchantForm(partnerId, null, machineModels, () => renderMerchantsTab(partnerId));

// in .edit-m handler:
showMerchantForm(partnerId, m, machineModels, () => renderMerchantsTab(partnerId));

// in batch toggle handlers:
showBatchCsvPanel(partnerId, machineModels, () => renderMerchantsTab(partnerId))
showBatchRowsPanel(partnerId, machineModels, () => renderMerchantsTab(partnerId))
```

- [ ] **Step 2: Update `showMerchantForm` to use `machineModels` objects**

Find the full `showMerchantForm` function signature and the select options inside it. The current signature is:

```js
function showMerchantForm(partnerId, existing, MODELS, onDone) {
```

Change to:

```js
function showMerchantForm(partnerId, existing, machineModels, onDone) {
```

Find the select options block inside:

```js
          ${MODELS.map(m => `<option ${existing?.machineModel===m?'selected':''} value="${m}">${m}</option>`).join('')}
```

Replace with:

```js
          ${machineModels.map(m => `<option ${existing?.machineModel===m.code?'selected':''} value="${m.code}">${escape(m.displayName)}</option>`).join('')}
```

- [ ] **Step 3: Update `showBatchRowsPanel` to use `machineModels` objects**

Find the function signature:

```js
function showBatchRowsPanel(partnerId, MODELS, onDone) {
```

Change to:

```js
function showBatchRowsPanel(partnerId, machineModels, onDone) {
```

Find the select options block inside `draw()`:

```js
                  <option value="">— select —</option>
                  ${MODELS.map(m => `<option ${r.model===m?'selected':''} value="${m}">${m}</option>`).join('')}
```

Replace with:

```js
                  <option value="">— select —</option>
                  ${machineModels.map(m => `<option ${r.model===m.code?'selected':''} value="${m.code}">${escape(m.displayName)}</option>`).join('')}
```

- [ ] **Step 4: Update `showBatchCsvPanel` and `parseMerchantCsv`**

Find `showBatchCsvPanel` signature:

```js
function showBatchCsvPanel(partnerId, MODELS, onDone) {
```

Change to:

```js
function showBatchCsvPanel(partnerId, machineModels, onDone) {
```

Find where `parseMerchantCsv` is called inside `showBatchCsvPanel`:

```js
      const allRows = parseMerchantCsv(text);
```

Replace with:

```js
      const validCodes = new Set(machineModels.map(m => m.code));
      const allRows = parseMerchantCsv(text, validCodes);
```

Find `parseMerchantCsv` function signature:

```js
function parseMerchantCsv(text) {
```

Change to:

```js
function parseMerchantCsv(text, validCodes) {
```

Find the internal `MODELS_SET` line:

```js
  const MODELS_SET = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);
```

Replace with:

```js
  const MODELS_SET = validCodes instanceof Set ? validCodes : new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40','M10']);
```

- [ ] **Step 5: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js
git commit -m "feat: merchant dropdowns fetch device types from API, show display names"
```

---

## Task 10: Bump cache and deploy frontend

**Files:**
- Modify: `frontend/service-worker.js`

- [ ] **Step 1: Bump `CACHE_VERSION`**

Change line 1 to:

```js
const CACHE_VERSION = 'revshare-v19';
```

- [ ] **Step 2: Run final tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 3: Commit**

```bash
git add frontend/service-worker.js
git commit -m "chore: bump cache to v19 for device types deploy"
```

- [ ] **Step 4: Deploy frontend**

```bash
./infra/deploy-frontend.sh
```
Expected: all files uploaded, `InProgress` invalidation, URL printed.

- [ ] **Step 5: Smoke-check**

Open https://d2t76jfby056ul.cloudfront.net (Cmd+Shift+R).

Verify:
- Nav has 4 items: Partners | Share Calculation | Device Types | Import
- Device Types page loads the 10 seeded models (codes as display names initially)
- Edit a display name (e.g. change "S5" to "Advertising Player-S5") — saves and refreshes
- Open any partner → Merchants tab → "+ Add one" dropdown shows updated display names
- "+ Add rows" panel shows display names in model column
- "↑ CSV upload" sample CSV still downloads correctly
