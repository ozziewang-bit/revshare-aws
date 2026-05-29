# Rule Editor Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-device-type placement fees in the rule editor, rule setting on new partner creation, and read-only Rule tab with an Edit button.

**Architecture:** Pure frontend changes (Tasks 1–4) plus a one-line backend change (Task 5). `compileRule`/`decompileRule` gain a `placementRows` array instead of a scalar. `renderStructuredRuleEditor` gains `machineModels` and `{ readOnly }` params. The Rule tab renders lazily on click, defaulting to view mode. `renderNewPartnerForm` becomes async and embeds the editor.

**Tech Stack:** Vanilla JS, existing CSS classes (`.row-form`, `.add-row-btn` from prior work).

---

## File map

| File | What changes |
|---|---|
| `frontend/app.js` | `compileRule`, `decompileRule`, `renderStructuredRuleEditor`, `renderPartnerDetail`, `renderNewPartnerForm` |
| `lambda/revshare-api/code/routes/partners.mjs` | `createPartnerRoute` reads `body.rule` |
| `frontend/service-worker.js` | Bump `CACHE_VERSION` to `revshare-v21` |

---

## Task 1: Update `compileRule` and `decompileRule`

**Files:**
- Modify: `frontend/app.js` (lines 8–41)

- [ ] **Step 1: Confirm baseline**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 2: Replace `compileRule`**

Find the entire `compileRule` function (lines 8–21) and replace:

```js
function compileRule({ gpPercent, mgEnabled, mgAmount, electricity, placementRows, others }) {
  const children = [];
  const gpLeaf = { type: 'percent', rows: [{ model: 'ALL', percent: Number(gpPercent) }] };
  if (mgEnabled && Number(mgAmount) > 0) {
    children.push({ type: 'max', children: [gpLeaf, { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: Number(mgAmount) }] }] });
  } else {
    children.push(gpLeaf);
  }
  if (Number(electricity) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(electricity) });
  const validPlacement = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  if (validPlacement.length) children.push({ type: 'flat_per_machine', rows: validPlacement.map(r => ({ model: r.model, amount: Number(r.amount) })) });
  if (Number(others) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(others) });
  if (children.length === 1) return children[0];
  return { type: 'sum', children };
}
```

- [ ] **Step 3: Replace `decompileRule`**

Find the entire `decompileRule` function (lines 23–41) and replace:

```js
function decompileRule(rule) {
  if (!rule) return { gpPercent: 0, mgEnabled: false, mgAmount: 0, electricity: 0, placementRows: [], others: 0 };
  const nodes = rule.type === 'sum' ? (rule.children || []) : [rule];
  let gpPercent = 0, mgEnabled = false, mgAmount = 0;
  const flatAmounts = [];
  let placementRows = [];
  for (const node of nodes) {
    if (node.type === 'percent') {
      gpPercent = node.rows?.[0]?.percent ?? 0;
    } else if (node.type === 'max') {
      const pc = node.children?.find(c => c.type === 'percent');
      const fc = node.children?.find(c => c.type === 'flat_per_machine');
      if (pc) gpPercent = pc.rows?.[0]?.percent ?? 0;
      if (fc) { mgEnabled = true; mgAmount = fc.rows?.[0]?.amount ?? 0; }
    } else if (node.type === 'flat_per_partner_total') {
      flatAmounts.push(node.amount ?? 0);
    } else if (node.type === 'flat_per_machine') {
      // top-level flat_per_machine = placement rows (new format)
      placementRows = (node.rows || []).map(r => ({ model: r.model, amount: r.amount ?? 0 }));
    }
  }
  // New format: electricity = flatAmounts[0], others = flatAmounts[1]
  // Old 3-value format: electricity = flatAmounts[0], old_placement (dropped) = flatAmounts[1], others = flatAmounts[2]
  const electricity = flatAmounts[0] ?? 0;
  const others = flatAmounts.length >= 3 ? (flatAmounts[2] ?? 0) : (flatAmounts[1] ?? 0);
  return { gpPercent, mgEnabled, mgAmount, electricity, placementRows, others };
}
```

- [ ] **Step 4: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 5: Commit**

```bash
git add frontend/app.js
git commit -m "feat: compileRule/decompileRule support per-model placement rows"
```

---

## Task 2: Update `renderStructuredRuleEditor`

**Files:**
- Modify: `frontend/app.js` (`renderStructuredRuleEditor`, lines 484–540)

- [ ] **Step 1: Replace the entire `renderStructuredRuleEditor` function**

Find the function from `function renderStructuredRuleEditor(container, initialRule) {` through its closing `}` (lines 484–540) and replace with:

```js
function renderStructuredRuleEditor(container, initialRule, machineModels, { readOnly = false } = {}) {
  let form = decompileRule(initialRule);
  let rawMode = false;
  let rawJson = JSON.stringify(initialRule || { type: 'sum', children: [] }, null, 2);

  function d(cond) { return (readOnly || cond) ? 'disabled' : ''; }

  function syncPlacement() {
    const models = container.querySelectorAll('.pl-model');
    const amts   = container.querySelectorAll('.pl-amt');
    form.placementRows = Array.from(models).map((sel, i) => ({
      model: sel.value,
      amount: Number(amts[i]?.value || 0)
    }));
  }

  function draw() {
    container.innerHTML = `
      <div class="rule-form">
        <div class="rf-row"><label>GP Share %</label>
          <input id="rf-gp" type="number" min="0" max="100" step="0.1" value="${form.gpPercent}" ${d(rawMode)}></div>
        <div class="rf-row">
          <label><input id="rf-mg-toggle" type="checkbox" ${form.mgEnabled?'checked':''} ${d(rawMode)}> Minimum guarantee (THB / machine / month)</label>
          <input id="rf-mg-amt" type="number" min="0" value="${form.mgAmount}" ${d(!form.mgEnabled||rawMode)}></div>
        <div class="rf-row"><label>Monthly electricity (THB)</label>
          <input id="rf-elec" type="number" min="0" value="${form.electricity}" ${d(rawMode)}></div>
        <div style="margin:10px 0 6px"><label style="font-size:12.5px;color:var(--ink-soft);">Monthly placement — per machine type</label></div>
        <table class="row-form">
          <thead><tr>
            <th style="width:50%">Device type</th>
            <th style="width:35%">Amount (THB/month)</th>
            ${readOnly ? '' : '<th style="width:15%"></th>'}
          </tr></thead>
          <tbody>
            ${(form.placementRows || []).map((r, i) => `<tr>
              <td><select class="pl-model" data-i="${i}" ${d(rawMode)}>
                <option value="">— select —</option>
                ${(machineModels || []).map(m => `<option value="${escape(m.code)}" ${r.model===m.code?'selected':''}>${escape(m.displayName)}</option>`).join('')}
              </select></td>
              <td><input class="pl-amt" data-i="${i}" type="number" min="0" value="${r.amount||0}" ${d(rawMode)}></td>
              ${readOnly ? '' : `<td style="text-align:center"><button class="pl-del btn-ghost" data-i="${i}" style="color:var(--loss);padding:4px 8px;font-size:13px;" ${rawMode?'disabled':''}>✕</button></td>`}
            </tr>`).join('')}
            ${(!readOnly && !rawMode) ? '<tr><td colspan="3" style="padding-top:4px"><button id="pl-add" class="add-row-btn">+ Add device type</button></td></tr>' : ''}
          </tbody>
        </table>
        <div class="rf-row"><label>Monthly others (THB)</label>
          <input id="rf-others" type="number" min="0" value="${form.others}" ${d(rawMode)}></div>
        ${readOnly ? '' : `<details ${rawMode?'open':''}>
          <summary style="cursor:pointer;color:#868e96;font-size:13px;">Advanced (raw JSON)</summary>
          <textarea id="rf-json" rows="10" style="width:100%;font-family:monospace;font-size:12px;">${escape(rawJson)}</textarea>
          <label style="font-size:13px;"><input id="rf-raw-mode" type="checkbox" ${rawMode?'checked':''}> Use raw JSON (overrides form above)</label>
        </details>`}
      </div>`;

    if (readOnly) return;

    container.querySelector('#rf-mg-toggle')?.addEventListener('change', e => {
      syncPlacement();
      form.mgEnabled = e.target.checked;
      draw();
    });
    container.querySelector('#rf-raw-mode')?.addEventListener('change', e => {
      syncPlacement();
      rawMode = e.target.checked;
      if (!rawMode) {
        try { form = decompileRule(JSON.parse(container.querySelector('#rf-json').value)); } catch(_) {}
      }
      draw();
    });
    container.querySelector('#pl-add')?.addEventListener('click', () => {
      syncPlacement();
      form.placementRows.push({ model: '', amount: 0 });
      draw();
    });
    container.querySelectorAll('.pl-del').forEach(btn => btn.addEventListener('click', e => {
      syncPlacement();
      form.placementRows.splice(+e.target.dataset.i, 1);
      draw();
    }));
  }

  draw();

  return {
    getRule() {
      if (rawMode) {
        const ta = container.querySelector('#rf-json');
        return JSON.parse(ta.value);
      }
      form.gpPercent   = Number(container.querySelector('#rf-gp')?.value    || 0);
      form.mgEnabled   = container.querySelector('#rf-mg-toggle')?.checked  || false;
      form.mgAmount    = Number(container.querySelector('#rf-mg-amt')?.value || 0);
      form.electricity = Number(container.querySelector('#rf-elec')?.value   || 0);
      form.others      = Number(container.querySelector('#rf-others')?.value || 0);
      syncPlacement();
      return compileRule(form);
    }
  };
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: rule editor supports per-model placement table and readOnly mode"
```

