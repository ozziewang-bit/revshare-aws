# Google Sign-In + Access Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate RevShare SEA behind Google Sign-In (Workspace domains only), with a read-only baseline and admin-granted per-feature permissions stored in a shared `RevshareUsers` table.

**Architecture:** Client-side Google Identity Services issues an ID token (JWT) sent on every API call. A Lambda auth gate verifies the JWT against Google's cached JWKS (Node `crypto.subtle`, no new dependency), resolves the caller's permissions (admin email / users-table row / read-only baseline), and enforces a route→permission map (401/403). New `/me` and `/users` routes; the frontend gates UI by `/me` permissions and adds an admin Users screen. Shared backend deploys to both regions; one shared users table.

**Tech Stack:** Node 22 ESM Lambda (`node:test`), vanilla-JS SPA, DynamoDB, Google Identity Services. Account `812751451548`, region `ap-southeast-7`.

Spec: `docs/superpowers/specs/2026-06-11-google-auth-access-control-design.md`. Config: domains `inforich.com,inforichjapan.com`; admin `ozzie.wang@inforich.com`.

---

## File Structure
- **Create** `lambda/revshare-api/code/auth.mjs` — pure-ish auth helpers: `resolvePermissions`, `requiredPermission`, `verifyGoogleToken` (+ JWKS cache).
- **Create** `lambda/revshare-api/code/users-db.mjs` — shared `RevshareUsers` table access (own DDB client; synced TH→SG; table name a shared constant).
- **Create** `lambda/revshare-api/code/routes/me.mjs`, `routes/users.mjs`.
- **Create** `lambda/revshare-api/tests/auth.test.mjs` — unit tests for `resolvePermissions` + `requiredPermission`.
- **Modify** `lambda/revshare-api/code/index.mjs` — CORS `authorization` header + auth gate + dispatch `/me` `/users`.
- **Modify** `frontend/index.html` — GIS script + login gate markup.
- **Modify** `frontend/app.js` — boot via sign-in, token in `api()`, `ME` state + permission gating, Users screen.
- **Modify** `frontend/service-worker.js` — bump `CACHE_VERSION`.
- **Modify** `infra/role-policy.json` — add `RevshareUsers` access; **Modify** `infra/setup-once.md` — record IDs.
- **Modify** `CLAUDE.md` — auth section.

Conventions: commits `git -c user.email=ozzie.wang@inforich.com -c user.name=ozziewang commit …`; no `Co-Authored-By`; bump SW on shell change. The PERMS keys (used everywhere): `editPartners, runCalcs, deleteRuns, manageMerchants, manageDeviceTypes, applyRuleBatch, admin`.

---

## Task 1: `users-db.mjs` — shared users table access

**Files:** Create `lambda/revshare-api/code/users-db.mjs`

- [ ] **Step 1: Write the module**

```js
// Shared user-permissions table (RevshareUsers) — SAME physical table for both TH + SG
// Lambdas (permissions are global). Own DDB client so this file can be synced TH→SG
// without touching region-specific db.mjs.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'ap-southeast-7';
const USERS_TABLE = process.env.REVSHARE_USERS_TABLE || 'RevshareUsers';
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export async function getUser(email) {
  const out = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { email } }));
  return out.Item || null;
}
export async function listUsers() {
  const out = await ddb.send(new ScanCommand({ TableName: USERS_TABLE }));
  return out.Items || [];
}
export async function putUser(rec) {
  await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: rec }));
  return rec;
}
export async function deleteUser(email) {
  await ddb.send(new DeleteCommand({ TableName: USERS_TABLE, Key: { email } }));
}
```

- [ ] **Step 2: Verify** — `cd /Users/ozziewang/revshare-aws && node --check lambda/revshare-api/code/users-db.mjs` (exits 0).

- [ ] **Step 3: Commit** — `git add lambda/revshare-api/code/users-db.mjs && git -c user.email=ozzie.wang@inforich.com -c user.name=ozziewang commit -m "feat(auth): shared RevshareUsers table access (users-db.mjs)"`

---

## Task 2: `auth.mjs` — permission resolver, route map, token verify (TDD)

**Files:** Create `lambda/revshare-api/code/auth.mjs`, `lambda/revshare-api/tests/auth.test.mjs`

