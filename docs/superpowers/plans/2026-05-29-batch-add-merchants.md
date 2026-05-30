# Batch Add Merchants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two batch-add flows to the Merchants tab — CSV upload (one-shot save) and an inline multi-row form.

**Architecture:** Pure frontend change. Three new top-level JS functions (`parseMerchantCsv`, `showBatchCsvPanel`, `showBatchRowsPanel`) added to `app.js`. `renderMerchantsTab` updated to add two new header buttons and a `#batch-panel-slot` div. Each panel renders into that slot; only one panel can be open at a time. All merchant saves use the existing `POST /merchants` endpoint called in parallel.

**Tech Stack:** Vanilla CSS, vanilla JS, existing `api()` helper.

---

## File map

| File | What changes |
|---|---|
| `frontend/style.css` | Add `.batch-panel`, `.batch-panel-head`, `.batch-panel-title`, `.batch-panel-sub`, `.upload-zone`, `.upload-hint`, `.row-form`, `.add-row-btn` |
| `frontend/app.js` | Update `renderMerchantsTab`; add `parseMerchantCsv`, `showBatchCsvPanel`, `showBatchRowsPanel` |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` to `revshare-v17` |

---

## Task 1: CSS — batch panel styles

**Files:**
- Modify: `frontend/style.css`

- [ ] **Step 1: Confirm baseline tests pass**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 2: Add batch panel CSS**

Find the line `/* ============ HERO (big payout number) ============ */` in `style.css` and insert the following block immediately before it:

```css
/* ============ BATCH MERCHANT PANEL ============ */
.batch-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 18px 20px;
  margin-bottom: 16px;
  box-shadow: 0 1px 3px rgba(15,23,42,.05);
}

.batch-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 14px;
}

.batch-panel-title {
  font-size: 13.5px;
  font-weight: 600;
}

.batch-panel-sub {
  font-size: 12px;
  color: var(--ink-soft);
  margin-top: 3px;
}

.upload-zone {
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-md);
  padding: 24px;
  text-align: center;
  background: var(--surface-muted);
}

.upload-zone p { font-size: 13px; color: var(--ink-soft); margin-bottom: 10px; }
.upload-hint { font-size: 11.5px; color: var(--ink-faint); margin-top: 8px; }

