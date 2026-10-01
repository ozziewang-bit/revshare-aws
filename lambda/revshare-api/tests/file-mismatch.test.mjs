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
const constOf2 = (n, end) => app.slice(app.indexOf(`const ${n} =`),
                                       app.indexOf(end, app.indexOf(`const ${n} =`)) + end.length);
const fileMismatches = new Function(
  constOf2('INCOMPLETE_FIELDS', '};') + grab('ruleHasAnyValue')
  + grab('percentCoversAll') + grab('percentModelsOf') + grab('isInternalName')
  + 'const entityName = c => c.counterParty || "";'
  + grab('termModelsOf') + grab('fileMismatches') + 'return fileMismatches;')();
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

// "Complete" now means every part — the three incomplete-terms pages look at contract and
// finance details too, so a fixture must carry them to appear nowhere.
test('a brand agreeing with the file, and complete, appears nowhere', () => {
  const m = fileMismatches(
    [{ contractId: 'ok', merchantName: 'Fine', branchCount: 2, units: { S8: 2 },
       aggregationMode: 'whole', financeContactEmail: 'a@b.com', rule: gp(20),
       counterParty: 'Some Co Ltd', startDate: '2026-01-01', endDate: '2027-01-01',
       terminationNoticeDays: 30, autoRenewal: 'Yes', bankName: 'B', bankAccountName: 'A',
       bankAccountNumber: '1', financeContactName: 'F', }],
    { fine: { label: 'Fine', branches: 2, units: { S8: 2 } } });
  for (const [k, list] of Object.entries(m)) assert.deepEqual(list, [], k);
});

// B4 (2026-10-01): "if any part is missing, it is incomplete" — three parts, three pages, each
// opening the section of the editor it is missing.
test('incomplete terms are split into the editor\'s own three parts', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  assert.ok(m.noShareTerms.some(x => x.label === 'No Terms'), 'no rule is a share-terms gap');
  assert.ok(m.noFinanceInfo.some(x => x.label === 'No Mail'), 'no finance email is a finance gap');
  assert.ok(m.noContractInfo.length, 'and a missing entity or date is a contract gap');
});

test('each row names exactly what is missing', () => {
  const m = fileMismatches(CONTRACTS, BRANDS);
  const row = m.noShareTerms.find(x => x.label === 'No Terms');
  assert.deepEqual(row.gaps.sort(), ['aggregation', 'rule']);
});

test('a rule that pays nothing is as incomplete as no rule', () => {
  const m = fileMismatches(
    [{ contractId: 'z', merchantName: 'Zero', aggregationMode: 'whole',
       rule: { type: 'percent', rows: [{ percent: 0, model: 'ALL' }], _t: 'gp' } }],
    { zero: { label: 'Zero', branches: 1, units: { S8: 1 } } });
  assert.deepEqual(m.noShareTerms[0].gaps, ['rule pays nothing']);
});

