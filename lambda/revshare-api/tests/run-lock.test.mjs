import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Locking a month (2026-10-02) ────────────────────────────────────────────────────────────
// "give me a button to lock each month run, so we don't have to recompute history months"
//
// The action already existed on the run detail, called **Archive**. Two problems with that:
// the word says nothing about what it prevents, and "Archived" already means a different thing
// on the merchant side (an ended contract). The stored field stays `archived` and the routes stay
// /archive and /unarchive — renaming those is a migration for no gain — but the screen says Lock,
// and every month can be locked from the list rather than by opening each run.
//
// WHAT THE LOCK MUST PREVENT: recompute and delete. WHAT IT MUST NOT TOUCH: the statements, the
// download, the mailing, and above all the run's stored order detail. See the inputsKey test at
// the bottom — locking used to destroy exactly that.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const back = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
const db = readFileSync(new URL('../code/db.mjs', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0, k = app.indexOf('(', i);
  for (; k < app.length; k++) { if (app[k] === '(') d++; else if (app[k] === ')') { d--; if (!d) break; } }
  for (let j = app.indexOf('{', k), b = 0; j < app.length; j++) {
    if (app[j] === '{') b++; else if (app[j] === '}') { b--; if (!b) return app.slice(i, j + 1); }
  }
  throw new Error('unterminated ' + n);
};
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const LIST = strip(grab('renderBulkRunsList'));
const DETAIL = strip(grab('renderBulkRunDetail'));

test('every month on the list has its own Lock button', () => {
  assert.match(LIST, /class="btn-ghost lock-run" data-id="\$\{r\.runId\}"/);
  assert.match(LIST, /querySelectorAll\('\.lock-run'\)/, 'and it is wired');
  assert.match(LIST, /can\('runCalcs'\)/, 'gated like every other run action');
});

test('unlocking from the list is admin-only, as it is on the detail', () => {
  const i = LIST.indexOf('unlock-run');
  assert.ok(i > 0, 'the control exists');
  // The branch that renders it must be the admin one.
  const branch = LIST.slice(LIST.indexOf('r.archived'), i);
  assert.match(branch, /can\('admin'\)/);
});

test('a locked month offers no Lock and no Delete', () => {
  // One ternary on r.archived: the locked arm renders Unlock only.
  const i = LIST.indexOf('${r.archived');
  const cell = LIST.slice(i, LIST.indexOf('</td>', i));
  const locked = cell.slice(0, cell.indexOf(': `'));
  assert.ok(!locked.includes('lock-run"'), 'nothing to lock twice');
  assert.ok(!locked.includes('del-run'), 'a locked month cannot be deleted — so do not offer it');
});

test('clicking Lock does not also open the run', () => {
  // Every row is clickable, so an action inside one has to stop the event or you lock a month
  // and get dropped into its detail at the same time.
  for (const sel of ['lock-run', 'unlock-run']) {
    const i = LIST.indexOf(`querySelectorAll('.${sel}')`);
    assert.match(LIST.slice(i, i + 170), /ev\.stopPropagation\(\)/, sel);
  }
});

test('both confirms say what the lock does, and what it does NOT touch', () => {
  const i = LIST.indexOf('const setLock =');
  const fn = LIST.slice(i, LIST.indexOf('\n  };', i));
  assert.match(fn, /no longer be recomputed or deleted/);
  assert.match(fn, /unaffected/, 'the statements and the download are the first worry');
  assert.match(fn, /admin can unlock/);
  assert.match(fn, /recompute reads/, 'and unlocking says why that matters');
});

test('the screen says Lock, not Archive', () => {
  assert.ok(!/>Archive</.test(DETAIL), 'the run detail must not offer "Archive"');
  assert.ok(!/>Unarchive</.test(DETAIL));
  assert.match(DETAIL, />🔒 Lock</);
  assert.match(DETAIL, />Unlock</);
  // BOTH screens. The list and the detail each have their own delete handler with its own 409
  // message, and only one of them got reworded first — the "two call sites, one updated" shape
  // that has caught this project three times. Checked together, and the backend too, since its
  // message reaches the user verbatim.
  // Identifiers are not screen text, and the same word is legitimate in three of them: the
  // element id `br-unarchive`, the route path `/unarchive`, and the `'archive'|'unarchive'`
  // literal that builds it. Those are removed BY FORM, never by name — a filter that drops the
  // case it is checking for passes while the word is on screen.
  const prose = (src) => src
    .replace(/\b[a-z-]*-unarchive\b/g, '')          // element ids
    .replace(/\/(?:un)?archive\b/g, '')             // route paths
    .replace(/'(?:un)?archive'/g, '')                // the literal that picks the path
    .replace(/\b(?:un)?archive[A-Z][A-Za-z]*\b/g, ''); // camelCase names: unarchiveBulkRunRoute
  for (const [name, src] of [['list', LIST], ['detail', DETAIL], ['backend', strip(back)]]) {
    assert.ok(!/[Uu]narchive/.test(prose(src)),
      `the ${name} still says "unarchive" about a run — the screen says Lock`);
  }
  // …and prove the filter can still see the word it is looking for.
  assert.ok(/[Uu]narchive/.test(prose("alert('Unarchive first before deleting this run.')")),
    'the guard must catch the message it was written for');
});

test('the route names are untouched — this is a rename on screen only', () => {
  for (const src of [LIST, DETAIL]) {
    assert.match(src, /\/archive'?[`,)]|\/\$\{locked \? 'archive' : 'unarchive'\}/);
  }
  assert.match(back, /export async function archiveBulkRunRoute/);
  assert.match(back, /export async function unarchiveBulkRunRoute/);
});

test('the list explains the rule once, where the buttons are', () => {
  assert.match(LIST, /<strong>Lock<\/strong> a month once you have acted on it/);
  assert.match(LIST, /Only an admin can unlock/);
});

// ── What the lock actually blocks ────────────────────────────────────────────────────────────
test('a locked run refuses recompute and delete, server-side', () => {
  const rec = back.slice(back.indexOf('export async function recomputeBulkRunRoute'));
  assert.match(rec.slice(0, rec.indexOf('\n}\n')), /old\.archived.*?resp\(409/s);
  const del = back.slice(back.indexOf('export async function deleteBulkRunRoute'));
  assert.match(del.slice(0, del.indexOf('\n}\n')), /run\.archived.*?resp\(409/s);
});

// ── THE BUG THE BUTTON WOULD HAVE SHIPPED ───────────────────────────────────────────────────
// `putBulkRun` rebuilds the slim DynamoDB row from scratch on every write, and `inputsKey` is the
// ONLY pointer to a run's stored orders. `archiveBulkRunRoute` calls it with no inputs, which set
// `inputsKey: null` — leaving a multi-MB object in S3 that nothing could find again. Locking July
// and August did precisely that: both runs' order detail went unreachable and their statement
// downloads would have gone back to "the individual rentals were not kept for this run".
//
// Handing someone a prominent Lock button on top of that bug is the whole reason this test exists.
test('a re-put with no inputs PRESERVES the pointer instead of clearing it', () => {
  const i = db.indexOf('export async function putBulkRun');
  const fn = db.slice(i, db.indexOf('\n}\n', i));
  assert.ok(!/const inputsKey = inputs \?/.test(fn),
    'a const here is the bug: the pointer must be recoverable when no inputs are passed');
  assert.match(fn, /let inputsKey = inputs \?/);
  assert.match(fn, /if \(!inputs\) \{/);
  assert.match(fn, /existing\?\.Item\?\.inputsKey \|\| null/,
    'read the row and keep what it already points at');
  // And the read must happen before the row is written.
  assert.ok(fn.indexOf('existing?.Item?.inputsKey') < fn.indexOf('new PutCommand'));
});

test('the archive and unarchive routes are the callers that rely on it', () => {
  for (const name of ['archiveBulkRunRoute', 'unarchiveBulkRunRoute']) {
    const i = back.indexOf(`export async function ${name}`);
    const fn = back.slice(i, back.indexOf('\n}\n', i));
    assert.match(fn, /putBulkRun\(run\)/, `${name} passes no inputs — by design`);
    assert.ok(!/putBulkRun\(run,/.test(fn), 'it has none to pass, and must not invent any');
  }
});

test('both regions carry the fix — db.mjs is never synced', () => {
  // §8: db.mjs holds each region's table and bucket and is hand-mirrored. A fix applied to one
  // region only is the single most repeated incident in this project.
  const sg = '/Users/ozziewang/revshare_sg/lambda/revshare-api/code/db.mjs';
  let src;
  try { src = readFileSync(sg, 'utf8'); } catch { return; }   // SG repo absent: nothing to assert
  assert.match(src, /let inputsKey = inputs \?/, 'SG db.mjs must preserve inputsKey too');
  assert.match(src, /existing\?\.Item\?\.inputsKey \|\| null/);
});
