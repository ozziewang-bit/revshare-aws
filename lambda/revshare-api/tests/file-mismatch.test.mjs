import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Where the app disagrees with the file (2026-10-01) ───────────────────────────────────────
// "File upload is the real data, if any setting on the app is not corresponding to the file, just
// highlight it, and you can separate different mismatch with different tab pages."
//
// The expensive case, measured on the 1 Oct file and the live September run:
//   SEACON Bangkae         placement term on L40, machines are LL40×3  → earned 17,200, PAID 0
//   Platinum Fashion Mall  placement term on L40, machines are LL40×1  → earned  2,580, PAID 0
//   PMCU                   MG on L40 + S8, machines LL40+S8            → guarantee cannot fire
// `evalFlatPerMachine` counts roster rows of that exact code, so the term matches nothing and
// pays zero in silence. The codes are deliberately distinct (§11) — the only fix is to show it.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0, k = app.indexOf('(', i);
  for (; k < app.length; k++) { if (app[k] === '(') d++; else if (app[k] === ')') { d--; if (!d) break; } }
  for (let j = app.indexOf('{', k), b = 0; j < app.length; j++) {
    if (app[j] === '{') b++; else if (app[j] === '}') { b--; if (!b) return app.slice(i, j + 1); }
  }
};
const fileMismatches = new Function(
  grab('termModelsOf') + grab('fileMismatches') + 'return fileMismatches;')();
// Assertions must never match words inside a comment — the comments here describe the bugs they
// prevent, so they contain the strings being looked for. Bitten three times; strip first.
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const mg = (model, amount) => ({ type: 'flat_per_machine', rows: [{ model, amount }], _t: 'mg' });
const gp = (percent) => ({ type: 'percent', rows: [{ percent, model: 'ALL' }], _t: 'gp' });

const CONTRACTS = [
  { contractId: 'seacon', merchantName: 'SEACON Bangkae', branchCount: 3, units: { LL40: 3 },
    financeContactEmail: 'a@b.com',
    rule: { type: 'flat_per_machine', rows: [{ model: 'L40', amount: 3000 }], _t: 'placement' } },
  { contractId: 'pmcu', merchantName: 'PMCU', branchCount: 2, units: { LL40: 1, S8: 1 },
    financeContactEmail: 'a@b.com',
    rule: { type: 'max', children: [gp(20), { type: 'flat_per_machine', _t: 'mg',
            rows: [{ model: 'L40', amount: 800 }, { model: 'S8', amount: 250 }] }] } },
  { contractId: 'pct', merchantName: 'Percent Only', branchCount: 1, units: { S8: 1 },
    financeContactEmail: 'a@b.com', rule: gp(25) },
  { contractId: 'none', merchantName: 'No Terms', branchCount: 1, units: { S8: 1 },
    financeContactEmail: 'a@b.com', rule: null },
  { contractId: 'nomail', merchantName: 'No Mail', branchCount: 1, units: { S8: 1 }, rule: gp(10) },
  { contractId: 'gone', merchantName: 'Left The File', branchCount: 4, units: { S8: 4 },
    financeContactEmail: 'a@b.com', rule: gp(10) },
  { contractId: 'arch', merchantName: 'Archived One', archived: true, rule: gp(10) },
  { contractId: 'np', merchantName: 'No Payout', noPayout: true, units: { S8: 9 },
    financeContactEmail: 'a@b.com', rule: mg('L40', 500) },
];
const BRANDS = {
  'seacon bangkae': { label: 'SEACON Bangkae', branches: 3, units: { LL40: 3 } },
  'pmcu':           { label: 'PMCU',           branches: 2, units: { LL40: 1, S8: 1 } },
  'percent only':   { label: 'Percent Only',   branches: 1, units: { S8: 1 } },
  'no terms':       { label: 'No Terms',       branches: 1, units: { S8: 1 } },
  'no mail':        { label: 'No Mail',        branches: 1, units: { S8: 1 } },
  'no payout':      { label: 'No Payout',      branches: 1, units: { S8: 1 } },
  'central rama 9': { label: 'Central Rama 9', branches: 2, units: { LL40: 2 } },
};

