# RevShare SEA — TH/SG Region Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-region revshare-aws app into "RevShare SEA" — one site with a Thailand/Singapore switcher, Singapore identical to Thailand but on the SG backend with SGD.

**Architecture:** "One site, two backends" (mirrors `rental-analysis-th`). A `REGIONS` config in `app.js` holds both API URLs + currency; the active region persists in `localStorage` and a topbar `<select>` reloads on change. Singapore's existing backend (`revshare-api-sg` / `RevsharePartnerSG`) is first brought to code parity with TH.

**Tech Stack:** Vanilla JS SPA (no frontend test framework — verification is `node --check` + deploy + manual/curl smoke, per CLAUDE.md §11). Node 22 ESM Lambda (engine has `node:test`, 50 tests). AWS S3 + CloudFront + API Gateway + DynamoDB, region `ap-southeast-7`.

**Spec:** `docs/superpowers/specs/2026-06-08-revshare-sea-region-switcher-design.md`

**Note on verification style:** The frontend has no automated test harness, so UI tasks use `node --check frontend/app.js` (syntax gate) and explicit manual smoke steps instead of failing-test-first. The backend parity task uses the real `npm test` suite + live curl.

---

### Task 1: Backend parity — bring the SG Lambda to current TH code

The SG Lambda (cloned 2026-06-04) is missing `/import/rule-batch`. TH vs SG differ in exactly three files: `index.mjs` and `routes/import.mjs` (only the rule-batch additions — no region config), and `db.mjs` (**region config only — must NOT be overwritten**). All other files are identical.

**Files:**
- Copy: `lambda/revshare-api/code/index.mjs` → `/Users/ozziewang/revshare_sg/lambda/revshare-api/code/index.mjs`
- Copy: `lambda/revshare-api/code/routes/import.mjs` → `/Users/ozziewang/revshare_sg/lambda/revshare-api/code/routes/import.mjs`
- DO NOT touch: `/Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs` (keeps `RevsharePartnerSG` / `revshare-runs-sg-...` defaults)
- Deploy: `/Users/ozziewang/revshare_sg/infra/deploy-lambda.sh`

- [ ] **Step 1: Confirm the only meaningful gap is the rule-batch route**

Run:
```bash
diff /Users/ozziewang/revshare-aws/lambda/revshare-api/code/index.mjs /Users/ozziewang/revshare_sg/lambda/revshare-api/code/index.mjs
diff /Users/ozziewang/revshare-aws/lambda/revshare-api/code/db.mjs /Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs
```
Expected: `index.mjs` diff shows only the `applyRuleBatchRoute` import + the `/import/rule-batch` route line; `db.mjs` diff shows only the TABLE/RUNS_BUCKET defaults (SG = `RevsharePartnerSG` / `revshare-runs-sg-812751451548-sea7`).

- [ ] **Step 2: Copy the two parity files (index.mjs + import.mjs) into the SG repo**

Run:
```bash
cp /Users/ozziewang/revshare-aws/lambda/revshare-api/code/index.mjs        /Users/ozziewang/revshare_sg/lambda/revshare-api/code/index.mjs
cp /Users/ozziewang/revshare-aws/lambda/revshare-api/code/routes/import.mjs /Users/ozziewang/revshare_sg/lambda/revshare-api/code/routes/import.mjs
```

- [ ] **Step 3: Verify SG db.mjs was NOT changed (region config intact)**

Run:
```bash
grep -n "RevsharePartnerSG\|revshare-runs-sg" /Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs
```
Expected: both SG-specific defaults still present (2 matches).

- [ ] **Step 4: Sanity-check the shared engine still passes (TH repo test suite)**

Run:
```bash
cd /Users/ozziewang/revshare-aws && npm test 2>&1 | tail -5
```
Expected: `pass 50 / fail 0` (engine + csv unchanged by this task).

- [ ] **Step 5: Deploy the SG Lambda**

Run:
```bash
/Users/ozziewang/revshare_sg/infra/deploy-lambda.sh
```
Expected: `deployed revshare-api-sg`.

- [ ] **Step 6: Verify the SG endpoint is now live**

Run (wait ~3s after deploy):
```bash
curl -sS https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod/healthz; echo
curl -sS -X POST https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod/import/rule-batch -H 'content-type: application/json' -d '{}'; echo
```
Expected: `{"ok":true}` then `{"error":"no_updates"}` (was `not_found` before).

- [ ] **Step 7: Commit in the SG repo**

Run:
```bash
cd /Users/ozziewang/revshare_sg && git add lambda/revshare-api/code/index.mjs lambda/revshare-api/code/routes/import.mjs && \
git -c user.email=ozzie.wang@inforich.com -c user.name=ozziewang commit -m "feat: parity with TH — add /import/rule-batch (server-side batch rule update)"
```

---