.row-form { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-bottom: 10px; }
.row-form thead th {
  color: var(--ink-faint);
  font-size: 10.5px; font-weight: 600;
  letter-spacing: .06em; text-transform: uppercase;
  padding: 0 6px 8px; text-align: left;
}
.row-form tbody td { padding: 3px 4px; }
.row-form input, .row-form select {
  width: 100%; padding: 6px 9px;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-size: 12.5px; font-family: var(--font-ui);
  background: var(--surface); color: var(--ink);
}
.row-form input:focus, .row-form select:focus {
  outline: none; border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.add-row-btn {
  font-size: 12px; color: var(--accent);
  background: transparent;
  border: 1px dashed var(--accent);
  border-radius: var(--radius-sm);
  padding: 5px 12px; margin-bottom: 12px;
  cursor: pointer; display: block;
}
.add-row-btn:hover { background: var(--accent-soft); }

```

- [ ] **Step 3: Commit**

```bash
git add frontend/style.css
git commit -m "style: batch merchant panel CSS"
```

---

## Task 2: JS — `parseMerchantCsv` pure helper

**Files:**
- Modify: `frontend/app.js` (insert after closing `}` of `showMerchantForm`, around line 573)

- [ ] **Step 1: Insert `parseMerchantCsv` after `showMerchantForm`**

Find the closing `}` of `showMerchantForm` (the function ends around line 573 with `}`). Insert immediately after it:

```js
function parseMerchantCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const MODELS_SET = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);
  let dataLines = lines;
  if (lines[0].toLowerCase().includes('name')) dataLines = lines.slice(1);
  return dataLines
    .map(line => {
      const [rawName, rawModel] = line.split(',');
      const name = (rawName || '').trim();
      const model = (rawModel || '').trim().toUpperCase();
      return { name, model: MODELS_SET.has(model) ? model : null };
    })
    .filter(r => r.name);
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: parseMerchantCsv pure helper"
```

---

## Task 3: JS — `showBatchCsvPanel`

**Files:**
- Modify: `frontend/app.js` (insert after `parseMerchantCsv`)

- [ ] **Step 1: Insert `showBatchCsvPanel` after `parseMerchantCsv`**

```js
function showBatchCsvPanel(partnerId, MODELS, onDone) {
  const slot = document.getElementById('batch-panel-slot');
  slot.innerHTML = `
    <div class="batch-panel">
      <div class="batch-panel-head">
        <div>
          <div class="batch-panel-title">Upload merchants via CSV</div>
          <div class="batch-panel-sub">Columns: <code>name</code> (required), <code>model</code> (optional — S5/S8/S10/T8/T10/T20/T35/L20/L40). Existing names are updated, not duplicated.</div>
        </div>
        <button id="bp-close" class="btn-ghost">✕</button>
      </div>
      <div class="upload-zone">
        <p>Choose a CSV file or drag it here</p>
        <input type="file" id="bp-csv-file" accept=".csv,text/csv" style="display:none">
        <button id="bp-choose" class="btn">Choose file</button>
        <div class="upload-hint">After upload, merchants are saved immediately.</div>
      </div>
      <div id="bp-status" style="margin-top:12px;font-size:13px;"></div>
    </div>`;
  slot.querySelector('#bp-close').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.panel = ''; });
  slot.querySelector('#bp-choose').addEventListener('click', () => slot.querySelector('#bp-csv-file').click());
  slot.querySelector('#bp-csv-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    const status = slot.querySelector('#bp-status');
    status.innerHTML = 'Parsing…';
    try {
      const text = await file.text();
      const rows = parseMerchantCsv(text);
      if (!rows.length) { status.innerHTML = '<span style="color:var(--loss);">No valid rows found in file.</span>'; return; }
      status.innerHTML = `Parsed ${rows.length} merchant(s) — saving…`;
      await Promise.all(rows.map(r => api('/merchants', { method: 'POST', body: JSON.stringify({ name: r.name, machineModel: r.model || null, partnerId }) })));
      status.innerHTML = `<span style="color:var(--gain);">Saved ${rows.length} merchant(s).</span>`;
      setTimeout(onDone, 800);
    } catch (err) {
      status.innerHTML = `<span style="color:var(--loss);">Error: ${escape(err.message)}</span>`;
    }
  });
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: showBatchCsvPanel for merchant CSV upload"
```

---

## Task 4: JS — `showBatchRowsPanel`

**Files:**
- Modify: `frontend/app.js` (insert after `showBatchCsvPanel`)

- [ ] **Step 1: Insert `showBatchRowsPanel` after `showBatchCsvPanel`**

```js
function showBatchRowsPanel(partnerId, MODELS, onDone) {
  const slot = document.getElementById('batch-panel-slot');
  let rows = [{ name: '', model: '' }];

  function draw() {
    const validCount = rows.filter(r => r.name.trim()).length;
    slot.innerHTML = `
      <div class="batch-panel">
        <div class="batch-panel-head">
          <div>
            <div class="batch-panel-title">Add multiple merchants</div>
            <div class="batch-panel-sub">Fill in names and optional models, then save all at once.</div>
          </div>
          <button id="bp-close" class="btn-ghost">✕</button>
        </div>
        <table class="row-form">
          <thead><tr><th style="width:55%">Name</th><th style="width:30%">Model (optional)</th><th style="width:15%"></th></tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr>
                <td><input class="rf-name" data-i="${i}" value="${escape(r.name)}" placeholder="Merchant name…"></td>
                <td><select class="rf-model" data-i="${i}">
                  <option value="">— none —</option>
                  ${MODELS.map(m => `<option ${r.model===m?'selected':''} value="${m}">${m}</option>`).join('')}
                </select></td>
                <td style="text-align:center"><button class="btn-sm rf-del" data-i="${i}" style="color:var(--loss)">✕</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
        <button id="bp-add-row" class="add-row-btn">+ Add row</button>
        <div style="display:flex;gap:8px;">
          <button id="bp-save" class="btn-primary" ${validCount===0?'disabled':''}>Save ${validCount} merchant${validCount!==1?'s':''}</button>
          <button id="bp-cancel" class="btn-ghost">Cancel</button>
        </div>
        <div id="bp-status" style="margin-top:10px;font-size:13px;"></div>
      </div>`;

    slot.querySelector('#bp-close').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.panel = ''; });
    slot.querySelector('#bp-cancel').addEventListener('click', () => { slot.innerHTML = ''; slot.dataset.panel = ''; });
    slot.querySelector('#bp-add-row').addEventListener('click', () => { rows.push({ name: '', model: '' }); draw(); });
    slot.querySelectorAll('.rf-name').forEach(inp => inp.addEventListener('input', e => { rows[+e.target.dataset.i].name = e.target.value; draw(); }));
    slot.querySelectorAll('.rf-model').forEach(sel => sel.addEventListener('change', e => { rows[+e.target.dataset.i].model = e.target.value; draw(); }));
    slot.querySelectorAll('.rf-del').forEach(btn => btn.addEventListener('click', e => {
      const i = +e.target.dataset.i;
      if (rows.length === 1) { rows[0] = { name: '', model: '' }; } else { rows.splice(i, 1); }
      draw();
    }));
    slot.querySelector('#bp-save')?.addEventListener('click', async () => {
      const toSave = rows.filter(r => r.name.trim());
      const status = slot.querySelector('#bp-status');
      slot.querySelector('#bp-save').disabled = true;
      slot.querySelector('#bp-save').textContent = 'Saving…';
      try {
        await Promise.all(toSave.map(r => api('/merchants', { method: 'POST', body: JSON.stringify({ name: r.name.trim(), machineModel: r.model || null, partnerId }) })));
        slot.innerHTML = '';
        onDone();
      } catch (err) {
        status.innerHTML = `<span style="color:var(--loss);">Error: ${escape(err.message)}</span>`;
        slot.querySelector('#bp-save').disabled = false;
        slot.querySelector('#bp-save').textContent = `Save ${toSave.length} merchant${toSave.length!==1?'s':''}`;
      }
    });
  }

  draw();
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: showBatchRowsPanel for inline multi-row merchant add"
```

---

## Task 5: JS — update `renderMerchantsTab`

**Files:**
- Modify: `frontend/app.js` (`renderMerchantsTab`, lines 500–541)

- [ ] **Step 1: Update the header div and add `#batch-panel-slot`**

