import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// db.mjs is NEVER synced between regions, so every export added here must exist in BOTH
// copies or the synced routes module fails to LOAD in Singapore — a static ESM import of a
// missing name does not degrade. infra/check-db-exports.mjs enforces this at deploy time;
// this test fails faster and explains why.
const th = readFileSync(new URL('../code/db.mjs', import.meta.url), 'utf8');
const sgPath = new URL('file:///Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs');

test('db.mjs exports the upload-document helpers', () => {
  for (const name of ['putUploadDoc', 'getUploadDoc']) {
    assert.match(th, new RegExp(`export async function ${name}\\b`), `TH db.mjs is missing ${name}`);
  }
});

test('putLastUpload accepts the pointer fields the reconciler needs', () => {
  assert.match(th, /export async function putLastUpload\(names, extra = \{\}\)/);
});

test('the Singapore mirror carries the same exports', () => {
  let sg;
  try { sg = readFileSync(sgPath, 'utf8'); } catch { return; }   // SG repo absent: skip, deploy preflight still catches it
  for (const name of ['putUploadDoc', 'getUploadDoc']) {
    assert.match(sg, new RegExp(`export async function ${name}\\b`), `SG db.mjs is missing ${name} — mirror it by hand`);
  }
});