---

## Task 3: Rule tab — view/edit mode in `renderPartnerDetail`

**Files:**
- Modify: `frontend/app.js` (`renderPartnerDetail`, lines 542–625)

- [ ] **Step 1: Update `tab-rule-content` HTML**

Inside `renderPartnerDetail`, find this HTML block in the template literal:

```js
    <div id="tab-rule-content" style="display:none">
      <div id="rule-editor-container"></div>
      <button id="save-rule" class="btn-primary" style="margin-top:12px;">Save rule</button>
    </div>
```

Replace with:

```js
    <div id="tab-rule-content" style="display:none">
      <div id="rule-edit-bar" style="display:flex;justify-content:flex-end;margin-bottom:14px;"></div>
      <div id="rule-editor-container"></div>
    </div>
```

- [ ] **Step 2: Remove the eager editor init and `save-rule` handler**

Find and remove these three lines (after the `back`/`new-run` listeners):

```js
  const ruleContainer = document.getElementById('rule-editor-container');
  const editor = renderStructuredRuleEditor(ruleContainer, p.rule);

  document.getElementById('save-rule').addEventListener('click', async () => {
    let rule;
    try { rule = editor.getRule(); } catch(e) { alert('Invalid JSON: ' + e.message); return; }
    await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule }) });
    alert('Saved');
    renderPartnerDetail(partnerId);
  });
```

- [ ] **Step 3: Add `renderRuleTab`, `showRuleView`, `showRuleEdit` inner functions**

Add these three inner functions inside `renderPartnerDetail`, after the `renderMerchantsTab(partnerId)` call and before `renderRunsHistory`:

```js
  async function renderRuleTab() {
    const machineModels = await api('/machine-models');
    showRuleView(machineModels);
  }

  function showRuleView(machineModels) {
    const bar = document.getElementById('rule-edit-bar');
    const ruleContainer = document.getElementById('rule-editor-container');
    if (!bar || !ruleContainer) return;
    bar.innerHTML = `
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink-soft);background:var(--surface-muted);border:1px solid var(--border);border-radius:99px;padding:4px 12px;margin-right:8px;">👁 View only</span>
      <button id="edit-rule-btn" class="btn-primary" style="padding:6px 14px;font-size:12.5px;">Edit rule</button>`;
    renderStructuredRuleEditor(ruleContainer, p.rule, machineModels, { readOnly: true });
    document.getElementById('edit-rule-btn').addEventListener('click', () => showRuleEdit(machineModels));
  }

  function showRuleEdit(machineModels) {
    const bar = document.getElementById('rule-edit-bar');
    const ruleContainer = document.getElementById('rule-editor-container');
    if (!bar || !ruleContainer) return;
    const editor = renderStructuredRuleEditor(ruleContainer, p.rule, machineModels, { readOnly: false });
    bar.innerHTML = `
      <button id="cancel-rule-btn" class="btn-ghost" style="margin-right:6px;">Cancel</button>
      <button id="save-rule-btn" class="btn-primary" style="padding:6px 14px;font-size:12.5px;">Save rule</button>`;
    document.getElementById('cancel-rule-btn').addEventListener('click', () => showRuleView(machineModels));
    document.getElementById('save-rule-btn').addEventListener('click', async () => {
      let rule;
      try { rule = editor.getRule(); } catch(e) { alert('Invalid JSON: ' + e.message); return; }
      const btn = document.getElementById('save-rule-btn');
      btn.disabled = true; btn.textContent = 'Saving…';
      await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule }) });
      p.rule = rule;
      showRuleView(machineModels);
    });
  }
```

- [ ] **Step 4: Wire the Rule tab click to call `renderRuleTab()`**

Find the tab click handler block:

```js
      if (t === 'merchants') renderMerchantsTab(partnerId);
      if (t === 'runs') renderRunsHistory();
```

Add a line:

```js
      if (t === 'merchants') renderMerchantsTab(partnerId);
      if (t === 'rule') renderRuleTab();
      if (t === 'runs') renderRunsHistory();
```

