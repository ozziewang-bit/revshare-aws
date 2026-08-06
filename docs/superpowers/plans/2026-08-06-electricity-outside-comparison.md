# Electricity Outside The Payout Comparison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Electricity fee from competing inside the `higher` (WH) and `hybrid-higher` (HH) payout comparisons; always add it to whatever the comparison settles on.

**Architecture:** Pure rule-tree change. `compileRule` emits `sum( max(…) , elecLeaf )` instead of putting the electricity leaf inside the `max`. The calculation engine already evaluates `sum` and `max`, so **the engine is not modified at all** — only the two rule compilers (frontend `app.js`, backend `routes/import.mjs`), the frontend decompiler, and the formula label.

**Tech Stack:** Vanilla ES modules on Node 22 (`node:test` + `node:assert` for tests), plain browser JS for the SPA (no build step, no framework).

**Spec:** `docs/superpowers/specs/2026-08-06-electricity-outside-comparison-design.md`

## Global Constraints

- **The engine stays pure.** No change to `lambda/revshare-api/code/engine.mjs`. No AWS SDK / fs / fetch may be introduced there (CLAUDE.md §7.4).
- **`Others` stays inside the comparison.** Electricity is the *only* always-added term. Do not generalise this to other terms.
- **`default` and `hybrid` output must be byte-identical to today.** They already sum every term; regression tests lock this in.
- **Term ordering in sums is GP, Electricity, Placement, Others** — the editor's field order. Preserve it.
- **Bump `frontend/service-worker.js` `CACHE_VERSION`** from `revshare-v71` to `revshare-v72` (CLAUDE.md §10.4). Note: CLAUDE.md currently claims v70; it is stale.
- **Frontend and backend `compileRule` must stay in lockstep.** They are deliberate duplicates (the SPA has no build step and cannot import from `lambda/`). Any change to one is made to the other in the same task sequence.
- **No `Co-Authored-By:` trailers in commit messages** (CLAUDE.md §7.3).
- **Prefix AWS CLI calls with `AWS_DEFAULT_OUTPUT=json`** — the user's `~/.aws/config` sets `output=none`, which breaks scripts that parse output.
- **Do not commit or push until the user says "save progress".** Project convention is patch → deploy → validate → *then* commit (CLAUDE.md §7.1). Each task below ends in a **Checkpoint** (run the tests, confirm green), not a commit. Task 5 handles deploy, and commits happen only on the user's signal.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `lambda/revshare-api/code/routes/import.mjs` | Backend rule compiler (shared reference implementation) | Modify `compileRule` — split electricity out, accept optional `method` |
| `lambda/revshare-api/tests/import.test.mjs` | Backend compiler tests | Rewrite header to import the real function; add 7 tests |
| `lambda/revshare-api/tests/engine.test.mjs` | Engine tests | Add 1 regression test for the new tree shape under `per_store` |
| `frontend/app.js` | SPA: rule compiler, decompiler, formula label | Modify `compileRule`, `decompileRule`, `payoutFormula` |
| `frontend/service-worker.js` | PWA shell cache | Bump `CACHE_VERSION` |
| `CLAUDE.md` | Handoff doc | Update rule-model section, test count, cache version |

---

### Task 1: Backend compiler — electricity leaves the comparison

The backend `compileRule` currently only ever emits `hybrid-higher` (whenever an MG is
present) or `hybrid`/`default`. It has no way to express `higher`, so the WH cases from
the spec cannot be tested against it. This task rebuilds it as a faithful mirror of the
frontend's four-method compiler by adding an **optional** `method` argument that
defaults to today's inference — so the existing caller at `routes/import.mjs:57` is
unchanged and behaves exactly as before.