test('a term naming a model the file does not list is flagged', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  const names = m.terms.map(t => t.label).sort();
  assert.deepEqual(names, ['PMCU', 'SEACON Bangkae']);
  const seacon = m.terms.find(t => t.label === 'SEACON Bangkae');
  assert.deepEqual(seacon.dead, ['L40'], 'the term pays nothing');
  assert.deepEqual(seacon.uncovered, ['LL40'], 'and these machines earn nothing from it');
});

// A percentage covers every model by design — calling that a mismatch would bury the real ones.
test('a pure percentage rule is NOT a mismatch', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  assert.ok(!m.terms.some(t => t.label === 'Percent Only'));
});

test('a brand in the file with no contract is its own bucket', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  assert.deepEqual(m.noContract.map(x => x.label), ['Central Rama 9']);
  assert.equal(m.noContract[0].branches, 2);
});

test('a contract absent from the file is reported, never deleted', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  assert.deepEqual(m.notInFile.map(x => x.label), ['Left The File']);
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const fn = grab('fileMismatches').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/delete|putContract|api\(/.test(fn), 'the classifier only reports');
});

test('an archived contract is in no bucket at all', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  for (const list of Object.values(m)) {
    assert.ok(!list.some(x => (x.label || '') === 'Archived One'));
  }
});

// A noPayout merchant is not being paid on purpose; a dead term there is not a fault to chase.
test('a noPayout contract is not flagged for its terms', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  assert.ok(!m.terms.some(t => t.label === 'No Payout'));
  assert.ok(!m.noTerms.some(t => t.label === 'No Payout'));
});

test('counts differing from the file are flagged, model changes included', () => {
  const brands = { ...BRANDS, 'no payout': { label: 'No Payout', branches: 1, units: { S8: 1 } } };
  const m = fileMismatches(CONTRACTS, brands);
  const np = m.counts.find(x => x.label === 'No Payout');
  assert.ok(np, 'stored S8:9 against the file S8:1');
  assert.deepEqual(np.changed, ['S8']);
  // The Banpuen case: the MODEL itself changed, which is what can break a term.
  const m2 = fileMismatches(
    [{ contractId: 'b', merchantName: 'Banpuen', branchCount: 1, units: { LL40: 1 },
       financeContactEmail: 'a@b.com', rule: gp(10) }],
    { banpuen: { label: 'Banpuen', branches: 1, units: { S8: 1 } } });
  assert.deepEqual(m2.counts[0].changed.sort(), ['LL40', 'S8']);
});

test('a contract agreeing with the file appears nowhere', () => {
  const m = fileMismatches(
    [{ contractId: 'ok', merchantName: 'Fine', branchCount: 2, units: { S8: 2 },
       financeContactEmail: 'a@b.com', rule: gp(20) }],
    { fine: { label: 'Fine', branches: 2, units: { S8: 2 } } });
  for (const [k, list] of Object.entries(m)) assert.deepEqual(list, [], k);
});

test('no terms, and no finance email, are separate buckets', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  assert.deepEqual(m.noTerms.map(x => x.label), ['No Terms']);
  assert.deepEqual(m.noFinance.map(x => x.label), ['No Mail']);
});

test('no file on record yet means nothing is claimed to disagree', () => {
  const m = fileMismatches(CONTRACTS, {});
  assert.equal(m.terms.length, 0);
  assert.equal(m.noContract.length, 0);
  assert.equal(m.counts.length, 0);
  assert.equal(m.notInFile.length, 7, 'though every live contract is of course absent from it');
});

test('bad input does not throw', () => {
  for (const [c, b] of [[null, null], [undefined, {}], [[], undefined], [[{}], { x: {} }]]) {
    assert.doesNotThrow(() => fileMismatches(c, b));
  }
});

// ── The tabs must actually RENDER (2026-10-01) ───────────────────────────────────────────────
// Shipped twice before from tests that only read source text: `machines is not defined` reached
// production, and `[object Object]` reached a table. These execute drawMismatchTab.
const constOf = (n, end) => app.slice(app.indexOf(`const ${n} =`),
                                      app.indexOf(end, app.indexOf(`const ${n} =`)) + end.length);