test('a brand marked no-payout is excused its SHARE TERMS only', () => {
  const m = fileMismatches(
    [{ contractId: 'n', merchantName: 'NP', noPayout: true }],
    { np: { label: 'NP', branches: 1, units: { S8: 1 } } });
  assert.deepEqual(m.noShareTerms, [], 'deliberately unpaid, so no terms are expected');
  assert.ok(m.noContractInfo.length, 'but it is still invoiced, so the entity is still required');
  assert.ok(m.noFinanceInfo.length);
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
  let FILE_COUNTS_APPLIED = { at: new Date(), done: 3, failed: [] };
  const wireMismatchActions = () => {};
  ${constOf('UP_TABS', '];')}
  ${constOf('INCOMPLETE_FIELDS', '};')} ${constOf('INCOMPLETE_LABEL', '};')}
  ${grab('ruleHasAnyValue')} ${grab('percentCoversAll')} ${grab('percentModelsOf')} ${grab('isInternalName')}
  const entityName = c => c.counterParty || '';
  ${grab('termModelsOf')} ${grab('fileMismatches')} ${grab('registryHtml')} ${grab('drawMismatchTab')}
  const m = fileMismatches(CONTRACTS, BRANDS);
  m.registry = CHK;
  const mc = CHK.machineCheck || { counts: {} };
  m.mDeployed = mc.notApprovedDeployed || [];
  m.noShareTerms = m.noShareTerms || []; m.noContractInfo = m.noContractInfo || [];
  m.noFinanceInfo = m.noFinanceInfo || [];
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
       aggregationMode: 'whole', financeContactEmail: 'a@b.com', rule: gp(20),
       counterParty: 'Some Co Ltd', startDate: '2026-01-01', endDate: '2027-01-01',
       terminationNoticeDays: 30, autoRenewal: 'Yes', bankName: 'B', bankAccountName: 'A',
       bankAccountNumber: '1', financeContactName: 'F', }],
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
  const known = new Set(['terms', 'add', 'archive', 'delete', 'edit', 'repoint', 'ackmodel']);
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

// ── The file's counts are WRITTEN, not listed as a chore (2026-10-01) ────────────────────────
// "didn't i just say you can update the registry directly?" — yes, and only the DISPLAY had been
// built. The Counts tab was a to-do list whose only button was "Edit terms", which has nothing to
// do with a count. The file owns these numbers, so one button writes all of them.
// "just update, i said my file is the truth, you don't have to ask me to initiate it" —
// so there is no button and no confirm. The counts are written when the page reads them.
test('the counts tab has NO button — the file is applied, not offered', () => {
  const { out } = render(CONTRACTS, BRANDS);
  assert.ok(!/cnt-apply|Update all/.test(out.counts), 'nothing to press');
  assert.match(out.counts, /still to write/);
  assert.match(out.counts, /Terms, entity,\s*contacts and past runs are untouched/);
});

test('every tab says how many brands were written from the file', () => {
  const { out } = render(CONTRACTS, BRANDS);
  for (const [id, html] of Object.entries(out)) {
    assert.match(html, /3 brand\(s\) updated from the file/, id);
  }
});

test('applyFileCounts sends only the three fields the file owns', () => {
  const fn = strip(grab('applyFileCounts'));
  assert.match(fn, /branchCount: r\.fileBranches, units, installedUnits/);
  assert.ok(!/rule|entityId|financeContactEmail|startDate/.test(fn),
            'a contract PUT merges, so anything else sent would overwrite something it owns');
  assert.match(fn, /installedUnits = Object\.values\(units\)\.reduce/,
               'the total is derived from the file, not carried over');
  assert.match(fn, /failed\.push/, 'one brand failing must not hide the rest');
  assert.match(fn, /if \(!can\('manageMerchants'\)\) return null/, 'and permission still applies');
});

test('it runs on its own, as part of reading the file', () => {
  const fn = strip(grab('refreshMismatchData'));
  assert.match(fn, /await applyFileCounts\(\)/);
  assert.match(fn, /ensureContractCache\(true\)/, 'and re-reads, so the tabs show what was written');
});

// "what do you mean by model change?" — it meant a MACHINE TYPE present on one side and absent
// on the other, which is not the same as a different count and matters on its own: a per-machine
// term keyed to the type that disappeared matches no machine and pays nothing (§1ad).
test('a machine type the file no longer lists is named, in plain words', () => {
  const { out } = render(
    [{ contractId: 'b', merchantName: 'Banpuen', branchCount: 1, units: { LL40: 1 },
       financeContactEmail: 'a@b.com', rule: gp(10) }],
    { banpuen: { label: 'Banpuen', branches: 1, units: { S8: 1 } } });
  assert.match(out.counts, /no longer has LL40/);
  assert.ok(!/model changed/.test(out.counts), 'the word "model" was ours, not yours');
  assert.match(out.counts, /pays nothing/, 'and the tooltip says why it matters');
  assert.match(out.counts, /Check terms/, 'with a way straight to the terms');
});

