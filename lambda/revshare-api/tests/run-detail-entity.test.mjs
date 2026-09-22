import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A rev-share file is shared with the KA as ONE COMPANY, not per brand or per branch, so the
// contract entity is the column finance reconciles against — and it must come FIRST, before
// the brand name (user, 2026-09-21).
//
// The entity is not in the run. Runs freeze what was PAID (§10.5) and have never stored it, so
// it is resolved live from the merchant record. That is the right answer for its actual use —
// "who do we send this to now" — but it does mean a past run's column reflects today's record.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');

const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};
const make = (contracts) => new Function('CONTRACTS',
  grab('contractEntityFor') + '\nreturn contractEntityFor;')(contracts);

test('a payout row resolves the entity from its contract', () => {
  const f = make([{ contractId: 'c1', merchantName: 'AOT', counterParty: 'AOT Public Co., Ltd.' }]);
  assert.equal(f('c1'), 'AOT Public Co., Ltd.');
});

test('a merchant with no entity typed in reads as nothing, never as its brand name', () => {
  // Falling back to the brand would be worse than an em-dash: it would look like a settled
  // legal entity and get paid against.
  const f = make([{ contractId: 'c1', merchantName: 'AOT', counterParty: '' }]);
  assert.equal(f('c1'), null);
  assert.equal(make([{ contractId: 'c1', merchantName: 'AOT' }])('c1'), null);
  assert.equal(make([{ contractId: 'c1', merchantName: 'AOT', counterParty: '   ' }])('c1'), null);
});

test('a merchant deleted since the run reads as nothing rather than throwing', () => {
  // Old runs reference contracts that may no longer exist. The detail page must still render.
  assert.equal(make([])('gone'), null);
  assert.equal(make([{ contractId: 'c1' }])(undefined), null);
});

// Anchored inside renderBulkRunDetail: several screens use `table.ts`, and the first match in
// the file is the Archived list, which also has a Merchant column and its own counter-party one.
const detail = app.slice(app.indexOf('async function renderBulkRunDetail('));
const payoutTable = detail.slice(detail.indexOf('<table class="ts"><thead><tr>'));

test('the entity column comes BEFORE the merchant column', () => {
  // The ordering is the request, not a detail: finance reads down the entity column.
  const head = payoutTable;
  const entity = head.indexOf('Contract entity');
  const merchant = head.indexOf('<th>Merchant</th>');
  assert.ok(entity > 0 && merchant > 0, 'both headers must exist');
  assert.ok(entity < merchant, 'Contract entity must be rendered before Merchant');
});

// ── Reconcile: which name is the app's and which is the file's (2026-09-22) ─────────────────
// A reader looking at "Jharoka ↔ Jharoka by Indus" asked which side was which. The answer was
// worse than missing: the sides were being inferred from position in `names`, and position is
// NOT consistent — one ambiguous-rename path builds [file, …app] while the other builds
// [app, …file], and a brand group is [tag, …branches], which is not a pair at all. Sides are
// now explicit fields, and the table gives each one a column.
test('the table has an app column before a file column', () => {
  const html = grab('reconcileHtml');
  const app_i = html.indexOf('In your app'), file_i = html.indexOf('In your file');
  assert.ok(app_i > 0 && file_i > 0, 'both headers must exist');
  assert.ok(app_i < file_i, 'the app column comes first');
});

test('a row fills those columns from appNames and fileNames, never from name order', () => {
  const row = grab('reconcileRowHtml');
  const app_i = row.indexOf('item.appNames'), file_i = row.indexOf('item.fileNames');
  assert.ok(app_i > 0 && file_i > 0, 'both sides must be read explicitly');
  assert.ok(app_i < file_i, 'and in the same order as the headers');
  assert.ok(!/item\.names\[0\]/.test(row), 'positional name access is the bug this replaced');
});

test('the rename row does not send anyone to a control that does not exist', () => {
  // merchantName sits in the grid's `id` group, which EDITABLE_GROUPS excludes, so nothing in
  // the app renames a merchant. The first version of this text said "do it from Merchants →
  // Edit", which cannot be followed.
  const fix = grab('reconcileFix');
  assert.ok(!/Merchants\s*(→|->)\s*Edit/.test(fix), 'no such control exists');
  assert.match(fix, /not built yet/i, 'it should say so plainly instead');
});

test('the run-detail total row still spans the right number of columns', () => {
  // Adding a column and forgetting the footer is how a total silently lands under the wrong
  // heading. Count the header cells against the footer's leading blanks.
  const table = payoutTable;
  const head = table.slice(0, table.indexOf('</thead>'));
  const cols = (head.match(/<th[\s>]/g) || []).length;   // not /<th/, which also matches <thead
  const foot = table.slice(table.indexOf('<tfoot>'), table.indexOf('</tfoot>'));
  const cells = (foot.match(/<td/g) || []).length;
  assert.equal(cells, cols, `footer has ${cells} cells for ${cols} columns`);
});