// `conflicts` is served by the backend and attached at paint time (see upMismatchCounts), not
// produced by the classifier — so the harness attaches it exactly the way the screen does.
const CHECK = {
  counts: { missing: 1, missingNoMerchant: 0, wrongLink: 1, noLink: 0, notInFile: 0,
            duplicated: 0, duplicateRows: 0 },
  missing: [{ name: 'New shop', state: 'Approved', brand: 'Central Eastville',
              contractId: 'east', model: 'LL40', externalId: '1' }],
  wrongLink: [{ name: 'Journeyhub Pattaya Central', state: 'Approved',
                brand: 'Journeyhub pattaya Central', registryBrand: 'Journeyhub',
                rows: 5, contractId: 'jh' }],
  noLink: [], notInFile: [], duplicated: [],
  machineCheck: {
    counts: { notApprovedDeployed: 1, approvedNoDeployed: 1, deployedUnbound: 1,
              unboundMachines: 0, hasMachineFile: true },
    notApprovedDeployed: [{ name: 'Pending shop', brand: 'GG Bistro', state: 'Pending', deployed: 2 }],
    approvedNoDeployed: [{ name: 'Quiet shop', brand: 'GG Bistro', machines: 0 }],
    deployedUnbound: [{ name: 'Orphan machine shop', deployed: 1, businessId: '123' }],
  },
};
const render = (contracts, brands, check = CHECK) =>
  new Function('CONTRACTS', 'BRANDS', 'CHK', `
  const escape = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const rosterDateLabel = () => '1 Oct';
  const MISMATCH_READ_AT = new Date('2026-10-01T09:30:00Z');
  let REGISTRY_CHECK = CHK;
  const wireMismatchActions = () => {};
  ${constOf('UP_TABS', '];')}
  ${grab('termModelsOf')} ${grab('fileMismatches')} ${grab('registryHtml')} ${grab('drawMismatchTab')}
  const m = fileMismatches(CONTRACTS, BRANDS);
  m.registry = CHK;
  const mc = CHK.machineCheck || { counts: {} };
  m.mDeployed = mc.notApprovedDeployed || [];
  m.mNone = mc.approvedNoDeployed || [];
  m.mUnbound = mc.deployedUnbound || [];
  const out = {};
  for (const t of UP_TABS) {
    if (t.id === 'files') continue;
    const box = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
    drawMismatchTab(box, t.id, m);
    out[t.id] = box.innerHTML;
  }
  return { m, out };
`)(contracts, brands, check);

test('every tab renders, with one row per finding', () => {
  const { m, out } = render(CONTRACTS, BRANDS);
  for (const [id, html] of Object.entries(out)) {
    // The registry tab is several tables, one per bucket, so a single header subtraction does
    // not describe it — it has its own test below.
    if (id === 'registry') { assert.match(html, /<table class="ts">/); continue; }
    const rows = Math.max(0, (html.match(/<tr>/g) || []).length - 1);   // minus the header
    assert.equal(rows, m[id].length, `${id} should show every finding`);
    if (m[id].length) assert.match(html, /<table class="ts">/, `${id} uses the app's table`);
  }
});

test('nothing leaks undefined, [object Object] or NaN into a cell', () => {
  const { out } = render(CONTRACTS, BRANDS);
  for (const [id, html] of Object.entries(out)) {
    assert.ok(!/undefined|\[object Object\]|NaN/.test(html), `${id}: ${html.slice(0, 200)}`);
  }
});

test('an empty tab says the app and the file agree', () => {
  const { out } = render(
    [{ contractId: 'ok', merchantName: 'Fine', branchCount: 1, units: { S8: 1 },
       financeContactEmail: 'a@b.com', rule: gp(20) }],
    { fine: { label: 'Fine', branches: 1, units: { S8: 1 } } },
    { counts: {}, missing: [], wrongLink: [], noLink: [], notInFile: [], duplicated: [],
      machineCheck: { counts: { hasMachineFile: true }, notApprovedDeployed: [],
                      approvedNoDeployed: [], deployedUnbound: [] } });
  // The sentence wraps in the source, so compare on collapsed whitespace.
  for (const html of Object.values(out))
    assert.match(html.replace(/\s+/g, ' '), /the app and your 1 Oct file agree/);
});