**Files:**
- Modify: `lambda/revshare-api/code/routes/import.mjs:12-35` (`compileRule`)
- Test: `lambda/revshare-api/tests/import.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `compileRule({ gpPercent, electricity, placementRows, mgRows, others, method })`
  → rule tree object. `method` is `'default' | 'hybrid' | 'higher' | 'hybrid-higher'`
  and is **optional**; when omitted it is inferred as `'hybrid-higher'` if any MG row is
  present, else `'default'` for a single term, else `'hybrid'`. Every leaf carries a
  `_t` tag (`'gp' | 'elec' | 'placement' | 'others' | 'mg'`); the root carries `_method`.
  Task 3 mirrors this exact logic in `frontend/app.js`.

- [ ] **Step 1: Replace the copied functions in the test file with real imports**

The test file currently re-declares its own private copies of `parseDeviceType` and
`compileRule` (lines 4–32), so it cannot detect drift from the shipped code. Delete
lines 1–32 entirely and replace with:

```js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { compileRule, parseDeviceType } from '../code/routes/import.mjs';
```

Leave every existing `test(...)` call below untouched.

- [ ] **Step 2: Run the tests to confirm the import swap is green**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 58`, `fail 0`. The four existing `compileRule` tests now exercise the
real function and must still pass — proving the copy was faithful before we change it.

- [ ] **Step 3: Write the failing tests**

Append to `lambda/revshare-api/tests/import.test.mjs`:

```js
// ── Electricity is a cost reimbursement: always added, never a comparison candidate ──

test('compileRule WH: GP + electricity + MG → sum( max(GP, MG) , Elec )', () => {
  const rule = compileRule({
    gpPercent: 50, electricity: 600, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule._method, 'higher');
  assert.equal(rule.children.length, 2);
  assert.equal(rule.children[0].type, 'max');
  assert.equal(rule.children[0].children[0]._t, 'gp');
  assert.equal(rule.children[0].children[1]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
  assert.equal(rule.children[1].amount, 600);
});

test('compileRule HH: GP + placement + electricity + MG → sum( max( sum(GP,Placement) , MG ) , Elec )', () => {
  const rule = compileRule({
    gpPercent: 20, electricity: 600, placementRows: [{ model: 'S8', amount: 3300 }],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'hybrid-higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule._method, 'hybrid-higher');
  assert.equal(rule.children.length, 2);
  const cmp = rule.children[0];
  assert.equal(cmp.type, 'max');
  assert.equal(cmp.children[0].type, 'sum');
  assert.equal(cmp.children[0].children.length, 2);
  assert.equal(cmp.children[0].children[0]._t, 'gp');
  assert.equal(cmp.children[0].children[1]._t, 'placement');
  assert.equal(cmp.children[1]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
});

test('compileRule WH: electricity only, no MG → bare electricity leaf', () => {
  const rule = compileRule({
    gpPercent: 0, electricity: 600, placementRows: [], mgRows: [], others: 0, method: 'higher',
  });
  assert.equal(rule.type, 'flat_per_partner_total');
  assert.equal(rule._t, 'elec');
  assert.equal(rule.amount, 600);
  assert.equal(rule._method, 'higher');
});

test('compileRule WH: electricity + MG only → sum( MG , Elec )', () => {
  const rule = compileRule({
    gpPercent: 0, electricity: 600, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 2);
  assert.equal(rule.children[0]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
});

test('compileRule HH without electricity is unchanged: max( GP , MG )', () => {
  const rule = compileRule({
    gpPercent: 50, electricity: 0, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'hybrid-higher',
  });
  assert.equal(rule.type, 'max');
  assert.equal(rule.children[0]._t, 'gp');
  assert.equal(rule.children[1]._t, 'mg');
});

test('compileRule hybrid still sums electricity inline, in editor order', () => {
  const rule = compileRule({
    gpPercent: 20, electricity: 600, placementRows: [{ model: 'S8', amount: 3300 }],
    mgRows: [], others: 0, method: 'hybrid',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 3);
  assert.equal(rule.children[0]._t, 'gp');
  assert.equal(rule.children[1]._t, 'elec');
  assert.equal(rule.children[2]._t, 'placement');
});

test('compileRule default: electricity as the only term', () => {
  const rule = compileRule({
    gpPercent: 0, electricity: 600, placementRows: [], mgRows: [], others: 0, method: 'default',
  });
  assert.equal(rule.type, 'flat_per_partner_total');
  assert.equal(rule._t, 'elec');
  assert.equal(rule._method, 'default');
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test 2>&1 | tail -20`
Expected: FAIL. The WH tests fail because `method` is ignored today and an MG always
forces `hybrid-higher`; the HH-with-electricity test fails because the root is `max`,
not `sum`.

