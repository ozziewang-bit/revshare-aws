# Login + access control (Google Sign-In) — design

Date: 2026-06-11
Repo: `revshare-aws` (RevShare SEA). Frontend (`frontend/`) + backend
(`lambda/revshare-api/code/`). Shared backend code deploys to **both** regions (TH + SG)
via `./infra/deploy-lambda-all.sh`. Auth was removed 2026-05-28; this re-adds it as
multi-user Google SSO + per-feature authorization.

## Goal
Gate the app behind **Google Sign-In** (company Workspace accounts only). Every signed-in
user gets **read-only baseline**; an **admin** grants per-feature permissions. No region
separation — permissions are global across TH + SG.

## Decisions (from brainstorming)
- **AuthN:** Google Identity Services (client-side ID token / JWT). No passwords, no callback
  server. Restrict to Workspace domain `@inforich.com` (`hd` claim).
- **AuthZ:** a single shared `RevshareUsers` DynamoDB table, keyed by email, read by both
  Lambdas. Permissions are global.
- **Baseline:** any verified domain user with no grants → read-only (GETs allowed, mutations
  denied).
- **Bootstrap admin:** admin email(s) seeded in Lambda env (`ADMIN_EMAILS`) — admin access
  with no table row needed. Initial admin: `ozzie.wang@inforich.com`.
- Dropped: region scoping.

## Permission model
Seven boolean permissions (all default `false` = read-only):
`editPartners`, `runCalcs`, `deleteRuns`, `manageMerchants`, `manageDeviceTypes`,
`applyRuleBatch`, `admin`. `admin` implies all others (and user management).

Pure resolver (unit-tested): `resolvePermissions(email, row, adminEmails) → perms`
- email ∈ adminEmails → all seven `true`.
- else row exists → `row.permissions` (missing keys → `false`).
- else → all `false` (read-only baseline).

## Route → permission map (backend enforcement)
| Routes | Required |
|---|---|
| all `GET` (read) | valid token only |
| `POST/PUT/DELETE /partners*` (incl. rule, no-payout) | `editPartners` |
| `POST /partners/:id/runs`, `POST /bulk-runs`, `rerun` | `runCalcs` |
| `DELETE /bulk-runs/:id` | `deleteRuns` |
| `POST/PUT/DELETE /merchants*` | `manageMerchants` |
| `POST/PUT/DELETE /machine-models*` | `manageDeviceTypes` |
| `POST /import/rule-batch`, `/import/rev-share` | `applyRuleBatch` |
| `GET/PUT/DELETE /users*` | `admin` |
| `GET /me` | valid token only |
| `GET /healthz` | **public** (no token) |

## Backend
1. **`auth.mjs` (new, shared):**
   - `verifyGoogleToken(idToken) → { email, hd, ... }`: parse JWT; fetch & **cache Google's
     JWKS** (`https://www.googleapis.com/oauth2/v3/certs`); verify RS256 via Node 22
     `crypto.subtle` (no new npm dependency); check `aud === GOOGLE_CLIENT_ID`, `exp`, `iss`
     ∈ google issuers, and `hd === ALLOWED_DOMAIN`. Throw on any failure.
   - `resolvePermissions(email, row, adminEmails)` — the pure function above.
   - `requiredPermission(method, path) → 'editPartners' | … | null` (null = read/any-token).
2. **`index.mjs` gate:** after the OPTIONS/`/healthz` short-circuits, on every other request:
   verify the `Authorization: Bearer` token (401 if missing/invalid), load the user's row
   (`getUser(email)`), resolve permissions, look up the route's `requiredPermission`; if set
   and the user lacks it → `403`. Attach `{ email, permissions }` for the handlers.
3. **`db.mjs`:** add `getUser(email)`, `listUsers()`, `putUser(rec)`, `deleteUser(email)` on
   the shared `RevshareUsers` table. **Table name is a shared constant** (identical in both
   regions — NOT region-specific like the partner table), so `deploy-lambda-all.sh` can sync
   the users-access code while each region's own table names stay in `db.mjs`.