test('the terms tab names the dead code and what it costs', () => {
  const { out } = render(CONTRACTS, BRANDS);
  assert.match(out.terms, /SEACON Bangkae/);
  assert.match(out.terms, /pays <strong>nothing<\/strong>/, 'the consequence is stated, not implied');
  assert.match(out.terms, /data-kind="terms"/, 'and the fix is one click away');
});

test('every action button carries a kind the handler knows', () => {
  const { out } = render(CONTRACTS, BRANDS);
  const known = new Set(['terms', 'add', 'archive', 'delete', 'edit', 'repoint']);
  const handler = app.slice(app.indexOf("box.querySelectorAll('.up-fix')"));
  for (const html of Object.values(out)) {
    for (const mm of html.matchAll(/data-kind="(\w+)"/g)) {
      assert.ok(known.has(mm[1]), `unknown kind ${mm[1]}`);
      assert.ok(handler.includes(`'${mm[1]}'`), `${mm[1]} has no branch in the click handler`);
    }
  }
});

// The page must never rebuild its own markup on a tab click: a file someone had loaded and half
// worked through lives in that DOM, and losing it is the complaint this page was built to answer.
test('switching tabs HIDES the file block rather than replacing it', () => {
  const fn = grab('paintUploadTabs').replace(/\/\/[^\n]*/g, '');
  assert.match(fn, /files\.hidden = UP_TAB !== 'files'/);
  assert.ok(!/up-files'\)\.innerHTML|renderUploadScreen\(\)/.test(fn),
            'no repaint of the upload screen from a tab click');
});

test('the mismatch tables do not reuse .ct-scroll', () => {
  // .ct-scroll sets a border and NO overflow; reusing it once painted a table over the controls
  // above it. These get their own scoped wrapper.
  // Strip comments first: this function's own comment NAMES .ct-scroll to explain why it is
  // avoided, and an assertion that reads prose passes on the wrong thing. Third time this trap
  // has been hit in this codebase.
  const fn = grab('drawMismatchTab')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/ct-scroll/.test(fn));
  assert.match(fn, /up-mm-wrap/);
  const css = readFileSync(new URL('../../../frontend/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.up-mm-wrap \{[^}]*overflow-x: auto/, 'and it scrolls itself');
});

test('the registry tab names both sides and offers the file\'s answer', () => {
  const { out } = render(CONTRACTS, BRANDS);
  assert.match(out.registry, /Journeyhub Pattaya Central/);
  assert.match(out.registry, /<strong>Journeyhub pattaya Central<\/strong>/, "the file's answer");
  assert.match(out.registry, /rc-warn">Journeyhub</, "the registry's, marked as the odd one out");
  assert.match(out.registry, /5 row\(s\)/, 'and how many rows would change');
  assert.match(out.registry, /data-kind="repoint"/);
  assert.match(out.registry, /Not in the registry — 1/, 'and the add bucket');
  assert.match(out.registry, /id="reg-add-all"/, 'with one button for the lot');
});

// ── Merchant review state vs machine state (2026-10-01) ──────────────────────────────────────
// Measured on the 29 Sep pair: 0 not-approved-with-machines, 15 approved-with-none, 25 machines
// bound to a shop no merchant file carries.
test('the three machine tabs each name what they found', () => {
  const { out } = render(CONTRACTS, BRANDS);
  assert.match(out.mDeployed, /Pending shop/);
  assert.match(out.mDeployed, /rc-warn">Pending</, 'the state is the point, so it is marked');
  assert.match(out.mNone, /Quiet shop/);
  assert.match(out.mUnbound, /Orphan machine shop/);
  assert.match(out.mUnbound, /123/, 'and the Business ID, which is how you find the machine');
});

test('with no machine list stored, the machine tabs say so instead of looking clean', () => {
  const { out } = render(CONTRACTS, BRANDS,
    { counts: {}, missing: [], wrongLink: [], noLink: [], notInFile: [], duplicated: [],
      machineCheck: { counts: { hasMachineFile: false }, notApprovedDeployed: [],
                      approvedNoDeployed: [], deployedUnbound: [] } });
  for (const id of ['mDeployed', 'mNone', 'mUnbound']) {
    assert.match(out[id], /No machine list has been stored yet/, id);
  }
  // The file-only tabs still answer normally.
  assert.ok(!/No machine list/.test(out.terms));
});
