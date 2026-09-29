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

// ── Two categories, not six groups (2026-09-29) ─────────────────────────────────────────────
// The user's model: MERCHANT INFORMATION comes from the file and is never edited; MERCHANT TERMS
// — contract, finance AND share terms — is one data set maintained by hand. They are agreed,
// signed and settled together, so the grid shows them under one header with one toggle.
const appSrc = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');

test('contract, finance and share terms are one category', () => {
  const block = appSrc.slice(appSrc.indexOf('const CONTRACT_GROUPS = ['),
                             appSrc.indexOf('function contractCategoryOf'));
  for (const k of ['contract', 'finance', 'terms']) {
    assert.match(block, new RegExp(`key: '${k}',[^\\n]*category: 'terms'`),
      `${k} belongs to the Merchant terms category`);
  }
  assert.match(block, /CONTRACT_CATEGORIES = \{ terms: 'Merchant terms' \}/);
});

test('the file-owned groups are NOT folded into it', () => {
  const block = appSrc.slice(appSrc.indexOf('const CONTRACT_GROUPS = ['),
                             appSrc.indexOf('function contractCategoryOf'));
  for (const k of ['contact', 'machines']) {
    assert.doesNotMatch(block, new RegExp(`key: '${k}',[^\\n]*category:`),
      `${k} is merchant INFORMATION and stays its own group`);
  }
});

test('the grid groups by category, so one toggle opens the whole terms set', () => {
  const i = appSrc.indexOf('function contractLayout()');
  const fn = appSrc.slice(i, appSrc.indexOf('\n}', i));
  assert.match(fn, /contractCategoryOf\(groupKey\)/);
  assert.match(fn, /open: !toggleable \|\| groupOpen\(key\)/);
});

// The editor still shows the three as separate, labelled sections — one data set does not mean
// one undifferentiated form.
test('the editor keeps Contract and Finance as named sections', () => {
  const i = appSrc.indexOf('function openContractEditor');
  const fn = appSrc.slice(i, appSrc.indexOf('\n}\n', i));
  assert.match(fn, /col\.group === 'contract' \|\| col\.group === 'finance'/);
  assert.match(fn, /ct-ed-h">Contract</);
  assert.match(fn, /ct-ed-h">Finance</);
  assert.match(fn, /ct-ed-h">Share terms</);
});
