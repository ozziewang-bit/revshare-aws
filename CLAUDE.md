# revshare-aws — handoff

Last updated: 2026-05-28 (initial v1 shipped end-to-end).

This document is the authoritative starting point for the next session. Read it
end-to-end before touching anything. The codebase is the ultimate source of
truth — when this doc and the code disagree, the code wins.

## 1. What this is

A ChargeSpot partner revenue-share calculator. Finance picks a partner, uploads
a CSV of per-machine rental + revenue numbers for some period, and the
calculator applies that partner's stored rule (a small tree of leaves + combinators)
to produce an auditable payout breakdown plus a printable PDF statement.

Full design spec: [`docs/superpowers/specs/2026-05-28-revshare-design.md`](docs/superpowers/specs/2026-05-28-revshare-design.md).
Initial implementation plan (33 tasks): [`docs/superpowers/plans/2026-05-28-revshare.md`](docs/superpowers/plans/2026-05-28-revshare.md).

## 2. Live URLs and resources

- **Site (S3 website, plain HTTP):** http://revshare-frontend-felipetan.s3-website-ap-northeast-1.amazonaws.com
- **API:** https://mqszkp91di.execute-api.ap-northeast-1.amazonaws.com
- **Lambda:** `revshare-api` (Node 22.x, ap-northeast-1)
- **DDB table:** `RevsharePartner` (single-table, pk/sk)
- **SSM:** `/revshare/auth-hash` (SecureString, scrypt format)
- **CloudFront:** not yet provisioned. Site is HTTP-only via S3 static website
  until you set up CloudFront + ACM + a custom domain.

Account `585546485067`, region `ap-northeast-1`. IAM user `felipe-mac-cli`.

## 3. File map

| Path | What |
|---|---|
| `lambda/revshare-api/code/engine.mjs` | Pure calculation engine. No AWS SDK. Tested via `node:test`. |
| `lambda/revshare-api/code/csv.mjs` | CSV parser + validation. |
| `lambda/revshare-api/code/auth.mjs` | scrypt verify + in-memory cache. |
| `lambda/revshare-api/code/db.mjs` | DynamoDB wrappers (Partner / Run / AuthFail rows). |
| `lambda/revshare-api/code/routes/` | login.mjs, partners.mjs, runs.mjs |
| `lambda/revshare-api/code/index.mjs` | Lambda entry: auth gate + route dispatch. |
| `lambda/revshare-api/tests/` | `engine.test.mjs` (25 tests), `csv.test.mjs` (6 tests). |
| `frontend/index.html` | SPA shell + pre-paint auth gate. |
| `frontend/style.css` | All styles (tokenized). |
| `frontend/app.js` | All app JS: auth, screens, rule editor, run flow, PDF. |
| `frontend/service-worker.js` | PWA shell cache. **Bump `CACHE_VERSION` on every shell change.** |
| `frontend/lib/` | Self-hosted html2canvas + jsPDF (used by client-side PDF generation). |
| `infra/setup-once.md` | One-time AWS resource walkthrough + live IDs. |
| `infra/deploy-lambda.sh` | Zip + `update-function-code`. |
| `infra/deploy-frontend.sh` | `aws s3 cp` per file. Injects API URL into `app.js` via sed. |
| `infra/trust-lambda.json`, `infra/role-policy.json` | IAM templates. |
| `docs/superpowers/specs/` | Design specs (frozen at spec time). |
| `docs/superpowers/plans/` | Implementation plans. |

## 4. Calculation engine (pure module)

`lambda/revshare-api/code/engine.mjs` exports:

- `MACHINE_MODELS` — `Set<string>` of the nine model codes (S5, S8, S10, T8, T10, T20, T35, L20, L40)
- `evaluateRun({ rule, rows, aggregationMode })` → result object

The engine is a **pure function**. No AWS SDK imports. Anything that adds AWS
to `engine.mjs` is a regression.

**Leaf types:** `flat_per_machine`, `flat_per_partner_total`, `percent`, `tiered_percent`.
**Combinators:** `sum`, `max`, `min`.
**Aggregation:** one flag per partner — `whole` (one eval over all rows) or `per_store` (one eval per store, summed).
**Tiers:** marginal brackets (income-tax style). `basis` is either `rentals` or `revenue`.
**`flat_per_partner_total`** must sit at the top level of the rule in `per_store` mode; the
engine validates and throws otherwise. In `per_store` mode it's evaluated once
across the whole run and recorded in `result.topLevel` separately from per-store payouts.

Run all tests:
```bash
npm test    # from repo root
```
31/31 should pass.

## 5. Data model

Single DDB table `RevsharePartner`. Three row families:

| pk | sk | What |
|---|---|---|
| `PARTNER` | `META#<partnerId>` | Partner config + frozen rule tree. |
| `RUN#<partnerId>` | `RUN#<runId>` | One run = one CSV upload + computed result. Includes `ruleSnapshot` (rule frozen at calc time) + `csvRaw` (base64) + `csvParsed` + `result`. |
| `AUTHFAIL#<ip>` | `TS#<epoch_ms>` | Rate-limit log. TTL field auto-purges after 60s. |

**Rule snapshot per run** is load-bearing: editing a partner's rule does NOT
retroactively change old run results. Each run's PDF/statement reproduces
exactly what was computed at the time.

## 6. Backend routes