Find this block inside `renderMerchantsTab`:

```js
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span>${merchants.length} merchant${merchants.length !== 1 ? 's' : ''}</span>
      <button id="add-merchant-btn" class="btn-primary">+ Add merchant</button>
    </div>
    ${merchants.length === 0 ? '<p class="muted">No merchants yet. Add one or import from Excel.</p>' : `
    <table class="ts"><thead><tr><th>Name</th><th>Model</th><th></th></tr></thead><tbody>
      ${merchants.map(m => `
        <tr>
          <td>${escape(m.name)}</td>
          <td>${m.machineModel ? `<span class="badge badge-neutral">${escape(m.machineModel)}</span>` : '—'}</td>
          <td>
            <button class="btn-ghost edit-m" data-id="${m.merchantId}">Edit</button>
            <button class="btn-ghost del-m" data-id="${m.merchantId}">Delete</button>
          </td>
        </tr>`).join('')}
    </tbody></table>`}
    <div id="merchant-form-slot"></div>`;
```

Replace with:

```js
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span>${merchants.length} merchant${merchants.length !== 1 ? 's' : ''}</span>
      <div style="display:flex;gap:6px;">
        <button id="batch-csv-btn" class="btn">↑ CSV upload</button>
        <button id="batch-rows-btn" class="btn">+ Add rows</button>
        <button id="add-merchant-btn" class="btn-primary">+ Add one</button>
      </div>
    </div>
    <div id="batch-panel-slot"></div>
    ${merchants.length === 0 ? '<p class="muted">No merchants yet. Add one or import from Excel.</p>' : `
    <table class="ts"><thead><tr><th>Name</th><th>Model</th><th></th></tr></thead><tbody>
      ${merchants.map(m => `
        <tr>
          <td>${escape(m.name)}</td>
          <td>${m.machineModel ? `<span class="badge badge-neutral">${escape(m.machineModel)}</span>` : '—'}</td>
          <td>
            <button class="btn-ghost edit-m" data-id="${m.merchantId}">Edit</button>
            <button class="btn-ghost del-m" data-id="${m.merchantId}">Delete</button>
          </td>
        </tr>`).join('')}
    </tbody></table>`}
    <div id="merchant-form-slot"></div>`;
```