### Task 2: Region config in app.js (REGIONS map, API_URL, CCY/SYM)

**Files:**
- Modify: `frontend/app.js:1-2`

- [ ] **Step 1: Replace the single injected API URL with a REGIONS config**

Replace:
```js
// === API ===
const API_URL = window.REVSHARE_API_URL || '';   // injected by deploy script
```
with:
```js
// === API / region ===
// One site, two backends. Both API URLs are public (no auth). Switching region
// persists to localStorage and reloads (see switchRegion) so no TH/SG state bleeds.
const REGIONS = {
  th: { name: 'Thailand',  api: 'https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'THB', sym: '฿'  },
  sg: { name: 'Singapore', api: 'https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'SGD', sym: 'S$' },
};
let REGION = (localStorage.getItem('rs_region') in REGIONS) ? localStorage.getItem('rs_region') : 'th';
const R = () => REGIONS[REGION];
const API_URL = R().api;
const CCY = R().ccy, SYM = R().sym;
```

- [ ] **Step 2: Verify syntax**

Run: `node --check frontend/app.js`
Expected: no output (exit 0).

- [ ] **Step 3: Commit**

Run:
```bash
cd /Users/ozziewang/revshare-aws && git add frontend/app.js && git commit -m "feat: REGIONS config + region-aware API_URL/CCY/SYM (TH/SG)"
```

---

### Task 3: Topbar region switcher + "RevShare SEA" branding + wiring

**Files:**
- Modify: `frontend/index.html:6` (title), `frontend/index.html:19` (topbar brand)
- Modify: `frontend/app.js` — add `switchRegion()` (after `initApp`), wire the select inside `initApp` (`frontend/app.js:256-259`)

- [ ] **Step 1: Update the page title**

In `frontend/index.html`, replace:
```html
  <title>RevShare CHARGESPOT Thailand</title>
```
with:
```html
  <title>RevShare SEA</title>
```

- [ ] **Step 2: Replace the static region label with a switcher**

In `frontend/index.html`, replace:
```html
      <div class="brand"><img src="/logo.png" alt="ChargeSpot" class="brand-logo"><span class="brand-text">RevShare <span class="brand-region">Thailand</span></span></div>
```
with:
```html
      <div class="brand"><img src="/logo.png" alt="ChargeSpot" class="brand-logo"><span class="brand-text">RevShare <span class="brand-region">SEA</span></span>
        <select id="region-switch" title="Region" style="margin-left:12px;padding:4px 8px;border:1px solid var(--border,#d4d4d8);border-radius:7px;font-size:13px;font-weight:600;background:#fff;cursor:pointer;">
          <option value="th">Thailand</option>
          <option value="sg">Singapore</option>
        </select>
      </div>
```

- [ ] **Step 3: Add the switchRegion function**

In `frontend/app.js`, immediately AFTER the `initApp` function (currently ends at line 259 `}`), add:
```js
function switchRegion(rk) {
  if (!(rk in REGIONS) || rk === REGION) return;
  try { localStorage.setItem('rs_region', rk); } catch {}
  location.reload();   // full reset — partner/run/merchant state is per-backend
}
```

- [ ] **Step 4: Wire the select in initApp**

In `frontend/app.js`, replace:
```js
function initApp() {
  renderNav();
  renderPartnersList();
}
```
with:
```js
function initApp() {
  const rs = document.getElementById('region-switch');
  if (rs) { rs.value = REGION; rs.onchange = e => switchRegion(e.target.value); }
  renderNav();
  renderPartnersList();
}
```

- [ ] **Step 5: Verify syntax**

Run: `node --check frontend/app.js`
Expected: no output (exit 0).

- [ ] **Step 6: Commit**

Run:
```bash
cd /Users/ozziewang/revshare-aws && git add frontend/index.html frontend/app.js && git commit -m "feat: RevShare SEA branding + topbar TH/SG region switcher"
```

---

### Task 4: Manifest + service-worker cache bump

**Files:**
- Modify: `frontend/manifest.json:2-3`
- Modify: `frontend/service-worker.js:1`

- [ ] **Step 1: Rename the manifest**

In `frontend/manifest.json`, replace:
```json
  "name": "RevShare CHARGESPOT Thailand",
  "short_name": "RevShare TH",
```
with:
```json
  "name": "RevShare SEA",
  "short_name": "RevShare SEA",
```

- [ ] **Step 2: Bump the cache version**

In `frontend/service-worker.js`, replace:
```js
const CACHE_VERSION = 'revshare-v60';
```
with:
```js
const CACHE_VERSION = 'revshare-v61';
```

- [ ] **Step 3: Commit**

Run:
```bash
cd /Users/ozziewang/revshare-aws && git add frontend/manifest.json frontend/service-worker.js && git commit -m "chore: manifest → RevShare SEA; sw v61"
```

---

### Task 5: Full currency localization (app.js)

