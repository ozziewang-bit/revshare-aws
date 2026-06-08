# RevShare SEA — TH/SG region switcher (design)

Date: 2026-06-08
Status: approved (design); pending implementation plan.

## 1. Goal

Turn the single-region revshare-aws app into **"RevShare SEA"**: one site with a
**Thailand / Singapore** switcher. Singapore is visually and behaviourally
**identical** to Thailand, but talks to the Singapore backend and shows SGD where
Thailand shows THB.

This mirrors the proven pattern already shipped in `rental-analysis-th`
("one site, two backends").

## 2. Context / current state

- **Frontend** (`frontend/`): API URL is injected at deploy time —
  `const API_URL = window.REVSHARE_API_URL || ''` (`app.js:2`), with
  `deploy-frontend.sh` `sed`-replacing it with the TH API. Branding is hardcoded
  "RevShare CHARGESPOT Thailand" (title, manifest, topbar `index.html:19`).
- **Currency** is **per-partner**: each partner stores a `currency` field, shown
  via `partner.currency` (badges, hero, statements). But several places hardcode
  "THB"/"฿": the chart axis label (`app.js` ~852), rule-editor field labels
  (Electricity / Others / Placement / Min Guarantee, ~1098–1126), and the
  batch-CSV header `SHARE_TERMS_CSV_HEADER` (`app.js:134`). `SGD` is not yet in
  the `CURRENCIES` list (`app.js:4`).
- **CSV import parser** `csvHeaderIndex` (`app.js:146`) matches header columns by
  **substring keyword** (`c.includes('electricity')`, etc.), NOT by the literal
  "THB" — so localizing the header text is safe.
- **Singapore backend already exists** (`revshare_sg` repo, cloned 2026-06-04):
  - API `https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod`
  - Lambda `revshare-api-sg`, DDB `RevsharePartnerSG`, CloudFront `E1ALROWEFJOG3Q`.
  - Verified live (`/healthz` → ok) but **empty** (`/partners` → `[]`) and
    **stale**: `/import/rule-batch` → `not_found` (predates that endpoint).
- TH backend stays: API `7z269nmx74`, Lambda `revshare-api`, DDB `RevsharePartner`,
  CloudFront `d2t76jfby056ul` (the unified site).

## 3. Design

### 3.1 Region config + switcher (frontend)

Replace the single injected API URL with a `REGIONS` map in `app.js`:

```js
const REGIONS = {
  th: { name: 'Thailand',  api: 'https://7z269nmx74.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'THB', sym: '฿'  },
  sg: { name: 'Singapore', api: 'https://4qcyojfg79.execute-api.ap-southeast-7.amazonaws.com/prod', ccy: 'SGD', sym: 'S$' },
};
let REGION = (localStorage.getItem('rs_region') in REGIONS) ? localStorage.getItem('rs_region') : 'th';
const R = () => REGIONS[REGION];
const API_URL = R().api;            // used by api()
let CCY = R().ccy, SYM = R().sym;
```

- A `<select>` in the topbar (Thailand / Singapore) bound to the active region.
- `switchRegion(rk)`: persist `localStorage('rs_region')`, then `location.reload()`.
  Reload is deliberate — it guarantees no TH↔SG state/cache bleed (partner lists,
  runs, merchant registry are all per-backend).
- Remove the `sed` API-injection block from `infra/deploy-frontend.sh` (both API
  URLs are public; there is no auth).
- Bump `CACHE_VERSION` in `service-worker.js` (v60 → v61) — shell changes.

### 3.2 Branding → "RevShare SEA"

- `index.html` `<title>` and `manifest.json` `name`/`short_name` → "RevShare SEA".
- Topbar: ChargeSpot logo + "RevShare SEA" + the region `<select>` beside it
  (replaces the static "Thailand" span). Same logo for both regions.

### 3.3 Full SGD localization

- Add `SGD` to `CURRENCIES`.
- New-partner form defaults `currency` to `R().ccy` (THB for TH, SGD for SG).
- Replace every hardcoded "THB"/"฿" with `CCY`/`SYM`:
  - chart axis label,
  - rule-editor labels (`Electricity fee (${CCY}/month)`,
    `Others (${CCY}/month)`, `Amount (${CCY}/month)`,
    `Amount (${CCY}/machine/month)`),
  - `SHARE_TERMS_CSV_HEADER` → built from `CCY` (e.g. `Electricity (${CCY}/month)`…).
- **Per-partner display is unchanged**: each partner's own stored `currency`
  still drives badges/hero/statements, so TH partners show THB and SG partners
  show SGD regardless of the active region toggle. The region constant only
  affects defaults + the previously-hardcoded labels.

### 3.4 Backend parity (required)

Sync `revshare_sg/lambda` to the current `revshare-aws/lambda` code and redeploy
`revshare-api-sg` (`revshare_sg/infra/deploy-lambda.sh`), so SG exposes
`/import/rule-batch` and everything else the unified frontend calls. CORS is `*`
on both APIs — no CORS changes needed.

### 3.5 SG standalone site

`revshare_sg`'s CloudFront (`E1ALROWEFJOG3Q`) becomes redundant. The unified site
lives on the TH CloudFront (`d2t76jfby056ul`); `revshare_sg` becomes **backend-only**
(like `rental_analysis_sg`). Its old frontend is left deployed but deprecated — not
torn down in this work.

## 4. Out of scope

- No FX / cross-region aggregation — each backend stands alone.
- No data migration (SG is empty).
- No auth (unchanged).
- No teardown of the deprecated SG frontend/CloudFront.

## 5. Risks

- **Stale SG Lambda** — mitigated by §3.4 (sync + redeploy before/with release).
- **CSV header localization** — safe; parser is keyword-based (verified).
- **State bleed on region switch** — mitigated by full `location.reload()`.

## 6. Acceptance

- Header reads "RevShare SEA"; a TH/SG `<select>` is present and persists across
  reloads.
- Selecting Singapore loads SG data from `4qcyojfg79`, shows SGD/S$ in the chart
  axis, rule-editor labels, CSV header, and new-partner default; selecting
  Thailand shows THB/฿. Per-partner currencies display correctly in both.
- The Update tab (batch rule import) works under SG (`/import/rule-batch` live).
- TH behaviour is unchanged from today.