- [ ] **Step 5: Rewrite `compileRule` in `routes/import.mjs`**

Replace `lambda/revshare-api/code/routes/import.mjs:12-35` in full:

```js
// Rule shape: comparable terms (GP / Placement / Others) + optional per-device-type MG
// floor, combined per `method`. Electricity is a cost reimbursement — it never competes
// in a max(), it is added to whatever the comparison settles on.
// Leaves tagged (_t/_m) and the root tagged (_method) so the editor can decompile exactly.
// Keep in lockstep with compileRule in frontend/app.js.
export function compileRule({ gpPercent, electricity, placementRows, mgRows, others, method }) {
  const gpLeaf = Number(gpPercent) > 0
    ? { type: 'percent', _t: 'gp', _m: 'add', rows: [{ model: 'ALL', percent: Number(gpPercent) }] } : null;
  const elecLeaf = Number(electricity) > 0
    ? { type: 'flat_per_partner_total', _t: 'elec', _m: 'add', amount: Number(electricity) } : null;
  const vp = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  const placementLeaf = vp.length
    ? { type: 'flat_per_machine', _t: 'placement', _m: 'add', rows: vp.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;
  const othersLeaf = Number(others) > 0
    ? { type: 'flat_per_partner_total', _t: 'others', _m: 'add', amount: Number(others) } : null;
  const vmg = (mgRows || []).filter(r => r.model && Number(r.amount) > 0);
  const mgLeaf = vmg.length
    ? { type: 'flat_per_machine', _t: 'mg', rows: vmg.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;

  const cmpTerms = [gpLeaf, placementLeaf, othersLeaf].filter(Boolean);   // electricity excluded
  const allTerms = [gpLeaf, elecLeaf, placementLeaf, othersLeaf].filter(Boolean);

  // No explicit method (the /import/rev-share caller) → infer as before.
  const m = ['default', 'hybrid', 'higher', 'hybrid-higher'].includes(method)
    ? method
    : (mgLeaf ? 'hybrid-higher' : (allTerms.length <= 1 ? 'default' : 'hybrid'));

  const zero = () => ({ type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }] });
  const nest = (type, list) => list.length === 0 ? null : (list.length === 1 ? list[0] : { type, children: list });
  const addElec = core => elecLeaf ? (core ? { type: 'sum', children: [core, elecLeaf] } : elecLeaf) : (core || zero());

  let rule;
  if (m === 'higher') {
    rule = addElec(nest('max', mgLeaf ? [...cmpTerms, mgLeaf] : cmpTerms));
  } else if (m === 'hybrid-higher') {
    const s = nest('sum', cmpTerms);
    rule = addElec(mgLeaf ? (s ? { type: 'max', children: [s, mgLeaf] } : mgLeaf) : s);
  } else {
    rule = nest('sum', allTerms) || zero();   // default | hybrid — MG not used
  }
  return { ...rule, _method: m };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 65`, `fail 0`. All four pre-existing `compileRule` tests still pass —
they call without `method`, exercising the inference path.

- [ ] **Step 7: Checkpoint**

Run: `npm test 2>&1 | grep -E "^. (pass|fail)"`
Confirm `pass 65` / `fail 0` before moving on. Do not commit yet (see Global Constraints).

---

### Task 2: Engine regression test for the new tree shape