- [ ] **Step 5: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js
git commit -m "feat: Rule tab defaults to view mode with Edit rule button"
```

---

## Task 4: Rule editor in new partner form

**Files:**
- Modify: `frontend/app.js` (`renderNewPartnerForm`, lines 452–482)

- [ ] **Step 1: Replace the entire `renderNewPartnerForm` function**

Find from `function renderNewPartnerForm() {` through its closing `}` (lines 452–482) and replace with:

```js
async function renderNewPartnerForm() {
  const main = document.getElementById('main');
  main.innerHTML = `
    <button class="back-link" id="back">← Partners</button>
    <h2>New partner</h2>
    <p class="muted" style="margin-bottom:18px;">Currency and aggregation mode are fixed once set.</p>
    <form id="new-partner-form">
      <label>Name <input name="name" required></label>
      <label>Currency
        <select name="currency">${CURRENCIES.map(c => `<option>${c}</option>`).join('')}</select>
      </label>
      <label>Aggregation mode
        <select name="aggregationMode"><option value="per_store">per store (one calc per store, summed)</option><option value="whole">whole partner (one calc over all rows)</option></select>
      </label>
      <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:14px;">Revenue rule <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional — can be set later)</span></div>
        <div id="new-rule-container"></div>
      </div>
      <div>
        <button type="submit" class="btn-primary">Create partner</button>
        <button type="button" id="cancel-new">Cancel</button>
      </div>
    </form>`;
  document.getElementById('back').addEventListener('click', renderPartnersList);
  document.getElementById('cancel-new').addEventListener('click', renderPartnersList);

  const machineModels = await api('/machine-models');
  const editor = renderStructuredRuleEditor(
    document.getElementById('new-rule-container'),
    null,
    machineModels
  );

  document.getElementById('new-partner-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    let rule;
    try { rule = editor.getRule(); } catch(e) { alert('Invalid rule JSON: ' + e.message); return; }
    const body = { name: fd.get('name'), currency: fd.get('currency'), aggregationMode: fd.get('aggregationMode'), rule };
    try {
      const p = await api('/partners', { method: 'POST', body: JSON.stringify(body) });
      renderPartnerDetail(p.partnerId);
    } catch (e) { alert(e.message); }
  });
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "feat: rule editor embedded in new partner creation form"
```

---

## Task 5: Backend — `createPartnerRoute` accepts rule

**Files:**
- Modify: `lambda/revshare-api/code/routes/partners.mjs` (lines 8–26)

- [ ] **Step 1: Update `createPartnerRoute` to read `rule` from body**

Find this block in `createPartnerRoute`:

```js
  const partner = {
    partnerId: ulid(),
    name, currency, aggregationMode,
    rule: { type: 'sum', children: [] },
    notes: '',
    archived: false
  };
```

Replace with:

```js
  const partner = {
    partnerId: ulid(),
    name, currency, aggregationMode,
    rule: body.rule || { type: 'sum', children: [] },
    notes: '',
    archived: false
  };
```

- [ ] **Step 2: Run tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 3: Commit**

```bash
git add lambda/revshare-api/code/routes/partners.mjs
git commit -m "feat: createPartnerRoute accepts initial rule from request body"
```

---

## Task 6: Deploy Lambda + bump cache + deploy frontend

**Files:**
- Modify: `frontend/service-worker.js`

- [ ] **Step 1: Deploy Lambda**

```bash
./infra/deploy-lambda.sh
```
Expected: `deployed revshare-api`

- [ ] **Step 2: Bump `CACHE_VERSION`**

Change line 1 of `frontend/service-worker.js`:

```js
const CACHE_VERSION = 'revshare-v21';
```

- [ ] **Step 3: Run final tests**

```bash
npm test
```
Expected: `pass 49`.

- [ ] **Step 4: Commit**

```bash
git add frontend/service-worker.js
git commit -m "chore: bump cache to v21 for rule editor deploy"
```

- [ ] **Step 5: Deploy frontend**

```bash
./infra/deploy-frontend.sh
```
Expected: all files uploaded, `InProgress` invalidation, URL printed.

- [ ] **Step 6: Smoke-check**

Open https://d2t76jfby056ul.cloudfront.net (Cmd+Shift+R).

Verify:
- "New partner" form shows a rule editor section below aggregation mode
- Creating a partner with a GP% and placement row saves correctly
- Partner detail → Rule tab shows disabled form + "Edit rule" button
- Clicking "Edit rule" shows Save/Cancel + placement table with device type dropdowns
- Adding/removing placement rows works
- Saving updates the rule; Cancel discards changes
