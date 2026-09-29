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

test('requiredPermission: contract reads are open', () => {
  assert.equal(requiredPermission('GET', '/contracts'), null);
  assert.equal(requiredPermission('GET', '/contracts/abc'), null);
});

test('reading the stored upload needs no permission beyond being signed in', () => {
  assert.equal(requiredPermission('GET', '/contracts/last-upload/rows'), null);
});

test('requiredPermission: contract writes need manageMerchants', () => {
  assert.equal(requiredPermission('POST', '/contracts'), 'manageMerchants');
  assert.equal(requiredPermission('PUT', '/contracts/abc'), 'manageMerchants');
  assert.equal(requiredPermission('DELETE', '/contracts/abc'), 'manageMerchants');
  assert.equal(requiredPermission('POST', '/contracts/import'), 'manageMerchants');
});

// Recompute rebuilds and REPLACES a run, so it is a run operation (runCalcs), not a delete.
// It must be matched before the /bulk-runs/ catch-all, which would demand deleteRuns.
test('POST /bulk-runs/:id/recompute requires runCalcs', () => {
  assert.equal(requiredPermission('POST', '/bulk-runs/01ABC/recompute'), 'runCalcs');
});

// Anyone signed in can FILE a feature request — the people using the app daily are the ones who
// notice what it is missing. The /feature-requests catch-all would otherwise fall through to the
// fail-closed `admin` at the bottom of requiredPermission, and only admins could ask for anything.
test('POST /feature-requests needs no permission beyond being signed in', () => {
  assert.equal(requiredPermission('POST', '/feature-requests'), null);
});

test('reading feature requests is open, like every other GET', () => {
  assert.equal(requiredPermission('GET', '/feature-requests'), null);
});

test('resolving or deleting one is admin', () => {
  assert.equal(requiredPermission('PUT', '/feature-requests/01ABC'), 'admin');
  assert.equal(requiredPermission('DELETE', '/feature-requests/01ABC'), 'admin');
});

// ── Mail templates carry their own permission (2026-09-29) ────────────────────────────────
// They used to require full `admin`, which meant the person who writes merchant-facing wording
// also got user management and the power to unarchive a locked run.

test('mail-template writes need manageMailTemplates, not admin', () => {
  for (const path of ['/mail-templates', '/mail-templates/abc', '/mail-templates/abc/attachment']) {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal(requiredPermission(method, path), 'manageMailTemplates',
        `${method} ${path} should need manageMailTemplates`);
    }
    assert.equal(requiredPermission('GET', path), null, `GET ${path} stays open`);
  }
});

test('manageMailTemplates alone opens templates but nothing else', () => {
  const p = resolvePermissions('t@inforich.com',
    { email: 't@inforich.com', permissions: { manageMailTemplates: true } }, []);
  assert.equal(p.manageMailTemplates, true);
  assert.equal(p.admin, false);
  assert.equal(p.runCalcs, false);
  assert.equal(p.manageMerchants, false);
});

test('admin still implies mail-template editing', () => {
  const p = resolvePermissions('a@inforich.com',
    { email: 'a@inforich.com', permissions: { admin: true } }, []);
  assert.equal(p.manageMailTemplates, true);
});

// Sending is deliberately NOT tied to template editing — whoever runs a payout sends its
// statements, and that stayed on runCalcs.
test('sending a statement still needs runCalcs, not manageMailTemplates', () => {
  assert.equal(requiredPermission('POST', '/bulk-runs/abc/mail-log'), 'runCalcs');
  assert.equal(requiredPermission('GET', '/bulk-runs/abc/mail-log'), null);
});

// ── The Users screen must offer a checkbox for every permission ───────────────────────────
// putUserRoute rebuilds the row over all of PERMS from the request body, so a permission the
// screen does not render is written back as false: saving any row silently revoked it.
// applyRuleBatch was in exactly that state until 2026-09-29, on 5 live users.
test('every permission in PERMS has a label in the Users screen', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const m = src.match(/const PERM_LABELS = \{([^}]*)\}/);
  assert.ok(m, 'PERM_LABELS not found in frontend/app.js');
  const labelled = [...m[1].matchAll(/(\w+)\s*:/g)].map(x => x[1]);
  const missing = PERMS.filter(k => !labelled.includes(k));
  assert.deepEqual(missing, [],
    `PERMS with no checkbox on the Users screen — a save would revoke these: ${missing.join(', ')}`);
});