No engine code changes. This test pins down the behaviour the new shape depends on: a
`flat_per_partner_total` sitting as a direct child of a root `sum`, *alongside a `max`*,
is legal in `per_store` mode and is charged once for the partner rather than once per
store. `engine.test.mjs:158` already proves the old shape throws; `:248` covers a root
`sum` without a `max` sibling. Neither covers what `compileRule` now emits.

**Files:**
- Test: `lambda/revshare-api/tests/engine.test.mjs`

**Interfaces:**
- Consumes: the tree shape produced by Task 1's `compileRule` under `method: 'higher'`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Append to `lambda/revshare-api/tests/engine.test.mjs`:

```js
test('sum( max(...) , flat_per_partner_total ) is legal in per_store and charges the lump once', () => {
  const result = evaluateRun({
    rule: { type: 'sum', children: [
      { type: 'max', children: [
        { type: 'percent', rows: [{ model: 'ALL', percent: 10 }] },
        { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: 300 }] },
      ]},
      { type: 'flat_per_partner_total', amount: 500 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 1, revenue: 1000 },
      { storeId: 'B', machineSerial: 'M2', model: 'S5', rentals: 1, revenue: 8000 },
    ],
    aggregationMode: 'per_store'
  });
  // Store A: max(10% of 1000 = 100, MG 300) = 300
  // Store B: max(10% of 8000 = 800, MG 300) = 800
  // Electricity lump: 500, once for the partner — not once per store
  assert.equal(result.totalPayout, 1600);
  assert.equal(result.byStore.length, 2);
  assert.equal(result.topLevel.payout, 500);
});
```

- [ ] **Step 2: Run the test**

Run: `npm test 2>&1 | tail -8`
Expected: `pass 66`, `fail 0`. This one passes immediately — the engine already supports
the shape. If it *fails*, stop: the spec's §5 claim is wrong and the whole approach needs
revisiting before continuing.

- [ ] **Step 3: Checkpoint**

Run: `npm test 2>&1 | grep -E "^. (pass|fail)"`
Confirm `pass 66` / `fail 0`.

---

### Task 3: Frontend compiler, decompiler, and formula label

Mirrors Task 1 into the SPA and updates the two things that read the compiled shape.
`frontend/app.js` is a plain browser script with no test harness, so this task ends in a
manual smoke test rather than an automated one.

**Files:**
- Modify: `frontend/app.js:29-55` (`compileRule`)
- Modify: `frontend/app.js:89-96` (method inference inside `decompileRule`)
- Modify: `frontend/app.js:131-144` (`payoutFormula`)
- Modify: `frontend/service-worker.js:1` (`CACHE_VERSION`)

**Interfaces:**
- Consumes: the compiler logic settled in Task 1. The frontend version takes the form
  object `{ gpPercent, electricity, placementRows, others, mgRows, method }` and always
  has an explicit `method`, so it needs no inference fallback.
- Produces: rule trees consumed by `PUT /partners/:id`; form objects consumed by the
  rule editor.

- [ ] **Step 1: Replace `compileRule`**

Replace `frontend/app.js:29-55` in full:

