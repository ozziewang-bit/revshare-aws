# Batch Add Merchants — Design Spec

Date: 2026-05-29

## 1. Goal

Let finance staff add multiple merchants to a partner at once — either by uploading a CSV file or by filling in an inline multi-row form — without having to click "Add one" repeatedly.

## 2. Entry points

The Merchants tab header currently shows:

```
12 merchants                              [+ Add one]
```

It becomes:

```
12 merchants          [↑ CSV upload]  [+ Add rows]  [+ Add one]
```

Only one batch panel can be open at a time. Clicking an active button closes its panel. Clicking the other button switches panels.

---

## 3. Flow A — CSV upload (one-shot, no editing)

### 3.1 Panel

Clicking "↑ CSV upload" expands an inline panel above the merchants table:

- **Title:** "Upload merchants via CSV"
- **Subtitle:** format hint — `name` (required), `model` (optional — S5/S8/S10/T8/T10/T20/T35/L20/L40)
- **Upload zone:** dashed-border area with "Choose a CSV file or drag it here" + "Choose file" button + a small note: "Existing names are updated, not duplicated."
- **✕ Cancel** button top-right closes the panel.

### 3.2 CSV format

```
name,model
BigC Ladphrao,S10
Tops Silom,T35
Villa Market Sukhumvit,
```

- Header row is detected case-insensitively (first row containing the word `name`). If no header, treat all rows as data with column order `name, model`.
- `model` column is optional — can be absent entirely, or blank per-row.
- Unknown model values are silently treated as `null` (no model assigned).
- Empty rows are skipped.
- Parsing is done client-side with plain string splitting (no extra library).

### 3.3 Save behaviour

On file select (no separate "Confirm" button):
1. Parse the CSV.
2. Show a brief status: "Parsed N merchants — saving…"
3. Call `POST /merchants` for each row in parallel (`Promise.all`), body: `{ name, machineModel: model || null, partnerId }`.
4. On success: show "Added N merchants." and refresh the merchants tab.
5. On any error: show the error message in red; rows that succeeded are still saved.

---

## 4. Flow B — Add rows (inline multi-row form)

### 4.1 Panel

Clicking "+ Add rows" expands an inline panel above the merchants table:

- **Title:** "Add multiple merchants"
- **Subtitle:** "Fill in names and optional models, then save all at once."
- **✕ Cancel** button top-right closes the panel.

### 4.2 Row table

A mini-table with columns: **Name** (55%), **Model** (30%), **✕** (15%).

- Starts with one empty row.
- Each row has: a text input for name, a `<select>` for model (options: `— none —` + the 9 model codes), and a ✕ button to remove the row.
- "+ Add row" button (dashed accent border) appends a new empty row.
- The ✕ button on the only remaining row clears it rather than removing it (always keep at least one row).

### 4.3 Submit button

"Save N merchants" where N = count of rows with a non-empty name. Disabled when N = 0.

On click:
1. Collect all rows with non-empty name.
2. Call `POST /merchants` for each in parallel (`Promise.all`), body: `{ name, machineModel: model || null, partnerId }`.
3. On success: close the panel and refresh the merchants tab.
4. On any error: show the error in red; do not close the panel.

---

## 5. CSS additions (`style.css`)

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
.upload-zone .upload-hint { font-size: 11.5px; color: var(--ink-faint); margin-top: 8px; }

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
  padding: 5px 12px; margin-bottom: 12px; cursor: pointer;
  display: block;
}
.add-row-btn:hover { background: var(--accent-soft); }
```

---

## 6. JS additions (`app.js`)

### 6.1 `renderMerchantsTab` header update

Replace the current header row:

```js
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
  <span>${merchants.length} merchant${merchants.length !== 1 ? 's' : ''}</span>
  <button id="add-merchant-btn" class="btn-primary">+ Add merchant</button>
</div>
```

With:

```js
<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
  <span>${merchants.length} merchant${merchants.length !== 1 ? 's' : ''}</span>
  <div style="display:flex;gap:6px;">
    <button id="batch-csv-btn" class="btn">↑ CSV upload</button>
    <button id="batch-rows-btn" class="btn">+ Add rows</button>
    <button id="add-merchant-btn" class="btn-primary">+ Add one</button>
  </div>
</div>
```

Wire toggle handlers (in `renderMerchantsTab`, after rendering):

```js
const batchSlot = document.getElementById('batch-panel-slot');

document.getElementById('batch-csv-btn').addEventListener('click', () => {
  const isOpen = batchSlot.dataset.panel === 'csv';
  batchSlot.dataset.panel = isOpen ? '' : 'csv';
  isOpen ? (batchSlot.innerHTML = '') : showBatchCsvPanel(partnerId, MODELS, () => renderMerchantsTab(partnerId));
});

document.getElementById('batch-rows-btn').addEventListener('click', () => {
  const isOpen = batchSlot.dataset.panel === 'rows';
  batchSlot.dataset.panel = isOpen ? '' : 'rows';
  isOpen ? (batchSlot.innerHTML = '') : showBatchRowsPanel(partnerId, MODELS, () => renderMerchantsTab(partnerId));
});
```

`#batch-panel-slot` is a new `<div id="batch-panel-slot"></div>` inserted between the header row and the merchants table in `renderMerchantsTab`. It is separate from `#merchant-form-slot` (used by the single-add modal, which stays after the table).

### 6.2 `showBatchCsvPanel(partnerId, MODELS, onDone)`

Top-level function. Renders the CSV upload panel into `#batch-panel-slot`.

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

### 6.3 `parseMerchantCsv(text)` — pure helper

```js
function parseMerchantCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const MODELS_SET = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);
  let dataLines = lines;
  // detect header: first line contains 'name' (case-insensitive)
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

### 6.4 `showBatchRowsPanel(partnerId, MODELS, onDone)`

Top-level function. Renders the multi-row form into `#batch-panel-slot`.

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

---

## 7. Files changed

| File | What changes |
|---|---|
| `frontend/style.css` | Add batch panel, upload zone, row-form CSS |
| `frontend/app.js` | Update `renderMerchantsTab` header; add `#batch-panel-slot` div; add `showBatchCsvPanel`, `parseMerchantCsv`, `showBatchRowsPanel` top-level functions |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` |

---

## 8. Success criteria

- "↑ CSV upload" and "+ Add rows" buttons appear in the merchants tab header.
- Clicking a button opens its panel; clicking again closes it; clicking the other switches panels.
- CSV upload: parse a valid CSV, save all rows, refresh tab.
- CSV upload: empty-name rows are skipped; unknown models are saved as null.
- CSV upload: parse error shown in red; panel stays open.
- Add rows: "+ Add row" appends a row; ✕ removes it (last row is cleared not removed).
- Add rows: "Save N merchants" is disabled when no row has a name.
- Add rows: on success, panel closes and tab refreshes.
- All 47 engine/csv tests pass.
