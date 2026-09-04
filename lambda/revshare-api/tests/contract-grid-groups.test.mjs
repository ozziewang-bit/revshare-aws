import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Merchant view's column groups (2026-09-04): the screen OPENS COLLAPSED. Six groups spread
// is ~2,900px, past any laptop, so the compact list is the useful default and a column costs one
// click. Extracted from frontend/app.js rather than duplicated — a second copy of a default is a
// default that drifts.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const between = (start, end) => {
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

// CONTRACT_GROUPS through groupOpen: the group list, the persisted state, and the one predicate
// that decides open-ness.
const src = between('const CONTRACT_GROUPS = [', 'const groupOpen = key => CONTRACT_GROUPS_ON[key] === true;');
const load = (stored) => new Function('localStorage',
  src + '\nreturn { CONTRACT_GROUPS, CONTRACT_GROUPS_ON, groupOpen, CT_GROUPS_KEY };'
)({ getItem: () => stored ?? null, setItem: () => {} });

test('a first visit opens with every group collapsed', () => {
  const { CONTRACT_GROUPS, groupOpen } = load(null);
  assert.ok(CONTRACT_GROUPS.length >= 5);
  for (const g of CONTRACT_GROUPS) assert.equal(groupOpen(g.key), false, `${g.key} should start closed`);
});

test('a saved choice still wins', () => {
  const { groupOpen } = load(JSON.stringify({ contact: true, machines: false }));
  assert.equal(groupOpen('contact'), true);
  assert.equal(groupOpen('machines'), false);
});

test('a group absent from saved state is closed, not open', () => {
  // This is the case a newly added group lands in for every returning browser.
  const { groupOpen } = load(JSON.stringify({ contact: true }));
  assert.equal(groupOpen('finance'), false);
});

test('unreadable storage falls through to collapsed rather than throwing', () => {
  const { groupOpen } = load('{not json');
  assert.equal(groupOpen('contract'), false);
});

test('the storage key is versioned, or the new default reaches nobody', () => {
  // Every returning browser already held the old all-open object under `rs_ct_groups`. Reusing
  // that key would have shipped a default that only a brand-new browser could ever see.
  const { CT_GROUPS_KEY } = load(null);
  assert.notEqual(CT_GROUPS_KEY, 'rs_ct_groups');
  assert.ok(!app.includes("localStorage.getItem('rs_ct_groups')"), 'the old key must not be read');
  assert.ok(!app.includes("localStorage.setItem('rs_ct_groups'"), 'the old key must not be written');
});

test('the toggle and the layout share one definition of open', () => {
  // The trap in flipping the default: a layout that treats "not explicitly false" as open, next
  // to a toggle that only opens what is explicitly false, leaves an absent key rendering closed
  // AND toggling to closed — a header that does nothing when clicked. Both must go through
  // groupOpen.
  assert.match(grab('toggleContractGroup'), /!groupOpen\(key\)/);
  assert.match(grab('toggleContractGroup'), /setItem\(CT_GROUPS_KEY/);
  assert.match(grab('contractLayout'), /groupOpen\(key\)/);
});