```js
function compileRule(form) {
  const { gpPercent, electricity, placementRows, others, mgRows } = form;
  const method = PAYOUT_METHODS.includes(form.method) ? form.method : 'hybrid';

  const gpLeaf = Number(gpPercent) > 0
    ? { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: Number(gpPercent) }] } : null;
  const elecLeaf = Number(electricity) > 0
    ? { type: 'flat_per_partner_total', _t: 'elec', amount: Number(electricity) } : null;
  const vp = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  const placementLeaf = vp.length
    ? { type: 'flat_per_machine', _t: 'placement', rows: vp.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;
  const othersLeaf = Number(others) > 0
    ? { type: 'flat_per_partner_total', _t: 'others', amount: Number(others) } : null;
  const vmg = (mgRows || []).filter(r => r.model && Number(r.amount) > 0);
  const mgLeaf = vmg.length
    ? { type: 'flat_per_machine', _t: 'mg', rows: vmg.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;

  // Electricity is a cost reimbursement — it never competes in a max(), it is added to
  // whatever the comparison settles on. Keep in lockstep with routes/import.mjs.
  const cmpTerms = [gpLeaf, placementLeaf, othersLeaf].filter(Boolean);
  const allTerms = [gpLeaf, elecLeaf, placementLeaf, othersLeaf].filter(Boolean);

  const zero = () => ({ type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }] });
  const nest = (type, list) => list.length === 0 ? null : (list.length === 1 ? list[0] : { type, children: list });
  const addElec = core => elecLeaf ? (core ? { type: 'sum', children: [core, elecLeaf] } : elecLeaf) : (core || zero());

  let rule;
  if (method === 'higher') {
    rule = addElec(nest('max', mgLeaf ? [...cmpTerms, mgLeaf] : cmpTerms));
  } else if (method === 'hybrid-higher') {
    const s = nest('sum', cmpTerms);
    rule = addElec(mgLeaf ? (s ? { type: 'max', children: [s, mgLeaf] } : mgLeaf) : s);
  } else {
    rule = nest('sum', allTerms) || zero();   // default | hybrid (MG not used)
  }
  return { ...rule, _method: method };
}
```

- [ ] **Step 2: Teach the legacy method-inference about the wrapped comparison**

`decompileRule`'s leaf walk is already tag-driven and round-trips the new shape without
change. Only the untagged-legacy fallback needs to know a `max` can now sit inside a
root `sum`. Replace `frontend/app.js:89-96`:

```js
  // The comparison node is the root max, or a max wrapped in a root sum alongside the
  // always-added electricity lump.
  const cmpNode = rule.type === 'max' ? rule
    : (rule.type === 'sum' ? (rule.children || []).find(c => c.type === 'max') : null);
  if (PAYOUT_METHODS.includes(rule._method)) {
    f.method = rule._method;
  } else if (cmpNode) {
    f.method = (cmpNode.children || []).some(c => c.type === 'sum') ? 'hybrid-higher' : 'higher';
  } else {
    const termCount = [f.gpPercent > 0, f.electricity > 0, f.placementRows.length > 0, f.others > 0].filter(Boolean).length;
    f.method = termCount <= 1 ? 'default' : 'hybrid';
  }
```

- [ ] **Step 3: Update `payoutFormula`**

Replace `frontend/app.js:131-144`:

```js
function payoutFormula(form) {
  const labels = presentTermLabels(form);
  const hasElec = Number(form.electricity) > 0;
  const cmp = labels.filter(l => l !== 'Electricity');   // electricity never competes
  const hasMg = (form.mgRows || []).some(r => r.model && Number(r.amount) > 0);
  const method = form.method || 'hybrid';
  const withElec = base => hasElec ? (base ? `${base} + Electricity` : 'Electricity') : (base || '0');

  if (method === 'higher') {
    const c = hasMg ? [...cmp, 'MG'] : [...cmp];
    return withElec(c.length === 0 ? '' : (c.length === 1 ? c[0] : `max( ${c.join(' , ')} )`));
  }
  if (method === 'hybrid-higher') {
    const s = cmp.join(' + ');
    return withElec(hasMg ? (s ? `max( ${s} , MG )` : 'MG') : s);
  }
  return labels.join(' + ') || '0';   // default | hybrid
}
```

- [ ] **Step 4: Update the payout-method descriptions**

`PAYOUT_METHOD_META` at `frontend/app.js:100-105` still describes the old behaviour.
Replace the two affected `desc` strings:

```js
  { val: 'higher',        code: 'WH', title: 'Whichever is higher', desc: 'Highest of each term, incl. MG — electricity added on top' },
  { val: 'hybrid-higher', code: 'HH', title: 'Hybrid-higher',       desc: 'max( summed terms , MG ) — electricity added on top' },
```

- [ ] **Step 5: Bump the service-worker cache version**

`frontend/service-worker.js:1` — change `revshare-v71` to `revshare-v72`:

