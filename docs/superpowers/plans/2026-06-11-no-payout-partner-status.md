# No-payout partner status — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add an explicit `noPayout` boolean to partners so intentionally-unpaid partners read as a calm "No payout" status (not the red "No rule" warning), and are skipped in bulk runs regardless of any leftover rule.

**Architecture:** Partner gains a `noPayout` flag (persisted via the existing PUT merge; added to the create route). Frontend partner list shows three states; the rule tab + new-partner form get a "No revenue share — not paid" checkbox. Bulk runs skip `noPayout` partners.

**Tech Stack:** Vanilla JS (`frontend/app.js`, `frontend/style.css`, `frontend/service-worker.js`), Node ESM Lambda (`lambda/revshare-api/code/routes/`). Shared backend → both TH+SG via `deploy-lambda-all.sh`.

Spec: `docs/superpowers/specs/2026-06-11-no-payout-partner-status-design.md`.

---

## Task 1: Backend — persist `noPayout` + skip in bulk runs

**Files:** Modify `lambda/revshare-api/code/routes/partners.mjs`, `lambda/revshare-api/code/routes/bulk-runs.mjs`

- [ ] **Step 1: create route stores `noPayout`** (`partners.mjs`)

In `createPartnerRoute`, change the partner object to include the flag:
```js
  const partner = {
    partnerId: ulid(),
    name, currency, aggregationMode,
    rule: body.rule || { type: 'sum', children: [] },
    noPayout: !!body.noPayout,
    notes: '',
    archived: false
  };
```
(Update path already merges `{ ...existing, ...body }`, so PUT persists `noPayout` unchanged.)

- [ ] **Step 2: bulk run skips `noPayout` partners** (`bulk-runs.mjs`)

In `createBulkRunRoute`, in the `for (const [partnerId, merchantRows] of Object.entries(groups))` loop, add the skip right before the no-rule check:
```js
    const partner = partnerMap[partnerId] || await getPartner(partnerId);
    if (!partner) { warnings.push(`Partner ${partnerId} not found, skipped`); continue; }
    if (partner.noPayout) continue;   // marked "no payout" — not paid by design (skip silently)
    if (!partner.rule || !partner.rule.type) { warnings.push(`Partner "${partner.name}" has no rule, skipped`); continue; }
```

- [ ] **Step 3: Verify** — `cd /Users/ozziewang/revshare-aws && node --check lambda/revshare-api/code/routes/partners.mjs && node --check lambda/revshare-api/code/routes/bulk-runs.mjs && npm test` (engine tests unaffected; all pass).

---

## Task 2: Frontend — partner-list three states

**Files:** Modify `frontend/app.js` (`renderTable` inside `renderPartnersList`)

- [ ] **Step 1: banner counts only genuinely-missing**

Change:
```js
      const missing = partners.filter(noRule).length;
```
to:
```js
      const missing = partners.filter(p => noRule(p) && !p.noPayout).length;
```

- [ ] **Step 2: row + badge logic** — replace the `<tr>`/name `<td>` lines:

```js
            <tr class="row-clickable${noRule(p) && !p.noPayout ? ' row-norule' : ''}" data-id="${escape(p.partnerId)}">
              <td>${escape(p.name)}${p.noPayout ? ' <span class="badge badge-neutral">No payout</span>' : (noRule(p) ? ' <span class="badge badge-danger">No rule</span>' : '')}</td>
```
(`noPayout` takes precedence → neutral badge, no red tint; otherwise the existing red "No rule" for empty-and-unmarked.)

- [ ] **Step 2b: Verify** — `node --check frontend/app.js`.

---

## Task 3: Frontend — "No revenue share" checkbox (rule tab + new-partner form)

**Files:** Modify `frontend/app.js`

- [ ] **Step 1: rule tab markup** — in `renderPartnerDetail`, add a `nopay-row` above the edit bar. Change:
```js
    <div id="tab-rule-content" style="display:none">
      <div id="rule-edit-bar" style="display:flex;justify-content:flex-end;margin-bottom:14px;"></div>
      <div id="rule-editor-container"></div>
    </div>
```
to:
```js
    <div id="tab-rule-content" style="display:none">
      <div id="nopay-row" style="margin-bottom:12px;"></div>
      <div id="rule-edit-bar" style="display:flex;justify-content:flex-end;margin-bottom:14px;"></div>
      <div id="rule-editor-container"></div>
    </div>
```

- [ ] **Step 2: view mode shows status** — in `showRuleView`, after setting `bar.innerHTML`, set the nopay-row:
```js
    const npRow = document.getElementById('nopay-row');
    if (npRow) npRow.innerHTML = p.noPayout
      ? `<span class="badge badge-neutral">No payout</span> <span class="muted" style="font-size:12.5px;">This partner has no revenue share — not paid in runs.</span>`
      : '';
```

