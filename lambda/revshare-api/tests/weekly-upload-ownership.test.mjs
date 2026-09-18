import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// THE RULE (2026-09-18): a merchant column is writable by a FILE or by HAND, never both.
//
// That is the whole reason the Merchant view's Merchant/Contact/Machines columns do not open
// for editing — a file writes them, so typing there would be reverted at the next upload with
// nothing said. The inverse has to hold too, and for a while it did not: `Contract entity` was
// an editable grid cell AND a recognised weekly header, so a file carrying that column silently
// won over what someone had typed. This test is the pin, not the comment.
//
// If it fails, the fix is one of two things — never "update the expected list":
//   1. the column is the file's  -> take it out of EDITABLE_GROUPS' groups in the grid, or
//   2. the column is the app's   -> take its alias out of WEEKLY_ALIASES.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');

const slice = (start, end) => {
  const i = app.indexOf(start);
  if (i < 0) throw new Error('missing ' + start);
  return app.slice(i, app.indexOf(end, i) + end.length);
};
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};

// What a file writes: the weekly upload's parsed fields, mapped to contract fields.
const { WEEKLY_ALIASES, WEEKLY_FIELD_KEY } = new Function(
  slice('const WEEKLY_ALIASES = [', '];') + '\n' +
  slice('const WEEKLY_FIELD_KEY = {', '};') + '\n' +
  'return { WEEKLY_ALIASES, WEEKLY_FIELD_KEY };')();

// What the app lets you type: the grid's editable groups.
const financeSrc = slice('const FINANCE_COLUMNS = [', '];');
const { columns, EDITABLE_GROUPS } = new Function('REGION', 'UNIT_MODELS_FALLBACK',
  slice('const EDITABLE_GROUPS = new Set(', ');') + '\n' + financeSrc + '\n' +
  grab('buildContractGridColumns') +
  '\nreturn { columns: buildContractGridColumns(["S5"]), EDITABLE_GROUPS };')('th', ['S5']);

const editableKeys = new Set(columns.filter(c => EDITABLE_GROUPS.has(c.group)).map(c => c.key));
// The machine-list half of an upload writes these directly (importMachineCounts).
const MACHINE_UPLOAD_KEYS = ['units', 'installedUnits'];
const fileWritten = new Set([...Object.values(WEEKLY_FIELD_KEY), ...MACHINE_UPLOAD_KEYS]);

test('no column is writable by both a file and the app', () => {
  const both = [...fileWritten].filter(k => editableKeys.has(k));
  assert.deepEqual(both, [], `these columns can be overwritten by an upload after being typed: ${both.join(', ')}`);
});

test('contract entity belongs to the app, so no weekly alias claims it', () => {
  // Removing the alias is what makes the cell safe to edit. A file still carrying the column is
  // reported as an IGNORED header in the import preview — visible, not silently applied.
  const claimed = WEEKLY_ALIASES.flatMap(a => a.names);
  for (const name of ['contract entity', 'counter party', 'counterparty', 'legal entity', 'company']) {
    assert.ok(!claimed.includes(name), `"${name}" must not be a weekly alias — the app owns this column`);
  }
  assert.ok(!Object.values(WEEKLY_FIELD_KEY).includes('counterParty'),
    'the diff preview must not claim counterParty either');
  assert.ok(editableKeys.has('counterParty'), 'and the grid cell must stay editable');
});

test('every field the weekly diff can report is one the parser can actually produce', () => {
  // WEEKLY_FIELD_KEY is keyed by parsed field NAME. A name no alias yields is dead weight that
  // reads like a supported column — which is exactly how the overlap above survived review.
  const produced = new Set(WEEKLY_ALIASES.map(a => a.field).concat('Branch'));
  for (const field of Object.keys(WEEKLY_FIELD_KEY)) {
    assert.ok(produced.has(field), `${field} is in WEEKLY_FIELD_KEY but no alias produces it`);
  }
});

test('the columns a file DOES own stay read-only', () => {
  // The other half of the rule, stated positively: name, type, branch, contacts and machine
  // counts all arrive with an upload, so none of them may open for editing.
  for (const key of fileWritten) {
    assert.ok(!editableKeys.has(key), `${key} is file-owned and must not be editable`);
  }
});
