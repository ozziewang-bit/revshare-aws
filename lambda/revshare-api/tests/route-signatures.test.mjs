import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// ── The dispatcher hands every handler an EVENT (2026-09-30) ────────────────────────────────
//
// `getBulkRunInputsRoute` declared its one parameter as `runId`. index.mjs calls it — like every
// sibling — as `fn(event)`. So it asked DynamoDB for `BULKRUN#[object Object]`, found nothing, and
// returned 409 `no_stored_inputs`, which the client renders as "this run predates the stored order
// detail". Every per-merchant statement went out with no rentals, for a month, with a message that
// read like a considered explanation. `recomputeBulkRunRoute` had it too: a 404 on every run that
// exists, so Recompute had never worked either.
//
// Nothing could catch this by reading one file: the caller was right, the callee was right, and
// only the pair was wrong. So the test reads the pair.
const root = new URL('../code/', import.meta.url);
const index = readFileSync(new URL('index.mjs', root), 'utf8');

// Every handler name index.mjs passes to a dispatch helper, or awaits with the event directly.
const handlers = new Set();
for (const m of index.matchAll(/route[A-Z]\w*\(\s*(?:withParam\([^)]*\)|event)\s*,\s*(\w+)\s*\)/g)) {
  handlers.add(m[1]);
}
for (const m of index.matchAll(/await (\w+Route)\(\s*(?:event|withParam\()/g)) handlers.add(m[1]);

// Where each one is declared.
const files = [];
for (const d of ['', 'routes/']) {
  for (const f of readdirSync(new URL(d, root))) {
    if (f.endsWith('.mjs')) files.push(readFileSync(new URL(d + f, root), 'utf8'));
  }
}
// indexOf rather than a built regex: escaping a regex through a template string is exactly how
// the first version of this test came to pass on the very bug it was written for.
const declaredParam = (name) => {
  for (const src of files) {
    for (const kw of [`export async function ${name}(`, `export function ${name}(`]) {
      const i = src.indexOf(kw);
      if (i < 0) continue;
      const open = i + kw.length - 1;
      const close = src.indexOf(')', open);
      return src.slice(open + 1, close).trim();
    }
  }
  return null;
};

test('index.mjs actually wires up the handlers this test is about', () => {
  assert.ok(handlers.size >= 15, `found only ${handlers.size} handlers — the scan broke`);
  for (const n of ['getBulkRunInputsRoute', 'recomputeBulkRunRoute', 'getBulkRunRoute']) {
    assert.ok(handlers.has(n), `${n} should be among them`);
  }
});

test('every dispatched handler declares the event it is given', () => {
  const wrong = [];
  for (const name of [...handlers].sort()) {
    const param = declaredParam(name);
    if (param === null) continue;                       // declared elsewhere; nothing to check
    const first = param.split(',')[0].trim().replace(/\s*=.*$/, '');
    if (first && first !== 'event') wrong.push(`${name}(${param})`);
  }
  assert.deepEqual(wrong, [],
    'these take something other than the event they are actually passed:\n  ' + wrong.join('\n  '));
});

test('and the two that were broken read runId out of the path, not out of thin air', () => {
  const src = readFileSync(new URL('routes/bulk-runs.mjs', root), 'utf8');
  for (const name of ['getBulkRunInputsRoute', 'recomputeBulkRunRoute']) {
    const i = src.indexOf(`export async function ${name}(`);
    const body = src.slice(i, src.indexOf('\n}', i));
    assert.match(body, /event\?\.pathParameters\?\.runId/, `${name} must read the path`);
    assert.match(body, /missing_run/, `${name} must say so when it is absent`);
  }
});

// ── withParam must pick the placeholder, not a literal path word (2026-09-30) ────────────────
// `withParam(event, 'runId', path, 2)` against /bulk-runs/<runId>/mail-log extracted the string
// "mail-log": the split drops the empty leading segment, so the id sits at index 1. Every mail
// send was filed under `MAILLOG#mail-log` — one bucket for all runs. It reads as working while
// only one run has been mailed, and starts silently skipping merchants the month a second exists.
//
// Same shape as the signature bug above: the regex was right, the index was right on its own
// terms, and only the pair was wrong. So assert the pair.
test('every withParam index lands on the route pattern\'s own placeholder', () => {
  const withParam = (name, path, index = 1) => path.split('/').filter(Boolean)[index];
  const wrong = [];
  for (const line of index.split('\n')) {
    if (!line.includes('withParam(event')) continue;
    const pat = line.match(/\/\^([^)]*?)\$\/\.test\(path\)/);
    const call = line.match(/withParam\(event, '(\w+)', path(?:, (\d+))?\)/);
    if (!pat || !call) continue;

    // Turn the route regex into a concrete path, each id position a distinct sentinel.
    let n = 0;
    const sample = pat[1].replace(/\\\//g, '/').replace(/\[\^\/\]\+/g, () => `ID${++n}`);
    const got = withParam(call[1], sample, call[2] ? Number(call[2]) : undefined);
    if (!/^ID\d+$/.test(got)) wrong.push(`${sample} · ${call[1]} · index ${call[2] ?? 1} → "${got}"`);
    else if (n === 1 && got !== 'ID1') wrong.push(`${sample} → ${got}`);
  }
  assert.deepEqual(wrong, [],
    'these read a literal path word as an id:\n  ' + wrong.join('\n  '));
});