- [ ] **Step 3: edit mode checkbox + dim** — in `showRuleEdit`, after `const editor = renderStructuredRuleEditor(...)`, add the checkbox and wire dimming:
```js
    const npRow = document.getElementById('nopay-row');
    if (npRow) {
      npRow.innerHTML = `<label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
        <input type="checkbox" id="nopay-cb" ${p.noPayout ? 'checked' : ''} style="width:auto;margin:0;"> No revenue share — this partner is not paid.</label>`;
      const cb = document.getElementById('nopay-cb');
      const dim = () => { ruleContainer.style.opacity = cb.checked ? '.45' : '1'; ruleContainer.style.pointerEvents = cb.checked ? 'none' : ''; };
      cb.addEventListener('change', dim); dim();
    }
```
Then change the save handler to include `noPayout` and persist it:
```js
    document.getElementById('save-rule-btn').addEventListener('click', async () => {
      let rule;
      try { rule = editor.getRule(); } catch(e) { alert('Invalid JSON: ' + e.message); return; }
      const noPayout = !!document.getElementById('nopay-cb')?.checked;
      const btn = document.getElementById('save-rule-btn');
      btn.disabled = true; btn.textContent = 'Saving…';
      await api('/partners/' + partnerId, { method: 'PUT', body: JSON.stringify({ rule, noPayout }) });
      p.rule = rule; p.noPayout = noPayout;
      showRuleView(machineModels);
    });
```

- [ ] **Step 4: new-partner form checkbox** — in `renderNewPartnerForm`, add a checkbox inside the Revenue-rule block. Change the rule block to include it:
```js
      <div style="border-top:1px solid var(--border);margin-top:18px;padding-top:16px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:14px;">Revenue rule <span style="font-weight:400;text-transform:none;letter-spacing:0;">(optional — can be set later)</span></div>
        <label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:14px;"><input type="checkbox" name="noPayout" style="width:auto;margin:0;"> No revenue share — this partner is not paid.</label>
        <div id="new-rule-container"></div>
      </div>
```
Then in the submit handler include `noPayout` and dim the editor when checked:
```js
    const body = { name: fd.get('name'), currency: fd.get('currency'), aggregationMode: fd.get('aggregationMode'), rule, noPayout: fd.get('noPayout') === 'on' };
```
And after creating the editor, wire dimming:
```js
  const npCb = document.querySelector('#new-partner-form input[name="noPayout"]');
  const npContainer = document.getElementById('new-rule-container');
  if (npCb && npContainer) { const dim = () => { npContainer.style.opacity = npCb.checked ? '.45' : '1'; npContainer.style.pointerEvents = npCb.checked ? 'none' : ''; }; npCb.addEventListener('change', dim); dim(); }
```

- [ ] **Step 5: Verify** — `node --check frontend/app.js`.

---

## Task 4: Service worker + verify + deploy

**Files:** Modify `frontend/service-worker.js`, `CLAUDE.md`

- [ ] **Step 1: bump cache** — in `frontend/service-worker.js`, bump `CACHE_VERSION` (e.g. `revshare-v61` → `revshare-v63`; check the current value first and increment).

- [ ] **Step 2: static gate** — `node --check frontend/app.js && node --check lambda/revshare-api/code/routes/partners.mjs && node --check lambda/revshare-api/code/routes/bulk-runs.mjs && npm test` (all pass).

- [ ] **Step 3: update `CLAUDE.md`** — in the CURRENT STATE / rule-model area, note: partners can be marked `noPayout` (explicit "No payout" — neutral badge, skipped in bulk runs by design); the red "No rule" warning now only flags empty-and-**unmarked** partners.

- [ ] **Step 4: deploy (await user go-ahead)** — Backend both regions: `./infra/deploy-lambda-all.sh` (if it reports SG code changed, commit in the `revshare_sg` repo). Frontend: `./infra/deploy-frontend.sh` (with `REVSHARE_CLOUDFRONT_DIST_ID` if set). Validate, then commit.

---

## Self-Review (completed during planning)
- **Spec coverage:** `noPayout` data + create route (Task 1.1) + PUT pass-through (no change); bulk-run skip regardless of rule (Task 1.2); three list states + banner (Task 2); form checkbox + save in both create & edit (Task 3); SW bump + both-region deploy (Task 4). All covered.
- **Consistency:** badge classes `.badge-neutral`/`.badge-danger` exist; `noRule` precedence (noPayout wins) consistent across row tint, name badge, banner, and bulk run.
- **No engine change:** `engine.mjs` untouched → `npm test` unaffected.
- **Placeholder scan:** none — full code + exact commands.