Replaces every hardcoded `THB`/`฿` with the region constants `CCY`/`SYM`, adds `SGD` to the currency list, and defaults new partners to the region currency. Per-partner display (`partner.currency`) is left untouched.

**Files:**
- Modify: `frontend/app.js:4` (CURRENCIES), `:134` (CSV header), `:852` (chart axis), `:1013` (new-partner default), `:1098`,`:1100`,`:1106`,`:1126` (rule-editor labels), `:1893` (PDF footer)

- [ ] **Step 1: Add SGD to the currency list**

Replace:
```js
const CURRENCIES = ['TWD', 'USD', 'HKD', 'JPY', 'IDR', 'THB'];
```
with:
```js
const CURRENCIES = ['TWD', 'USD', 'HKD', 'JPY', 'IDR', 'THB', 'SGD'];
```

- [ ] **Step 2: Localize the batch-CSV header**

Replace:
```js
const SHARE_TERMS_CSV_HEADER = 'Partner Name,Merchant Name,Device Type,GP (%),Electricity (THB/month),Placement (THB/month),Others (THB/month),Min Guarantee (THB/machine/month),Payout Method';
```
with:
```js
const SHARE_TERMS_CSV_HEADER = `Partner Name,Merchant Name,Device Type,GP (%),Electricity (${CCY}/month),Placement (${CCY}/month),Others (${CCY}/month),Min Guarantee (${CCY}/machine/month),Payout Method`;
```

- [ ] **Step 3: Localize the chart axis label**

Replace:
```js
    <text x="${padL - 8}" y="${padT - 12}" text-anchor="end" font-size="10" fill="${TXT}">THB</text>
```
with:
```js
    <text x="${padL - 8}" y="${padT - 12}" text-anchor="end" font-size="10" fill="${TXT}">${CCY}</text>
```

- [ ] **Step 4: Default the new-partner currency to the region currency**

Replace:
```js
        <select name="currency">${CURRENCIES.map(c => `<option>${c}</option>`).join('')}</select>
```
with:
```js
        <select name="currency">${CURRENCIES.map(c => `<option ${c === CCY ? 'selected' : ''}>${c}</option>`).join('')}</select>
```

- [ ] **Step 5: Localize the four rule-editor field labels**

Replace `Electricity fee (THB/month)`:
```js
        <div class="rf-row"><label>Electricity fee (THB/month)</label>
```
with:
```js
        <div class="rf-row"><label>Electricity fee (${CCY}/month)</label>
```

Replace `Others (THB/month)`:
```js
        <div class="rf-row"><label>Others (THB/month)</label>
```
with:
```js
        <div class="rf-row"><label>Others (${CCY}/month)</label>
```

Replace the Placement amount header `Amount (THB/month)`:
```js
            <th style="width:35%">Amount (THB/month)</th>
```
with:
```js
            <th style="width:35%">Amount (${CCY}/month)</th>
```

Replace the MG amount header `Amount (THB/machine/month)`:
```js
            <th style="width:35%">Amount (THB/machine/month)</th>
```
with:
```js
            <th style="width:35%">Amount (${CCY}/machine/month)</th>
```

- [ ] **Step 6: Localize the PDF statement footer**

Replace:
```js
    <div style="margin-top:36px;font-size:9px;color:#94a3b8;text-align:center;">RevShare CHARGESPOT Thailand · Generated automatically · Not a tax document</div>`;
```
with:
```js
    <div style="margin-top:36px;font-size:9px;color:#94a3b8;text-align:center;">RevShare SEA · ${R().name} · Generated automatically · Not a tax document</div>`;
```

- [ ] **Step 7: Verify no hardcoded THB/฿ remain and syntax is valid**

Run:
```bash
cd /Users/ozziewang/revshare-aws && grep -n "THB\|฿" frontend/app.js; node --check frontend/app.js && echo "syntax OK"
```
Expected: only the `CURRENCIES` list entry `'THB'` remains (a valid selectable currency); no other `THB`/`฿`. `syntax OK`.

- [ ] **Step 8: Commit**

Run:
```bash
cd /Users/ozziewang/revshare-aws && git add frontend/app.js && git commit -m "feat: region-driven currency (CCY/SYM) across chart, rule editor, CSV header, PDF, new-partner default"
```

---

### Task 6: Drop the deploy-time API injection

With `REGIONS` in `app.js`, the `sed` injection is obsolete and would corrupt the new line.

**Files:**
- Modify: `infra/deploy-frontend.sh:8-11`

- [ ] **Step 1: Replace the sed-injected upload with a direct copy**

Replace:
```bash
# Inject API URL into app.js
TMP="$(mktemp)"
sed "s|window.REVSHARE_API_URL \|\| ''|'$API_URL'|" "$ROOT/frontend/app.js" > "$TMP"
```
with:
```bash
# API URLs now live in app.js (REGIONS config), no injection needed.
TMP="$ROOT/frontend/app.js"
```