All routes require `x-app-password` header except `/healthz` and `/login`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness probe (no auth) |
| POST | `/login` | Probe — verify password (no auth header required; password in body or header) |
| GET | `/partners` | List non-archived partners |
| POST | `/partners` | Create partner |
| GET | `/partners/:id` | Get partner (incl. rule) |
| PUT | `/partners/:id` | Update partner (name/currency/aggregationMode/rule/notes) |
| DELETE | `/partners/:id` | Soft-archive |
| POST | `/partners/:id/runs` | Create run from uploaded CSV (`{periodStart, periodEnd, csvBase64}`) |
| GET | `/partners/:id/runs` | List partner's runs |
| GET | `/partners/:id/runs/:runId` | Get one run (incl. csvRaw, csvParsed, result) |
| POST | `/partners/:id/runs/:runId/rerun` | Re-apply current rule to stored CSV |

CORS configured on the API Gateway to allow `*` origin with headers
`content-type, x-app-password`. Adjust the `AllowOrigins` once a custom
domain exists.

## 7. Working conventions

1. **Patch → deploy → validate → commit → push → doc.** Don't commit before
   the deployed app is confirmed working. The user is the source of truth
   for "this works."
2. **Service worker `CACHE_VERSION` bumps on every shell change.** Without
   the bump, old caches keep serving stale JS/CSS for users who already
   loaded the page once.
3. **Don't include `Co-Authored-By:` trailers in commit messages** — this
   project's commits don't have them.
4. **The calculation engine stays pure.** Tests in `node:test`. No DDB / no
   SSM / no fetch / no fs in `engine.mjs`. If you need IO, do it at the
   route layer and pass plain data into the engine.

## 8. Deploy commands

Backend (Lambda code):
```bash
./infra/deploy-lambda.sh
```

Frontend (SPA):
```bash
./infra/deploy-frontend.sh
```

If/when CloudFront is provisioned:
```bash
REVSHARE_CLOUDFRONT_DIST_ID=EXXXXXX ./infra/deploy-frontend.sh
```

## 9. Auth

Single-password gate. The plaintext password from initial setup was written
once to `/tmp/revshare-pw.txt` (chmod 600) on the operator's Mac at deploy
time — read it once and save it in a password manager; that file may be
deleted any time.

To rotate:
```bash
node -e "const {scryptSync,randomBytes}=require('crypto'); const s=randomBytes(16); const h=scryptSync(process.argv[1],s,64); console.log('scrypt\$'+s.toString('hex')+'\$'+h.toString('hex'))" 'NEW_PASSWORD'
aws ssm put-parameter --region ap-northeast-1 --name /revshare/auth-hash --type SecureString --overwrite --value "scrypt\$....\$...."
```

The 5-minute in-memory hash cache means a rotation takes effect within ~5 min
on the running Lambda, or you can force a cold start:
```bash
aws lambda update-function-configuration --function-name revshare-api \
  --environment "Variables={REVSHARE_TABLE=RevsharePartner,ROTATED=$(date +%s)}" \
  --region ap-northeast-1
```

## 10. Critical rules — don't break these

1. **Always set `aggregationMode` when calling `evaluateRun`** — the engine
   throws on invalid values. Same for `rule` shape.
2. **`flat_per_partner_total` is constrained to root or root-sum-child in
   `per_store` mode.** The engine validates and throws. Don't try to work
   around this — see spec §4.1 for the reasoning.
3. **CSV rows must use the machine-model enum** (S5/S8/S10/T8/T10/T20/T35/L20/L40).
   The engine throws on unknown models. Don't add a new model without also
   adding rule-editor UX for it in `frontend/app.js`.
4. **Bump `CACHE_VERSION` in `frontend/service-worker.js`** on every shell
   deploy. Same discipline as `expense`.
5. **Per-run `ruleSnapshot` is load-bearing.** Don't try to read
   `partner.rule` to display old runs — the run row already has the rule it
   was computed with frozen inside it.

## 11. Known limitations / v2 candidates

- **No CloudFront / no custom domain** — site is HTTP-only via S3 static
  website. Provisioning CloudFront + ACM cert is a 30-minute Console job;
  set `REVSHARE_CLOUDFRONT_DIST_ID` in env after that and the deploy
  script will invalidate on every push.
- **No advanced tree editor** — the basic rule editor (vertical leaf cards
  under implicit SUM) covers ~80% of contract shapes. Rules requiring
  MAX/MIN nesting must be edited via the raw rule JSON in DynamoDB, or
  via the API directly (`PUT /partners/:id` with the rule body).
- **No multi-currency / FX** — each partner stands alone in their fixed
  currency. By design.
- **No partner-facing portal** — only finance staff log in.
- **CORS is `*`** on the API Gateway. Tighten once a stable domain is
  picked.
- **Icons are minimal placeholders** (solid blue squares). Replace with
  real artwork when the brand identity is set.
- **No automated tests on the routes or frontend** — engine has 31 tests
  but the HTTP layer is verified by manual smoke testing only.

## 12. Starting fresh in a future session

1. Read this CLAUDE.md end-to-end.
2. Skim recent commits: `git log --oneline -10`.
3. Verify the deployed app still works:
   ```bash
   curl -sS https://mqszkp91di.execute-api.ap-northeast-1.amazonaws.com/healthz
   # → {"ok":true}
   curl -sS http://revshare-frontend-felipetan.s3-website-ap-northeast-1.amazonaws.com/ | head -5
   # → starts with <!doctype html>
   ```
4. Then propose the work for this session.
