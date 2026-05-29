# Rule Editor Improvements — Design Spec

Date: 2026-05-29

## 1. Goal

Three improvements to rule management:
1. **Per-machine placement fees** — the placement fee field becomes a per-device-type table (compiles to `flat_per_machine`) instead of a single lump sum.
2. **Rule in new partner form** — the rule editor is embedded in the "New partner" creation form so finance staff can set the rule at creation time.
3. **Read-only rule tab** — the Rule tab defaults to a disabled view with an "Edit rule" button; the form only becomes active after clicking Edit.

---

## 2. Placement fee: per-device-type table

### 2.1 Data model change

**Before:** `compileRule` input had a scalar `placement` (number) → emitted `flat_per_partner_total`.

**After:** `compileRule` input has `placementRows` (array of `{ model: string, amount: number }`) → emits `flat_per_machine` if any rows exist, otherwise nothing.

### 2.2 `compileRule` change

```js
function compileRule({ gpPercent, mgEnabled, mgAmount, electricity, placementRows, others }) {
  // ... GP leaf + optional max with MG (unchanged) ...
  if (Number(electricity) > 0)
    children.push({ type: 'flat_per_partner_total', amount: Number(electricity) });
  if (placementRows?.length)
    children.push({ type: 'flat_per_machine', rows: placementRows.filter(r => r.model && Number(r.amount) > 0) });
  if (Number(others) > 0)
    children.push({ type: 'flat_per_partner_total', amount: Number(others) });
  // ...
}
```

Only non-empty rows (model set + amount > 0) are included.

### 2.3 `decompileRule` change

Returns `placementRows` instead of `placement`.

Detection logic (in order):
1. If there is a **top-level `flat_per_machine`** node (not nested inside a `max`): `placementRows = node.rows`.
2. Else if there are **two or more `flat_per_partner_total`** nodes (old format): `placementRows = []`, electricity = first, others = second. The old placement (index 1 in the old format) is silently dropped — users must re-enter per-model placement rows.
3. Else (only one `flat_per_partner_total`): `placementRows = []`, electricity = that value, others = 0.

Return shape:
```js
{ gpPercent, mgEnabled, mgAmount, electricity, placementRows, others }
```

### 2.4 Editor UI change

The `renderStructuredRuleEditor` function:

- Remove the single `Monthly placement (THB)` `<input>` row.
- Replace with a mini-table labelled **"Monthly placement — per machine type"**:
  - Columns: **Device type** (dropdown populated from `machineModels` fetched via `api('/machine-models')`), **Amount (THB/month)**, **✕**
  - `+ Add device type` dashed button below the table
  - Starts empty (or pre-filled from `placementRows` when decompiling)
  - Disabled state: dropdowns and inputs are `disabled`, ✕ and + buttons hidden

The function signature gains two params:
```js
function renderStructuredRuleEditor(container, initialRule, machineModels, { readOnly = false } = {})
```

`machineModels` is the array from `api('/machine-models')`. It is passed in by callers (both partner detail and new partner form already have it or fetch it).

### 2.5 `getRule()` change

`editor.getRule()` reads the placement table rows and passes them as `placementRows` to `compileRule`.

---

## 3. Rule in new partner form

### 3.1 Backend

`createPartnerRoute` (`routes/partners.mjs`) currently ignores `rule` from the request body. Update to accept it:

```js
const partner = {
  partnerId: ulid(),
  name, currency, aggregationMode,
  rule: body.rule || { type: 'sum', children: [] },
  notes: '',
  archived: false
};
```

### 3.2 Frontend

`renderNewPartnerForm` already fetches nothing from the API. It now needs `machineModels` to pass to the rule editor. Add a fetch at the top:

```js
const machineModels = await api('/machine-models');
```

Embed the rule editor **below** the aggregation mode field, above the submit button, with a section heading:

```
─── Revenue rule (optional — can be set later) ──────────
[rule editor here]
```

On submit, include the rule in the POST body:
```js
const rule = editor.getRule();
const body = { name, currency, aggregationMode, rule };
```

---

## 4. Read-only rule tab

### 4.1 Behaviour

The Rule tab in `renderPartnerDetail` has two states:

**View mode (default):**
- Rule editor rendered with `readOnly: true` (all inputs disabled, ✕/+ buttons hidden)
- Header bar shows: `👁 View only` badge + **"Edit rule"** button

**Edit mode (after clicking "Edit rule"):**
- Rule editor re-rendered with `readOnly: false`
- Header bar shows: **"Cancel"** + **"Save rule"** buttons
- Cancel: re-render in view mode using original rule (discards changes)
- Save rule: PUT /partners/:id, then re-render in view mode with new rule

### 4.2 Implementation

`renderStructuredRuleEditor` is called twice — once for view, once for edit — with the same `container` element. The tab click handler for the Rule tab triggers the initial view-mode render.

The `machineModels` needed for the placement table are already fetched by `renderMerchantsTab`. For the Rule tab, fetch them when the Rule tab is first activated (lazy, one fetch per tab activation).

---

## 5. Files changed

| File | What changes |
|---|---|
| `lambda/revshare-api/code/routes/partners.mjs` | `createPartnerRoute` reads `body.rule` |
| `frontend/app.js` | `compileRule`, `decompileRule`, `renderStructuredRuleEditor` (new params + placement table), `renderPartnerDetail` Rule tab (view/edit toggle), `renderNewPartnerForm` (fetch machineModels, embed editor, include rule in POST) |

---

## 6. Out of scope

- No changes to electricity, others, or the GP/MG fields — only placement changes.
- No changes to the advanced raw-JSON fallback in the rule editor.
- No changes to the run flow or calculation engine.
- Existing partners with old `flat_per_partner_total` placement: their placement is not migrated automatically. The editor shows empty placement rows; users re-enter per-model values on next edit.

## 7. Success criteria

- Creating a new partner with a rule saves it immediately (no separate save step).
- Rule tab shows disabled form by default with "Edit rule" button.
- Clicking "Edit rule" enables the form; Cancel reverts; Save updates the partner.
- Placement section shows a per-device-type table populated from Device Types.
- Adding a placement row with device type S5 and amount 500 saves as `flat_per_machine` with `rows: [{model:'S5', amount:500}]`.
- Removing all placement rows saves a rule with no `flat_per_machine` placement leaf.
- Old rules with `flat_per_partner_total` placement open with empty placement rows (no crash).
- All 49 tests still pass.