- [ ] **Step 2: Add batch toggle handlers after the existing `#add-merchant-btn` handler**

Find:

```js
  container.querySelector('#add-merchant-btn')?.addEventListener('click', () => {
    showMerchantForm(partnerId, null, MODELS, () => renderMerchantsTab(partnerId));
  });
```

Add immediately after:

```js
  const batchSlot = container.querySelector('#batch-panel-slot');
  container.querySelector('#batch-csv-btn').addEventListener('click', () => {
    const isOpen = batchSlot.dataset.panel === 'csv';
    batchSlot.dataset.panel = isOpen ? '' : 'csv';
    isOpen ? (batchSlot.innerHTML = '') : showBatchCsvPanel(partnerId, MODELS, () => renderMerchantsTab(partnerId));
  });
  container.querySelector('#batch-rows-btn').addEventListener('click', () => {
    const isOpen = batchSlot.dataset.panel === 'rows';
    batchSlot.dataset.panel = isOpen ? '' : 'rows';
    isOpen ? (batchSlot.innerHTML = '') : showBatchRowsPanel(partnerId, MODELS, () => renderMerchantsTab(partnerId));
  });
```

- [ ] **Step 3: Run tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "feat: batch add merchants — CSV upload and multi-row form"
```

---

## Task 6: Bump cache and deploy

**Files:**
- Modify: `frontend/service-worker.js` (line 1)

- [ ] **Step 1: Bump `CACHE_VERSION`**

Change line 1:

```js
const CACHE_VERSION = 'revshare-v17';
```

- [ ] **Step 2: Run final tests**

```bash
npm test
```
Expected: `pass 47`.

- [ ] **Step 3: Commit**

```bash
git add frontend/service-worker.js
git commit -m "chore: bump cache to v17 for batch add merchants deploy"
```

- [ ] **Step 4: Deploy**

```bash
./infra/deploy-frontend.sh
```

Expected: all files uploaded, `InProgress` invalidation, URL printed.

- [ ] **Step 5: Smoke-check**

Open https://d2t76jfby056ul.cloudfront.net (Cmd+Shift+R). Navigate to any partner → Merchants tab.

Verify:
- Three buttons in header: `↑ CSV upload`, `+ Add rows`, `+ Add one`
- Clicking `↑ CSV upload` opens the CSV panel; clicking again closes it
- Clicking `+ Add rows` opens the row form panel; clicking `↑ CSV upload` while rows panel is open switches panels
- CSV panel: choose a `.csv` file with `name,model` columns → merchants saved → tab refreshes
- Rows panel: type names, select models, click `+ Add row` to add rows, ✕ to remove, `Save N merchants` saves and closes
- `+ Add one` still opens the existing single-add modal