```js
const CACHE_VERSION = 'revshare-v72';
```

- [ ] **Step 6: Syntax-check the frontend**

Run: `node --check frontend/app.js && node --check frontend/service-worker.js`
Expected: no output (both parse cleanly).

- [ ] **Step 7: Checkpoint**

Run: `npm test 2>&1 | grep -E "^. (pass|fail)"`
Confirm `pass 66` / `fail 0` — the backend is untouched by this task and must stay green.

---

### Task 4: Deploy and validate in the live app

Project convention is patch → deploy → validate → commit. Nothing is committed until the
user confirms the deployed app behaves correctly.

**Files:** none modified.

**Interfaces:**
- Consumes: the working tree from Tasks 1–3.
- Produces: user confirmation, which gates Task 5.

- [ ] **Step 1: Deploy the backend to both regions**

Run: `./infra/deploy-lambda-all.sh`
Expected: both `revshare-api` and `revshare-api-sg` report a successful update. If it
reports that SG code changed, note it — that change must be committed in the separate
`revshare_sg` repo (see CLAUDE.md §8).

- [ ] **Step 2: Deploy the frontend**

Run: `./infra/deploy-frontend.sh`
Expected: files uploaded; CloudFront invalidated if `REVSHARE_CLOUDFRONT_DIST_ID` is set.

- [ ] **Step 3: Confirm the API is alive**

Run: `curl -sS https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod/healthz`
Expected: `{"ok":true}`

- [ ] **Step 4: Smoke-test the rule editor round-trip**

Ask the user to do this in the live app at https://d2t76jfby056ul.cloudfront.net
(hard-reload once so the `v72` service worker takes over):

1. Open any partner → **Rule** tab. Pick **Whichever is higher (WH)**.
2. Enter a GP %, an Electricity amount, and an MG row for one device type.
3. Confirm the formula line now reads `max( GP% , MG ) + Electricity`.
4. Save, navigate away, and reopen the partner's Rule tab.
5. Confirm the method is still WH and **every amount survived the round-trip** —
   this is what proves `decompileRule` reads the new shape correctly.
6. Repeat with **Hybrid-higher (HH)**: formula should read `max( GP% , MG ) + Electricity`
   with a single term, or `max( GP% + Placement , MG ) + Electricity` with two.
7. Open a `default` or `hybrid` partner that has electricity (e.g. **BITEC**, **Central**,
   **EmQuartier**) and confirm nothing about it changed.

- [ ] **Step 5: Wait for the user to confirm**

Do not proceed to Task 5 until the user says the deployed app works. The user is the
source of truth for "this works" (CLAUDE.md §7.1).

---

### Task 5: Update the handoff doc, then commit on the user's signal

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: user confirmation from Task 4.
- Produces: nothing.

- [ ] **Step 1: Update the rule-model section of CLAUDE.md**

In §1b, replace the payout-method list with:

```markdown
`compileRule`/`decompileRule` (frontend `app.js` + backend `routes/import.mjs`)
tag leaves with `_t` (term) and the root with `_method` so decompile is exact;
legacy untagged rules fall back to heuristics. Four payout methods (`form.method`):
- `default` (code **D**) — single term, just pay it.
- `hybrid` (code **H**) — sum of all terms.
- `higher` (code **WH**) — `max(each comparable term…, MG) + Electricity`.
- `hybrid-higher` (code **HH**) — `max(sum of comparable terms, MG) + Electricity`.

**Electricity never competes (2026-08-06):** the electricity fee is a reimbursement of a
cost the partner actually incurs, so it is excluded from the WH/HH comparison and added
to whatever the comparison settles on. Compiled as `sum( max(…) , elecLeaf )`. `Others`
*does* still compete. `default`/`hybrid` are unchanged (they already sum every term).
Side effect: the electricity leaf is now a legal root-`sum` child, so a `per_store`
partner with electricity no longer throws in `validatePerStoreTree` and is charged the
lump once per partner rather than once per store. No stored rule was affected — verified
that none of the 6 max-root partners carried an electricity term.
```