4. **Routes:** `routes/me.mjs` (`GET /me` → `{ email, permissions }`), `routes/users.mjs`
   (`GET /users`, `PUT /users/:email`, `DELETE /users/:email`; admin-only — guarded centrally
   + defensively in-route). `PUT` records `updatedAt`, `updatedBy`.
5. **CORS:** add `authorization` to `access-control-allow-headers` (OPTIONS + `cors()`).
6. **Config (Lambda env vars, both functions):** `GOOGLE_CLIENT_ID`, `ALLOWED_DOMAIN`
   (`inforich.com`), `ADMIN_EMAILS` (comma-separated). No SSM needed.

## Frontend
1. **Login gate** (`index.html` pre-paint + `app.js`): if no valid token in storage, render a
   centered Google Sign-In page (GIS `gsi/client` script + button) instead of the app. On
   success, store the ID token; call `GET /me`; if rejected (non-domain / 401), show "use your
   @inforich.com account".
2. **Token wiring:** `api()` adds `Authorization: Bearer <token>`; on `401` → clear + re-prompt
   sign-in; on token expiry (~1h) GIS silently re-issues (auto-select) or re-prompts.
3. **Permission gating:** keep `window.ME = { email, permissions }`. Hide/disable controls the
   user lacks: Edit-rule / New-partner / no-payout (needs `editPartners`); Run-share tab
   (`runCalcs`); run Delete (`deleteRuns`); merchant edit (`manageMerchants`); device-type
   edit (`manageDeviceTypes`); Update tab (`applyRuleBatch`); **Users** screen (`admin`).
   Read-only users still see everything in view mode. The backend is the real enforcer.
4. **Users admin screen:** a new top-level "Users" view (admin-only) — table of users +
   seven permission checkboxes + Save (`PUT /users/:email`); add-by-email; remove. A user
   row also appears automatically once that person has logged in (captured on `/me`).

## Data flow
sign in (Google) → ID token in browser → every API call carries it → Lambda verifies +
resolves permissions → allow/deny (401/403) → handler runs. `RevshareUsers` is the single
source of grants; admins edit it via the Users screen.

## Both regions
Auth code (`auth.mjs`, `me.mjs`, `users.mjs`, index gate, CORS) is shared → synced TH→SG by
`deploy-lambda-all.sh`. The `RevshareUsers` table is **one shared table** both Lambdas reach;
add read/write IAM to **both** roles (`infra/role-policy.json` + the SG role). Env vars set on
both `revshare-api` and `revshare-api-sg`.

## Testing
- New unit tests (`node:test`): `resolvePermissions` (admin / row / baseline), and
  `requiredPermission(method, path)` for the route map. Engine tests unaffected → `npm test`
  stays green.
- Manual: sign in with an @inforich.com account → read-only; non-domain account → rejected;
  admin grants `runCalcs` → Run-share appears + a bulk run succeeds; without it → tab hidden
  and `POST /bulk-runs` returns 403; Users screen hidden for non-admins; both TH + SG enforce.

## Error handling
- Missing/invalid/expired token → `401` (frontend re-prompts).
- Valid token, insufficient permission → `403` (frontend shouldn't have shown the control;
  surfaces a toast if it slips through).
- JWKS fetch failure → `503` with retry; keys cached with TTL to avoid per-request fetches.

## Out of scope
- Region-scoped permissions (dropped).
- Self-service password/account flows (Google owns identity).
- Refresh-token server / long-lived sessions beyond GIS re-issue.
- Audit log of permission changes beyond `updatedBy`/`updatedAt` (could be a follow-up).

## Deploy / infra checklist
1. Create Google OAuth **client ID** (Web), authorized JS origin = the CloudFront URL.
2. Create `RevshareUsers` DDB table (pk `email`); IAM on both Lambda roles.
3. Set env vars on both functions.
4. `./infra/deploy-lambda-all.sh` (commit SG repo if it reports changes) + `./infra/deploy-frontend.sh`; bump SW `CACHE_VERSION`.