- [ ] **Step 1: Write the failing tests** (`tests/auth.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermissions, requiredPermission, PERMS } from '../code/auth.mjs';

const ALL_FALSE = Object.fromEntries(PERMS.map(k => [k, false]));

test('admin email → all permissions true', () => {
  const p = resolvePermissions('boss@inforich.com', null, ['boss@inforich.com']);
  assert.equal(PERMS.every(k => p[k] === true), true);
});

test('row permissions are honored; missing keys default false', () => {
  const p = resolvePermissions('u@inforich.com', { email: 'u@inforich.com', permissions: { runCalcs: true } }, ['boss@inforich.com']);
  assert.equal(p.runCalcs, true);
  assert.equal(p.editPartners, false);
  assert.equal(p.admin, false);
});

test('no row, not admin → read-only baseline (all false)', () => {
  assert.deepEqual(resolvePermissions('x@inforich.com', null, ['boss@inforich.com']), ALL_FALSE);
});

test('admin match is case-insensitive', () => {
  const p = resolvePermissions('Boss@Inforich.com', null, ['boss@inforich.com']);
  assert.equal(p.admin, true);
});

test('requiredPermission maps mutations to the right permission', () => {
  assert.equal(requiredPermission('GET', '/partners'), null);
  assert.equal(requiredPermission('PUT', '/partners/abc'), 'editPartners');
  assert.equal(requiredPermission('POST', '/partners/abc/runs'), 'runCalcs');
  assert.equal(requiredPermission('POST', '/bulk-runs'), 'runCalcs');
  assert.equal(requiredPermission('DELETE', '/bulk-runs/r1'), 'deleteRuns');
  assert.equal(requiredPermission('PUT', '/merchants/m1'), 'manageMerchants');
  assert.equal(requiredPermission('DELETE', '/machine-models/S8'), 'manageDeviceTypes');
  assert.equal(requiredPermission('POST', '/import/rule-batch'), 'applyRuleBatch');
  assert.equal(requiredPermission('PUT', '/users/a@b.com'), 'admin');
  assert.equal(requiredPermission('GET', '/me'), null);
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test lambda/revshare-api/tests/auth.test.mjs` → FAIL (cannot find `../code/auth.mjs`).

- [ ] **Step 3: Write `auth.mjs`**

```js
// Authentication (Google ID token verification) + authorization (permission resolution
// and the route→permission map). The resolver + map are pure and unit-tested; token
// verification uses Node 22 crypto.subtle against Google's cached JWKS (no npm dependency).
import { webcrypto } from 'node:crypto';

export const PERMS = ['editPartners', 'runCalcs', 'deleteRuns', 'manageMerchants', 'manageDeviceTypes', 'applyRuleBatch', 'admin'];

// Resolve a caller's effective permissions. admin email → all true; else row's permissions
// (missing keys false); else read-only baseline (all false).
export function resolvePermissions(email, row, adminEmails) {
  const e = (email || '').toLowerCase();
  const admins = (adminEmails || []).map(a => a.toLowerCase());
  if (admins.includes(e)) return Object.fromEntries(PERMS.map(k => [k, true]));
  const granted = (row && row.permissions) || {};
  const out = Object.fromEntries(PERMS.map(k => [k, !!granted[k]]));
  if (out.admin) for (const k of PERMS) out[k] = true;   // admin implies all
  return out;
}

// Map a request to the permission it requires. null → any valid token (reads / me).
export function requiredPermission(method, path) {
  if (method === 'GET') return path.startsWith('/users') ? 'admin' : null;   // reads are open; /users list is admin
  if (path.startsWith('/users')) return 'admin';
  if (path.startsWith('/partners') && /\/runs(\/|$)/.test(path)) return 'runCalcs';   // POST runs / rerun
  if (path.startsWith('/partners')) return 'editPartners';
  if (path === '/bulk-runs') return 'runCalcs';
  if (path.startsWith('/bulk-runs/')) return 'deleteRuns';   // DELETE only mutating sub-route
  if (path.startsWith('/merchants')) return 'manageMerchants';
  if (path.startsWith('/machine-models')) return 'manageDeviceTypes';
  if (path.startsWith('/import/')) return 'applyRuleBatch';
  return 'admin';   // unknown mutation → require admin (fail-closed)
}

// ── Google ID token verification ──────────────────────────────────────────────
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
let jwksCache = { keys: null, exp: 0 };
async function getGoogleKeys() {
  const now = Date.now();
  if (jwksCache.keys && now < jwksCache.exp) return jwksCache.keys;
  const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!r.ok) throw new Error('jwks_fetch_failed');
  const body = await r.json();
  jwksCache = { keys: body.keys, exp: now + 3600_000 };   // cache 1h
  return body.keys;
}
const b64urlToBuf = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// Verify a Google ID token; return its claims or throw. Checks signature, aud, iss, exp, hd.
export async function verifyGoogleToken(idToken, { clientId, allowedDomains }) {
  if (!idToken) throw new Error('no_token');
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('malformed_token');
  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  const keys = await getGoogleKeys();
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown_kid');
  const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBuf(s), Buffer.from(`${h}.${p}`));
  if (!ok) throw new Error('bad_signature');
  if (payload.aud !== clientId) throw new Error('bad_aud');
  if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error('bad_iss');
  if (payload.exp * 1000 < Date.now()) throw new Error('expired');
  if (payload.email_verified !== true) throw new Error('email_unverified');
  if (!allowedDomains.map(d => d.toLowerCase()).includes((payload.hd || '').toLowerCase())) throw new Error('bad_domain');
  return payload;   // { email, hd, name, ... }
}
```

- [ ] **Step 4: Run tests** — `node --test lambda/revshare-api/tests/auth.test.mjs` → all PASS. Then `npm test` (from repo root) → all existing + new pass.

- [ ] **Step 5: Commit** — `git add lambda/revshare-api/code/auth.mjs lambda/revshare-api/tests/auth.test.mjs && git -c … commit -m "feat(auth): Google token verify + permission resolver + route map (auth.mjs, tested)"`

---

## Task 3: Wire the auth gate into `index.mjs`

**Files:** Modify `lambda/revshare-api/code/index.mjs`

- [ ] **Step 1: imports** — add at the top of the import block:
```js
import { verifyGoogleToken, resolvePermissions, requiredPermission } from './auth.mjs';
import { getUser } from './users-db.mjs';
import { meRoute } from './routes/me.mjs';
import { listUsersRoute, putUserRoute, deleteUserRoute } from './routes/users.mjs';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
```

- [ ] **Step 2: CORS allows `authorization`** — in the `OPTIONS` branch change:
```js
        'access-control-allow-headers': 'content-type,x-app-password',
```
to:
```js
        'access-control-allow-headers': 'content-type,authorization',
```

- [ ] **Step 3: auth gate** — immediately after the `if (method === 'GET' && path === '/healthz') return ok({ ok: true });` line, insert:
```js
    // ── Auth gate (everything except OPTIONS + /healthz) ──
    const authz = event.headers?.authorization || event.headers?.Authorization || '';
    const token = authz.replace(/^Bearer\s+/i, '');
    let claims;
    try {
      claims = await verifyGoogleToken(token, { clientId: GOOGLE_CLIENT_ID, allowedDomains: ALLOWED_DOMAINS });
    } catch (e) {
      return cors(resp(401, { error: 'unauthenticated', reason: e.message }));
    }
    const userRow = await getUser(claims.email.toLowerCase());
    const permissions = resolvePermissions(claims.email, userRow, ADMIN_EMAILS);
    const need = requiredPermission(method, path);
    if (need && !permissions[need]) return cors(resp(403, { error: 'forbidden', need }));
    event.auth = { email: claims.email.toLowerCase(), name: claims.name, permissions };
```

- [ ] **Step 4: dispatch `/me` and `/users`** — add these branches (place the `/me` + `/users` lines among the dispatch chain, e.g. right after the Machine-models block):
```js
    else if (method === 'GET'    && path === '/me')                                    result = await meRoute(event);
    else if (method === 'GET'    && path === '/users')                                 result = await listUsersRoute(event);
    else if (method === 'PUT'    && /^\/users\/[^/]+$/.test(path))                      result = await routeUser(event, putUserRoute);
    else if (method === 'DELETE' && /^\/users\/[^/]+$/.test(path))                     result = await routeUser(event, deleteUserRoute);
```
And add the path helper next to the other `route*` helpers:
```js
async function routeUser(event, fn) {
  const path = event.requestContext?.http?.path ?? event.rawPath ?? event.path ?? '';
  const m = path.match(/\/users\/([^/]+)/);
  event.pathParameters = { ...(event.pathParameters || {}), email: decodeURIComponent(m?.[1] || '') };
  return fn(event);
}
```

- [ ] **Step 5: Verify** — `node --check lambda/revshare-api/code/index.mjs` (Task 4 creates `me.mjs`/`users.mjs`; if running before Task 4, expect an unresolved-import error only at runtime — `node --check` is syntax-only and passes).

- [ ] **Step 6: Commit** — `git add lambda/revshare-api/code/index.mjs && git -c … commit -m "feat(auth): verify token + enforce permissions in the Lambda gate; CORS authorization header"`

---

## Task 4: `/me` and `/users` routes

**Files:** Create `lambda/revshare-api/code/routes/me.mjs`, `lambda/revshare-api/code/routes/users.mjs`

- [ ] **Step 1: `me.mjs`**
```js
// Returns the caller's identity + resolved permissions (from the gate).
export async function meRoute(event) {
  const { email, name, permissions } = event.auth || {};
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, name, permissions }) };
}
```

- [ ] **Step 2: `users.mjs`**
```js
import { listUsers, putUser, deleteUser } from '../users-db.mjs';
import { PERMS } from '../auth.mjs';

const resp = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: body == null ? '' : JSON.stringify(body) });

export async function listUsersRoute() {
  return resp(200, await listUsers());
}
export async function putUserRoute(event) {
  const email = (event.pathParameters?.email || '').toLowerCase();
  if (!email) return resp(400, { error: 'missing_email' });
  const body = JSON.parse(event.body || '{}');
  const permissions = Object.fromEntries(PERMS.map(k => [k, !!(body.permissions || {})[k]]));
  const rec = { email, permissions, updatedAt: new Date().toISOString(), updatedBy: event.auth?.email || null };
  await putUser(rec);
  return resp(200, rec);
}
export async function deleteUserRoute(event) {
  const email = (event.pathParameters?.email || '').toLowerCase();
  if (!email) return resp(400, { error: 'missing_email' });
  await deleteUser(email);
  return resp(204, null);
}
```

- [ ] **Step 3: Verify** — `node --check lambda/revshare-api/code/routes/me.mjs && node --check lambda/revshare-api/code/routes/users.mjs && npm test` (all pass).

- [ ] **Step 4: Commit** — `git add lambda/revshare-api/code/routes/me.mjs lambda/revshare-api/code/routes/users.mjs && git -c … commit -m "feat(auth): /me + admin /users routes"`

---

## Task 5: Frontend — Google login gate + token wiring

**Files:** Modify `frontend/index.html`, `frontend/app.js`

- [ ] **Step 1: GIS script + gate markup** (`index.html`) — in `<head>` (or before `</body>`), add:
```html
  <script src="https://accounts.google.com/gsi/client" async></script>
```
Inside `<body>`, before `<main id="main">`, add the gate overlay:
```html
  <div id="login-gate" hidden style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--bg,#fafaf9);z-index:1000;">
    <div style="text-align:center;max-width:340px;">
      <img src="/logo.png" alt="" style="height:40px;margin-bottom:18px;">
      <h2 style="margin:0 0 6px;">RevShare SEA</h2>
      <p class="muted" style="margin:0 0 20px;font-size:13px;">Sign in with your company Google account.</p>
      <div id="gsi-btn" style="display:flex;justify-content:center;"></div>
      <p id="login-err" style="color:#c23434;font-size:13px;margin-top:14px;"></p>
    </div>
  </div>
```

- [ ] **Step 2: client-id + token + boot** (`app.js`) — near the top (after `const API_URL = R().api;`), add:
```js
const GOOGLE_CLIENT_ID = '__GOOGLE_CLIENT_ID__';   // injected at deploy time
let ID_TOKEN = localStorage.getItem('rs_idtoken') || '';
let ME = null;   // { email, name, permissions }
const can = perm => !!(ME && ME.permissions && ME.permissions[perm]);
```

- [ ] **Step 3: `api()` sends the token + handles 401** — replace `api()`:
```js
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (ID_TOKEN) headers['authorization'] = 'Bearer ' + ID_TOKEN;
  const res = await fetch(API_URL + path, { ...opts, headers });
  if (res.status === 401) { ID_TOKEN = ''; localStorage.removeItem('rs_idtoken'); showLoginGate(); throw new Error('unauthenticated'); }
  if (!res.ok) { const text = await res.text(); throw new Error(`HTTP ${res.status}: ${text}`); }
  return res.status === 204 ? null : res.json();
}
```

- [ ] **Step 4: gate + GIS init** (`app.js`) — add these functions and make boot go through auth. Replace the existing boot call (find where `initApp()` is invoked on load — see Step 5) with `boot()`:
```js
function showLoginGate(msg) {
  const g = document.getElementById('login-gate'); if (g) g.hidden = false;
  const m = document.getElementById('main'); if (m) m.style.display = 'none';
  if (msg) { const e = document.getElementById('login-err'); if (e) e.textContent = msg; }
}
function hideLoginGate() {
  const g = document.getElementById('login-gate'); if (g) g.hidden = true;
  const m = document.getElementById('main'); if (m) m.style.display = '';
}
async function onCredential(response) {
  ID_TOKEN = response.credential; localStorage.setItem('rs_idtoken', ID_TOKEN);
  try { ME = await api('/me'); } catch (e) { showLoginGate('That account is not allowed. Use your @inforich.com / @inforichjapan.com account.'); return; }
  hideLoginGate(); initApp();
}
function initGsi() {
  if (!window.google || !google.accounts) { return setTimeout(initGsi, 200); }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true });
  google.accounts.id.renderButton(document.getElementById('gsi-btn'), { theme: 'outline', size: 'large', type: 'standard' });
  google.accounts.id.prompt();   // one-tap / auto sign-in if a session exists
}
async function boot() {
  if (ID_TOKEN) { try { ME = await api('/me'); hideLoginGate(); initApp(); return; } catch (_) { /* fall through to sign-in */ } }
  showLoginGate(); initGsi();
}
```

- [ ] **Step 5: call `boot()` on load** — in `index.html` the inline boot script (lines ~35-39) or wherever `initApp()` runs at startup, change the startup call to `boot()`. If `app.js` self-invokes `initApp()` at the bottom, replace that with `boot()`. Verify there is exactly one startup entry point.

- [ ] **Step 6: deploy script injects the client id** — in `infra/deploy-frontend.sh`, alongside the existing API-URL `sed` injection, add a `sed` that replaces `__GOOGLE_CLIENT_ID__` with `$REVSHARE_GOOGLE_CLIENT_ID` (env var). (Check the script's current injection pattern and mirror it.)

- [ ] **Step 7: Verify** — `node --check frontend/app.js`. Manual deferred to Task 8.

- [ ] **Step 8: Commit** — `git add frontend/index.html frontend/app.js infra/deploy-frontend.sh && git -c … commit -m "feat(auth): Google login gate + bearer token wiring on the frontend"`

---

## Task 6: Frontend — gate controls by permission

**Files:** Modify `frontend/app.js`

- [ ] **Step 1: hide/disable controls** — using `can('<perm>')`, guard the UI. Concretely:
  - Partners list "New partner" button → only render if `can('editPartners')`.
  - Partner detail "Edit rule" button (`showRuleView`) → only render if `can('editPartners')`.
  - "Run share" nav/tab + its actions → only if `can('runCalcs')`.
  - Bulk-run "Delete" controls → only if `can('deleteRuns')`.
  - Merchant add/edit/delete controls → only if `can('manageMerchants')`.
  - Device-types CRUD controls → only if `can('manageDeviceTypes')`.
  - "Update" (rule-batch) tab/action → only if `can('applyRuleBatch')`.
  - "Users" nav item (Task 7) → only if `can('admin')`.
  Each is a small `${can('perm') ? `<button …>` : ''}` guard at the render site. Read views render unchanged for everyone.

- [ ] **Step 2: Verify** — `node --check frontend/app.js`; grep that each guarded control references `can(` (e.g. `grep -c "can('editPartners')" frontend/app.js` ≥ 2).

- [ ] **Step 3: Commit** — `git add frontend/app.js && git -c … commit -m "feat(auth): gate UI controls by permission (can())"`

---

## Task 7: Frontend — admin Users screen

**Files:** Modify `frontend/app.js`, `frontend/index.html`

- [ ] **Step 1: nav entry (admin only)** — add a "Users" nav item rendered only when `can('admin')`, wired to `renderUsersScreen()`.

- [ ] **Step 2: `renderUsersScreen()`** — fetch `GET /users`, render a table: one row per user (email + a checkbox per `PERMS` key) plus an "add by email" input. Saving a row → `PUT /users/<email>` with `{ permissions }`; removing → `DELETE /users/<email>`. The seven permission keys must match the backend exactly: `editPartners, runCalcs, deleteRuns, manageMerchants, manageDeviceTypes, applyRuleBatch, admin`. Show your own admin status as read-only (admins-by-env have no row). Reuse existing table/badge/button styles.

```js
const PERM_LABELS = { editPartners:'Edit partners & rules', runCalcs:'Run calcs', deleteRuns:'Delete runs', manageMerchants:'Manage merchants', manageDeviceTypes:'Device types', applyRuleBatch:'Rule-batch', admin:'Admin' };
async function renderUsersScreen() {
  const main = document.getElementById('main');
  main.innerHTML = '<h2>Users</h2><p class="muted">Grant per-feature access. Anyone with a company Google account can sign in (read-only) until granted more.</p><div id="users-out">Loading…</div>';
  const users = await api('/users');
  const keys = Object.keys(PERM_LABELS);
  const rowHtml = u => `<tr data-email="${escape(u.email)}"><td>${escape(u.email)}</td>${keys.map(k => `<td style="text-align:center"><input type="checkbox" data-perm="${k}" ${u.permissions?.[k] ? 'checked' : ''}></td>`).join('')}<td><button class="btn-primary" data-save>Save</button> <button data-del>Remove</button></td></tr>`;
  document.getElementById('users-out').innerHTML = `
    <div style="margin:10px 0;"><input id="new-user-email" placeholder="email@inforich.com" style="width:240px"> <button id="add-user" class="btn-primary">Add user</button></div>
    <table class="ts"><thead><tr><th>Email</th>${keys.map(k => `<th>${escape(PERM_LABELS[k])}</th>`).join('')}<th></th></tr></thead>
    <tbody>${users.map(rowHtml).join('') || '<tr><td colspan="9" class="muted">No granted users yet.</td></tr>'}</tbody></table>`;
  const save = async tr => {
    const email = tr.dataset.email;
    const permissions = {}; tr.querySelectorAll('input[data-perm]').forEach(c => permissions[c.dataset.perm] = c.checked);
    await api('/users/' + encodeURIComponent(email), { method: 'PUT', body: JSON.stringify({ permissions }) });
  };
  document.querySelectorAll('#users-out [data-save]').forEach(b => b.onclick = () => save(b.closest('tr')).then(() => b.textContent = 'Saved ✓'));
  document.querySelectorAll('#users-out [data-del]').forEach(b => b.onclick = async () => { const tr = b.closest('tr'); await api('/users/' + encodeURIComponent(tr.dataset.email), { method: 'DELETE' }); tr.remove(); });
  document.getElementById('add-user').onclick = async () => {
    const email = document.getElementById('new-user-email').value.trim().toLowerCase(); if (!email) return;
    await api('/users/' + encodeURIComponent(email), { method: 'PUT', body: JSON.stringify({ permissions: {} }) });
    renderUsersScreen();
  };
}
```

- [ ] **Step 3: Verify** — `node --check frontend/app.js`.

- [ ] **Step 4: Commit** — `git add frontend/app.js frontend/index.html && git -c … commit -m "feat(auth): admin Users screen (grant per-feature permissions)"`

---

## Task 8: Infra, config, deploy

**Files:** Modify `infra/role-policy.json`, `infra/setup-once.md`, `frontend/service-worker.js`, `CLAUDE.md`

- [ ] **Step 1: Google OAuth client (manual — user does this)** — In Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → **Web application**. Authorized JavaScript origins: `https://d2t76jfby056ul.cloudfront.net`. Copy the **Client ID**. (No client secret / redirect URI needed for GIS ID-token flow.) Record it in `infra/setup-once.md`.

- [ ] **Step 2: Create the users table** —
```bash
aws dynamodb create-table --region ap-southeast-7 \
  --table-name RevshareUsers \
  --attribute-definitions AttributeName=email,AttributeType=S \
  --key-schema AttributeName=email,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

- [ ] **Step 3: IAM** — in `infra/role-policy.json`, add `dynamodb:Scan` to the actions and a statement for the users table:
```json
    {
      "Effect": "Allow",
      "Action": ["dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem","dynamodb:Scan"],
      "Resource": "arn:aws:dynamodb:ap-southeast-7:812751451548:table/RevshareUsers"
    },
```
Apply to **both** Lambda roles (TH `revshare-api` role + SG `revshare-api-sg` role):
```bash
aws iam put-role-policy --role-name <TH_LAMBDA_ROLE> --policy-name revshare-policy --policy-document file://infra/role-policy.json
aws iam put-role-policy --role-name <SG_LAMBDA_ROLE> --policy-name revshare-policy --policy-document file://infra/role-policy.json
```
(Get the role names from `aws lambda get-function-configuration --function-name revshare-api --query Configuration.Role` and the `-sg` function.)

- [ ] **Step 4: Lambda env vars (both functions)** —
```bash
for FN in revshare-api revshare-api-sg; do
  aws lambda update-function-configuration --region ap-southeast-7 --function-name $FN \
    --environment "Variables={GOOGLE_CLIENT_ID=<CLIENT_ID>,ALLOWED_DOMAINS=inforich.com\,inforichjapan.com,ADMIN_EMAILS=ozzie.wang@inforich.com,REVSHARE_TABLE=<existing>,REVSHARE_RUNS_BUCKET=<existing>}"
done
```
**Important:** `update-function-configuration` REPLACES all env vars — first read each function's current `Environment.Variables` (`aws lambda get-function-configuration --function-name $FN --query Configuration.Environment`) and merge, so existing `REVSHARE_TABLE` (TH=RevsharePartner, SG=RevsharePartnerSG) and `REVSHARE_RUNS_BUCKET` are preserved.

- [ ] **Step 5: bump SW** — in `frontend/service-worker.js`, bump `CACHE_VERSION` (current `revshare-v64` → `revshare-v65`).

- [ ] **Step 6: static gate** — `node --check` all changed `.mjs` + `frontend/app.js`; `npm test` (50 engine/route + new auth tests pass).

- [ ] **Step 7: deploy** — backend both regions: `./infra/deploy-lambda-all.sh` (commit SG repo if it reports changes); frontend: `REVSHARE_GOOGLE_CLIENT_ID=<CLIENT_ID> ./infra/deploy-frontend.sh`.

- [ ] **Step 8: validate** — `curl .../healthz` → `{"ok":true}` (still public); `curl .../partners` with no token → `401`; sign in on the site with an @inforich.com account → loads read-only; grant yourself is automatic (admin email) → Users screen visible; grant another user `runCalcs` → Run-share appears for them. Both TH + SG.

- [ ] **Step 9: docs + commit** — update `CLAUDE.md` §9 (auth) + §6 (routes table: `/me`, `/users`, gate) and `infra/setup-once.md` (client ID, users table, env vars). `git -c … commit -m "docs+infra: Google auth — users table, IAM, env, SW v65, handoff"`. Push both repos after user confirms it works.

---

## Self-Review (completed during planning)
- **Spec coverage:** AuthN/Google verify → Task 2 (`verifyGoogleToken`) + Task 3 (gate) + Task 5 (GIS); AuthZ table → Task 1 + Task 4; resolver/baseline/admin-bootstrap → Task 2 (`resolvePermissions`, tested) + Task 3 (ADMIN_EMAILS env); route→permission map → Task 2 (`requiredPermission`, tested) + Task 3 enforcement; CORS authorization → Task 3; `/me` `/users` → Task 4; frontend gate + token + gating + Users screen → Tasks 5-7; two domains → Task 2 (`allowedDomains` list) + Task 8 env; both-region deploy + shared table + IAM + env → Task 8; tests → Task 2; SW bump → Task 8. All covered.
- **Name consistency:** the seven PERMS keys are identical across `auth.mjs`, `users.mjs`, the route map, the frontend `can()`, and `PERM_LABELS`. `event.auth` set in the gate, read by `meRoute`/`users.mjs`. `ID_TOKEN`/`ME`/`can()` consistent in the frontend.
- **Placeholder scan:** `__GOOGLE_CLIENT_ID__` and `<CLIENT_ID>`/`<…_ROLE>`/`<existing>` are deliberate deploy-time values (resolved in Task 8), not code placeholders. Role names + client id are environment facts gathered at execution.
- **Decomposition note:** large but cohesive (one auth subsystem); tasks are ordered so backend (1-4) is testable before the frontend (5-7), and infra/deploy (8) last.