- [ ] **Step 2: Correct the two stale facts at the top of CLAUDE.md**

- The header line says `revshare-v70`. It was already `v71` before this change and is now
  `v72` — update it.
- §1b's closing line says `npm test` → **58/58**. Update to **66/66**.

- [ ] **Step 3: Verify the doc claims are true**

Run: `grep -n "CACHE_VERSION" frontend/service-worker.js && npm test 2>&1 | grep -E "^. (pass|fail)"`
Expected: `revshare-v72`, `pass 66`, `fail 0`. Both must match what CLAUDE.md now claims.

- [ ] **Step 4: Commit — only when the user says "save progress"**

Per the user's standing preference, do not run this until they say so.

```bash
git add lambda/revshare-api/code/routes/import.mjs \
        lambda/revshare-api/tests/import.test.mjs \
        lambda/revshare-api/tests/engine.test.mjs \
        frontend/app.js frontend/service-worker.js \
        CLAUDE.md \
        docs/superpowers/specs/2026-08-06-electricity-outside-comparison-design.md \
        docs/superpowers/plans/2026-08-06-electricity-outside-comparison.md
git commit -m "fix(rules): electricity is added on top, never a max() candidate

WH and HH compared the electricity fee against GP/Placement/Others/MG, so a
small lump either always lost (WH) or was swallowed when the MG floor won (HH).
Electricity reimburses a cost the partner incurs, so it now compiles as
sum( max(...), elecLeaf ) and is added to whatever the comparison settles on.
Others still competes.

Also makes the electricity leaf a legal root-sum child, so a per_store partner
with electricity no longer throws in validatePerStoreTree and is charged once
per partner instead of once per store.

No stored rule affected: none of the 6 max-root partners carry electricity.
Backend compileRule gains an optional method arg (defaults to today's
inference) so all four methods are testable; import.test.mjs now imports the
real function instead of a private copy. 58 -> 66 tests. sw v72."
git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 target semantics (WH/HH formulas, `Others` stays in) | Task 1 Step 5, Task 3 Step 1 |
| §2 edge cases (elec+MG, elec only, no terms) | Task 1 Step 3 tests 3 and 4 |
| §3 approach A (tree-encoded, engine untouched) | Task 1, Task 3 — no engine file in any task |
| §4 tree shapes incl. degenerate collapses | Task 1 Step 5 (`nest`/`addElec` helpers) |
| §5 `per_store` crash fix | Task 2 |
| §6 no migration | Verified pre-plan; restated in Task 5 Step 1 |
| §7 code changes (4 files + SW bump) | Tasks 1, 3 |
| §8 testing (import real fn, 6 cases, round-trip, engine guard) | Task 1 Steps 1–6, Task 2, Task 3 Step 7 |
| §9 out of scope | Global Constraints (`Others` stays in; no recompute) |

**Deviations from the spec, both deliberate:**
1. Spec §7 says `decompileRule` needs a defensive fallback; the plan implements exactly
   that (Task 3 Step 2) and notes the tag-driven path already round-trips.
2. Spec §8 lists WH test cases, which the backend compiler could not produce. Task 1 adds
   an optional `method` parameter so it can. Callers are unchanged.
3. Spec §7 says bump to `v71`; it was already `v71`, so the plan bumps to `v72`.

**Placeholder scan:** no TBD/TODO; every code step carries the full replacement body;
no step says "similar to Task N".

**Type consistency:** `compileRule` takes `{ gpPercent, electricity, placementRows, mgRows, others, method }`
in both Task 1 and Task 3 (the frontend reads `method` off the form object rather than a
destructured arg — that is the existing signature and is intentional). Helper names
`zero` / `nest` / `addElec` and leaf tags `gp|elec|placement|others|mg` are identical
across both. `cmpTerms` excludes electricity in both; `allTerms` includes it in both.