test('a brand whose counts merely differ gets no warning and no terms button', () => {
  const { out } = render(
    [{ contractId: 'c', merchantName: 'Center One', branchCount: 3, units: { S8: 4, L20: 1 },
       financeContactEmail: 'a@b.com', rule: gp(10) }],
    { 'center one': { label: 'Center One', branches: 3, units: { S8: 2, L20: 1 } } });
  assert.ok(!/no longer has/.test(out.counts), 'both types are still there — only the count moved');
  assert.ok(!/Check terms/.test(out.counts), 'nothing to check: the counts write themselves');
});

// ── A file older than the recorded one is never applied (2026-10-01) ─────────────────────────
// The browser holds the last file loaded ON THIS MACHINE. On 2026-10-01 that was the 29 Sept
// pair while the server's roster was that morning's, uploaded by a colleague. Once the file is
// applied automatically, re-previewing the held one would write the OLDER numbers over the newer
// upload without a word — "an improvement overwrote existing data", which is the one rule that
// has never been allowed to bend.
const stale = (mine, theirs) => new Function('MINE', 'THEIRS', `
  const UPLOAD_STATE = { at: MINE };
  const ROSTER_BRANDS = { at: THEIRS };
  ${grab('fileIsStale')}
  return fileIsStale();
`)(mine, theirs);

test('a held file read before the recorded upload is stale', () => {
  assert.equal(stale('2026-09-29T09:06:00Z', '2026-10-01T04:05:46Z'), true);
});

test('a file read after it is not, and neither is the same instant', () => {
  assert.equal(stale('2026-10-01T05:00:00Z', '2026-10-01T04:05:46Z'), false);
  assert.equal(stale('2026-10-01T04:05:46Z', '2026-10-01T04:05:46Z'), false);
});

test('with either date unknown it is NOT called stale', () => {
  // Refusing to apply on a missing timestamp would block the first upload of all.
  assert.equal(stale(null, '2026-10-01T04:05:46Z'), false);
  assert.equal(stale('2026-09-29T09:06:00Z', null), false);
  assert.equal(stale(null, null), false);
});

test('the bulk apply stops before writing anything', () => {
  const fn = strip(grab('applyFileChanges'));
  const guard = fn.indexOf('fileIsStale()');
  const write = fn.indexOf("method: 'PUT'");
  assert.ok(guard > 0 && write > guard, 'the check comes before the first write');
  assert.match(fn, /return \{ done: 0, failed: \[\], stale: true \}/);
});

test('the per-row button refuses too, and says why', () => {
  const fn = strip(grab('updateFromFile'));
  assert.match(fn, /if \(fileIsStale\(\)\)/);
  assert.match(fn, /older than the one already recorded/);
  const guard = fn.indexOf('fileIsStale()');
  const write = fn.indexOf("method: 'PUT'");
  assert.ok(guard > 0 && write > guard);
});

test('the screen says so where the file is named', () => {
  const fn = strip(grab('heldBannerHtml'));
  assert.match(fn, /This file is older than the one already recorded/);
  assert.match(fn, /nothing on this screen is\s*applied/);
});

// ── A stale held file is discarded, not shown (2026-10-01) ───────────────────────────────────
// "why don't you just use these fucking new files, instead you want me to forget previous file"
// — fair. The browser held the 29 Sept pair while the app's record was that morning's upload by
// a colleague. Telling the person to press "Forget this file" asks them to tidy up after the app.
test('the screen drops a held file older than the recorded upload, by itself', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function renderUploadScreen');
  const fn = strip(src.slice(i, src.indexOf("el.querySelector('#up-out').addEventListener", i)));
  assert.match(fn, /new Date\(held\.at\)\.getTime\(\) < new Date\(ROSTER_BRANDS\.at\)\.getTime\(\)/);
  assert.match(fn, /await clearUploadDraft\(\)/, 'and removes it, so it cannot come back');
  assert.match(fn, /held = null;/, 'and does not restore it');
  assert.match(fn, /has been discarded/, 'and says what it did, naming the file');
});