- [ ] **Step 2: Verify the app.js upload line still references $TMP**

Run:
```bash
grep -n 'TMP\|app.js' infra/deploy-frontend.sh
```
Expected: the `aws s3 cp "$TMP" ... app.js ...` line still present; `rm "$TMP"` (if any) should be removed or harmless — see Step 3.

- [ ] **Step 3: Remove the temp-file cleanup if it deletes the real source**

If `infra/deploy-frontend.sh` contains `rm "$TMP"` after the upload, delete that line (since `$TMP` is now the real `frontend/app.js`). Run:
```bash
grep -n 'rm "\$TMP"' infra/deploy-frontend.sh
```
If a match exists, remove that exact line. Expected after fix: no `rm "$TMP"` match.

- [ ] **Step 4: Commit**

Run:
```bash
cd /Users/ozziewang/revshare-aws && git add infra/deploy-frontend.sh && git commit -m "chore: deploy-frontend no longer injects API URL (REGIONS lives in app.js)"
```

---

### Task 7: Deploy frontend + verify both regions live

**Files:** none (deploy + smoke).

- [ ] **Step 1: Deploy the frontend**

Run:
```bash
cd /Users/ozziewang/revshare-aws && ./infra/deploy-frontend.sh 2>&1 | tail -3
```
Expected: uploads succeed; `deployed → https://d2t76jfby056ul.cloudfront.net`.

- [ ] **Step 2: Confirm the deployed app.js carries both API URLs (no broken injection)**

Run:
```bash
curl -sS https://d2t76jfby056ul.cloudfront.net/app.js | grep -c "4qcyojfg79\|7z269nmx74"
```
Expected: `2` (both region API URLs present and intact).

- [ ] **Step 3: Manual verification (browser)**

Open https://d2t76jfby056ul.cloudfront.net (hard refresh). Verify:
- Header reads **RevShare SEA** with a **Thailand/Singapore** select.
- Default region = Thailand; partner list loads (TH data).
- Switch to **Singapore** → page reloads; partner list is empty (SG backend is empty) with no errors; Network calls go to `4qcyojfg79`.
- New-partner form (SG) defaults currency to **SGD**; rule-editor labels read **(SGD/month)**; Analytics chart axis reads **SGD**.
- Switch back to **Thailand** → TH data returns; labels read **THB**; choice persists across a manual refresh.
- Update tab under SG: uploading a tiny rule-batch CSV succeeds (no `not_found`).

- [ ] **Step 4: Update the handoff doc**

In `CLAUDE.md`, update the branding line in §1b. Replace:
```
Branding: app is **"RevShare CHARGESPOT Thailand"** (title/manifest/topbar). Topbar
shows the ChargeSpot logo (`frontend/logo.png`) + "RevShare Thailand". Per-region;
swap name in index.html/manifest.json + `logo.png` for other regions.
```
with:
```
Branding: app is **"RevShare SEA"** with a topbar **Thailand/Singapore** switcher
(`REGIONS` config in `app.js`; choice persists in `localStorage('rs_region')`,
reloads on switch). TH → API `7z269nmx74` / DDB `RevsharePartner`; SG → API
`4qcyojfg79` / DDB `RevsharePartnerSG` (separate `revshare_sg` repo = SG backend
source). Currency follows region via `CCY`/`SYM` (THB/฿ · SGD/S$); per-partner
`currency` still drives each partner's own display. The SG standalone CloudFront
(`E1ALROWEFJOG3Q`) is deprecated — unified site lives on `d2t76jfby056ul`.
```
Also bump the cache-version note near the top of `CLAUDE.md` from `revshare-v56` to `revshare-v61`.

- [ ] **Step 5: Commit the doc**

Run:
```bash
cd /Users/ozziewang/revshare-aws && git add CLAUDE.md && git commit -m "docs: RevShare SEA region switcher + sw v61" && git push origin main
```

---

## Self-review notes

- **Spec coverage:** §3.1 switcher → Tasks 2,3,6; §3.2 branding → Tasks 3,4; §3.3 currency → Task 5; §3.4 backend parity → Task 1; §3.5 SG-site deprecation → documented in Task 7 Step 4. Acceptance criteria all covered by Task 7 Step 3.
- **Type/name consistency:** `REGIONS`, `REGION`, `R()`, `CCY`, `SYM`, `switchRegion`, `#region-switch`, `localStorage('rs_region')` used identically across Tasks 2,3,5.
- **No placeholders:** every code step shows exact before/after text.
- **Push:** only the final doc commit pushes (Step 5); intermediate commits stay local until the deploy is verified, per the project's "deploy → validate → commit/push" convention. (SG repo commit in Task 1 is local; push it if/when desired.)
