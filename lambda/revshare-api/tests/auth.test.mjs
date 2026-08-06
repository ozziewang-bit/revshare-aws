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

test('requiredPermission: contract writes need manageMerchants', () => {
  assert.equal(requiredPermission('POST', '/contracts'), 'manageMerchants');
  assert.equal(requiredPermission('PUT', '/contracts/abc'), 'manageMerchants');
  assert.equal(requiredPermission('DELETE', '/contracts/abc'), 'manageMerchants');
  assert.equal(requiredPermission('POST', '/contracts/import'), 'manageMerchants');
});