test('a held file that is NOT older is kept — work in progress survives a reload', () => {
  const src = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = src.indexOf('async function renderUploadScreen');
  const fn = strip(src.slice(i, src.indexOf("el.querySelector('#up-out').addEventListener", i)));
  // The guard needs BOTH dates; a missing one must leave the draft alone rather than bin it.
  assert.match(fn, /if \(held && held\.at && ROSTER_BRANDS\.at/);
  assert.match(fn, /await restoreUploadDraft\(held\)/);
});

// ── B2: adopt terms from another brand (2026-10-01) ─────────────────────────────────────────
// "when edit terms, I can type to complete every details terms, or adopt current or archived one
// (select by brand)". Archived brands are offered on purpose — an ended contract is often the
// exact shape being renewed.
const editorSrc = (() => {
  const i = app.indexOf('async function openTermsEditor(');
  return strip(app.slice(i, app.indexOf('\n}\n', i)));
})();

test('the editor offers every other brand that has terms that pay', () => {
  assert.match(editorSrc, /x\.contractId !== contractId && x\.rule && ruleHasAnyValue\(x\.rule\)/);
  assert.match(editorSrc, /d\.archived \? ' \(archived\)' : ''/, 'archived ones are offered, and marked');
  assert.match(editorSrc, /termText\(d\.rule\)/, 'labelled with what they actually pay');
});

test('adopting FILLS the form — it saves nothing by itself', () => {
  const i = editorSrc.indexOf("adopt.addEventListener('change'");
  const handler = editorSrc.slice(i, editorSrc.indexOf('\n  });', i));
  assert.ok(!/api\(|method: 'PUT'/.test(handler), 'nothing is written until Save');
  assert.match(handler, /renderStructuredRuleEditor\(ruleBox/, 'it repaints the editor');
  assert.match(handler, /agg\.value = d\.aggregationMode/, 'and brings the aggregation mode with it');
  assert.match(handler, /nopay\.checked = false/, 'adopting paying terms clears "not paid"');
});

test('the rule is deep-copied, so the two brands stay independent', () => {
  const i = editorSrc.indexOf("adopt.addEventListener('change'");
  const handler = editorSrc.slice(i, editorSrc.indexOf('\n  });', i));
  assert.match(handler, /JSON\.parse\(JSON\.stringify\(d\.rule\)\)/);
});

test('the editor variable can be replaced when terms are adopted', () => {
  // `const editor` would make adopting throw on assignment — the save reads `editor` afterwards.
  assert.match(editorSrc, /let editor = renderStructuredRuleEditor/);
});

// ── A fix must leave the table (2026-10-01) ──────────────────────────────────────────────────
// "if we update on the upload page, it doesn't work, still remains in the table." Two faults:
//
//  1. `await openAddFromFile(id, b); await after();` — the dialog OPENS and returns, so the
//     refresh ran while the form was still on screen. By the time anything was saved the tab had
//     already been repainted, so the row was still there.
//  2. `openAddFromFile` returned silently when `UPLOAD_STATE.diff` was null, which is the normal
//     state on these tabs: they read the file ON RECORD, not one loaded in this browser.
test('every dialog the tabs open reports back when it SAVES', () => {
  const i = app.indexOf("b.dataset.kind === 'terms'");
  const branch = strip(app.slice(i, app.indexOf('\n  }));', i)));
  assert.match(branch, /openTermsEditor\(id, after\)/);
  assert.match(branch, /openContractEditor\(id, after\)/);
  assert.match(branch, /openAddFromFile\(id, b, after\)/);
  // Archive and delete finish inline — a confirm and one request, no dialog left on screen — so
  // refreshing beside them is right. The three that OPEN something must not.
  for (const kind of ['terms', 'edit', 'add']) {
    const line = branch.split('\n').find(l => l.includes(`=== '${kind}'`)) || '';
    assert.ok(!/await after\(\)/.test(line), `${kind} must not refresh beside the call`);
    assert.match(line, /after\)/, `${kind} must hand after to the dialog`);
  }
  assert.match(branch, /archiveFromUpload\(id, b\); await after\(\)/, 'these two do finish inline');
});

test('the contract editor calls back after the PUT, not before', () => {
  const i = app.indexOf('function openContractEditor(');
  const fn = strip(app.slice(i, app.indexOf('\n}\n', i)));
  assert.match(fn, /function openContractEditor\(contractId, onSaved\)/);
  const put = fn.indexOf("method: 'PUT'");
  const cb = fn.indexOf('if (onSaved)');
  assert.ok(put > 0 && cb > put, 'the callback comes after the save');
});

test('Add to list works with no file loaded, from the file on record', () => {
  const i = app.indexOf('async function openAddFromFile(');
  const fn = strip(app.slice(i, app.indexOf('\n}\n', i)));
  assert.match(fn, /ROSTER_BRANDS\.brands \|\| \{\}/, 'it falls back to the stored file');
  assert.match(fn, /stored \? stored\.branches : null/, 'merchant count comes with it');
  assert.ok(!/const row = .*\n.*if \(!row\) return;/.test(fn),
            'and it no longer returns in silence');
  assert.match(fn, /is not in the file on record/, 'a genuine miss says so');
});

test('the add dialog reports back after creating, not on open', () => {
  const i = app.indexOf('async function openAddFromFile(');
  const fn = strip(app.slice(i, app.indexOf('\n}\n', i)));
  const post = fn.indexOf("api('/contracts', { method: 'POST'");
  const cb = fn.indexOf('if (onSaved)');
  assert.ok(post > 0 && cb > post);
});

// ── C2: what blocks a run, and what is only reported (2026-10-01) ────────────────────────────
// "217 brands lack contract info and 277 lack finance info didn't block a run" — confirmed by the
// user. SHARE TERMS block, because without them a brand cannot be paid at all. Contract and
// finance gaps are reported where the decision to run is made, and do not block: making them
// block would mean no run could happen.
test('only missing SHARE TERMS blocks step 4', () => {
  const wiz = strip(app.slice(app.indexOf('<span class="wizard-step-num">3</span>'),
                              app.indexOf('<span class="wizard-step-num">4</span>')));
  assert.match(wiz, /pendingTerms\.length === 0/);
  assert.match(wiz, /need revenue-share terms before you can run/);
  assert.ok(!/financeContactEmail|startDate|entityId/.test(wiz),
            'nothing about contract or finance detail may gate the run');
});

test('the other two parts are reported in the same place, as not blocking', () => {
  const fn = strip(grab('incompleteTermsNote'));
  assert.match(fn, /incomplete contract information/);
  assert.match(fn, /incomplete finance information/);
  assert.match(fn, /Neither stops this run/);
  assert.match(fn, /cannot be sent its statement/, 'and says what it does cost');
  assert.match(fn, /INCOMPLETE_FIELDS\[part\]/, 'one definition of complete, shared with the tabs');
});

test('the run reminder states both file dates and warns when stale', () => {
  assert.match(app, /Merchant list updated/);
  assert.match(app, /Machine list updated/);
  assert.match(app, /const stale = days >= 14/);
  assert.match(app, /No merchant list stored yet/);
});

// ── A machine type earns if ANYTHING pays for it (2026-10-01) ────────────────────────────────
// "For QSNCC, you notify S8 has no terms... but what if their S8 literally has no terms, only
// LL40 has?" The question exposed a real error first: QSNCC's rule is
// `GP 35% (ALL) + Placement LL40 2,000`, so its five S8 machines earn through the 35%. Reading
// only the per-machine terms made five earning machines look uncovered.
const pctAll = (p) => ({ type: 'percent', rows: [{ percent: p, model: 'ALL' }], _t: 'gp' });
const perMachine = (model, amount) =>
  ({ type: 'flat_per_machine', rows: [{ model, amount }], _t: 'placement' });

test('a revenue share on ALL covers every machine type', () => {
  const m = fileMismatches(
    [{ contractId: 'q', merchantName: 'QSNCC', aggregationMode: 'whole',
       rule: { type: 'sum', children: [pctAll(35), perMachine('LL40', 2000)] } }],
    { qsncc: { label: 'QSNCC', branches: 10, units: { S8: 5, LL40: 5 } } });
  assert.deepEqual(m.terms, [], 'the S8s earn through the 35%');
});

test('a percentage on ONE model covers that model only', () => {
  const m = fileMismatches(
    [{ contractId: 'x', merchantName: 'X', aggregationMode: 'whole',
       rule: { type: 'sum', children: [
         { type: 'percent', rows: [{ percent: 20, model: 'S8' }], _t: 'gp' },
         perMachine('LL40', 2000)] } }],
    { x: { label: 'X', branches: 3, units: { S8: 1, LL40: 1, S5: 1 } } });
  assert.deepEqual(m.terms[0].uncovered, ['S5'], 'S8 earns on the percentage, LL40 per machine');
});

// The user's actual question: when NOTHING reaches a type, it genuinely earns nothing — which may
// be deliberate. It is raised once and can be settled, per MODEL.
test('a type nothing pays for is raised, and the effect is stated plainly', () => {
  const m = fileMismatches(
    [{ contractId: 'y', merchantName: 'Y', aggregationMode: 'whole', rule: perMachine('LL40', 2000) }],
    { y: { label: 'Y', branches: 2, units: { S8: 5, LL40: 5 } } });
  assert.deepEqual(m.terms[0].uncovered, ['S8']);
  const { out } = render(
    [{ contractId: 'y', merchantName: 'Y', aggregationMode: 'whole', rule: perMachine('LL40', 2000) }],
    { y: { label: 'Y', branches: 2, units: { S8: 5, LL40: 5 } } });
  assert.match(out.terms, /nothing pays for S8/);
  assert.match(out.terms, /data-kind="ackmodel"/, 'and it can be settled as intentional');
  assert.match(out.terms, /data-models="S8"/);
});

test('once acknowledged it stops being raised — per model, not per brand', () => {
  const base = { contractId: 'y', merchantName: 'Y', aggregationMode: 'whole',
                 rule: perMachine('LL40', 2000) };
  const brands = { y: { label: 'Y', branches: 2, units: { S8: 5, LL40: 5 } } };
  assert.deepEqual(fileMismatches([{ ...base, uncoveredModelsAck: ['S8'] }], brands).terms, []);
  // A type added to the file later is a NEW question, not covered by the old answer.
  const later = { y: { label: 'Y', branches: 3, units: { S8: 5, LL40: 5, S5: 2 } } };
  assert.deepEqual(fileMismatches([{ ...base, uncoveredModelsAck: ['S8'] }], later).terms[0].uncovered,
                   ['S5']);
});

test('acknowledging changes no terms and no payout', () => {
  const i = app.indexOf("b.dataset.kind === 'ackmodel'");
  const fn = strip(app.slice(i, app.indexOf('\n    }', i)));
  assert.match(fn, /JSON\.stringify\(\{ uncoveredModelsAck: ack \}\)/, 'one field, nothing else');
  assert.ok(!/rule|aggregationMode|noPayout/.test(fn));
  assert.match(fn, /changes no terms and no payout/, 'and it says so before writing');
});
