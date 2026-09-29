import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The weekly job as its own page: drop in the two files, see what disagrees, then decide.
// It shares its matcher, its differ and its route with the dialog it replaces, so the page
// cannot describe an import that is not the one that would run.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};

test('Upload is its own nav item and opens its own screen', () => {
  assert.match(app, /<button id="nav-upload" class="nav-btn">Upload<\/button>/);
  assert.match(app, /setActiveNav\('nav-upload'\); renderUploadScreen\(\);/);
});

// The preview must use the SAME functions the import uses, or it describes a different import.
test('the preview reuses the real parser, differ and machine matcher', () => {
  const fn = grab('previewUpload');
  assert.match(fn, /parseWeeklyMerchantFile\(mf\)/);
  assert.match(fn, /parseMachineCountFile\(kf\)/);
  assert.match(fn, /matchMachineStores\(machines\.byStore, await loadRegistry\(\), roster, CONTRACTS\)/,
    'the matcher gets the file AND the contracts — it stays pure');
  assert.match(fn, /diffWeeklyRows\(parsed, CONTRACTS\)/);
});

test('nothing is written while previewing', () => {
  const fn = grab('previewUpload');
  assert.doesNotMatch(fn, /method: 'POST'/);
  assert.doesNotMatch(fn, /method: 'PUT'/);
  assert.doesNotMatch(fn, /importMachineCounts/);
});

// ── No bulk button: every merchant change is one row, one click (2026-09-29) ───────────────
// "no I don't need the button, I want to fix one by one." Import and Review-only are gone. They
// did two things no row button did, and those had to go somewhere real rather than be deleted:
//   • REMEMBERING THE FILE — the roster a run reads and the brand list the ⦿ marks compare
//     against. Neither changes a merchant, so it happens when the file is read.
//   • A MERCHANT'S SHOPS AND MACHINES — carried by the row action that adds or updates it.
test('the bulk buttons are gone', () => {
  assert.ok(!app.includes('id="up-import"'), 'no Import button');
  assert.ok(!app.includes('id="up-review"'), 'no Review-only button');
  assert.ok(!/function submitUpload/.test(app), 'and no bulk submit path');
});

test('reading the file records it, and creates or changes no merchant', () => {
  const fn = grab('rememberUploadedFile');
  assert.match(fn, /api\('\/roster', \{ method: 'PUT'/);
  assert.match(fn, /names,/, 'the brand list travels with it for the ⦿ marks');
  assert.ok(!/'\/contracts'/.test(fn), 'it must not create a merchant');
  assert.ok(!/'\/registry'/.test(fn), 'nor write the store index');
});

test('the preview records the file and says so when it cannot', () => {
  const fn = grab('previewUpload');
  assert.match(fn, /await rememberUploadedFile\(parsed, machines, roster\)/);
  assert.match(fn, /not be recorded for Run share/);
});

test("adding or updating one merchant brings that merchant's shops and machines", () => {
  for (const n of ['openAddFromFile', 'updateFromFile']) {
    assert.match(grab(n), /await applyShopsForBrand\(/, `${n} carries the shops`);
  }
  const fn = grab('applyShopsForBrand');
  assert.match(fn, /key\(r\.partnerName\) === want/, "only that brand's shops");
  assert.match(fn, /api\('\/registry'/);
  assert.match(fn, /installedUnits: total/);
  assert.ok(!/for \(const c of CONTRACTS/.test(fn), 'and it never loops the merchant list');
});

// Every mismatch the file creates has a home, and each says what it MEANS rather than only that
// it differs — the lesson §1o's table learned the hard way.
test('every mismatch bucket is rendered, with a reason column', () => {
  const groups = app.slice(app.indexOf('const UPLOAD_GROUPS'), app.indexOf('let UPLOAD_STATE'));
  for (const k of ['added', 'changed', 'missing', 'unknown', 'unlinked', 'unchanged']) {
    assert.ok(groups.includes(`key: '${k}'`), `${k} needs a group`);
  }
  const fn = grab('uploadTableHtml');
  assert.match(fn, /What it means/);
  assert.match(fn, /rc-grouprow rc-tone-/, 'it reuses the Reconcile group bands');
});

// The single most consequential thing the parser can get wrong (§1l: 2,357 shops → 2,357
// "merchants"). It must be stated on the page, not buried.
test('a file with no Merchant label column says so loudly', () => {
  const fn = grab('uploadSummaryHtml');
  assert.match(fn, /brandFromBranch/);
  assert.match(fn, /rc-warn/, 'and it is a warning, not a muted aside');
});

test('a store the preview cannot place is named, not silently dropped', () => {
  const fn = grab('uploadTableHtml');
  assert.match(fn, /misses\?\.unknown/);
  assert.match(fn, /misses\?\.unlinked/);
});

// Reconcile left the Merchant view on 2026-09-29. Comparing your list against a file belongs
// where you are holding the file — one page, not the same answer in two places.
test('the Merchant view has no Reconcile tab and no tab strip', () => {
  const fn = grab('renderContractsScreen');
  assert.doesNotMatch(fn, /merchantHead\(/, 'no tab strip on the merchant grid');
  assert.doesNotMatch(fn, /wireMerchantTabs\(\)/);
});

test('a review-only upload now lands on the Upload page', () => {
  assert.doesNotMatch(app, /await renderReconcileTab\(\);/,
    'nothing routes to the removed tab any more');
  assert.match(app, /await renderUploadScreen\(\);\n          return;/);
});

// ── Add to list (2026-09-29) ───────────────────────────────────────────────────────────────
// The first per-row action: bring one merchant out of the file and into the list, with its terms
// set in the same breath. Nothing is created until Save — closing the dialog leaves the merchant
// list exactly as it was.
test('every new-merchant row carries an Add to list button', () => {
  const fn = grab('uploadTableHtml');
  assert.match(fn, /up-add-btn/);
  assert.match(fn, /r\.act \|\| '<span class="muted">—<\/span>'/,
    'rows without an action still render the column');
});

test('the button is delegated, so it survives a repaint', () => {
  const fn = grab('renderUploadScreen');
  assert.match(fn, /#up-out'\)\.addEventListener\('click'/);
  assert.match(fn, /closest\('\.up-add-btn'\)/);
});

test('nothing is created before Save', () => {
  const fn = grab('openAddFromFile');
  const beforeSave = fn.slice(0, fn.indexOf("#af-save').addEventListener"));
  assert.doesNotMatch(beforeSave, /method: 'POST'/, 'opening the dialog writes nothing');
});

// The two categories, kept apart inside the dialog: the file's columns are shown as fact, and
// only contract / finance / share terms are typed.
test('the dialog shows file data as fact and edits only the terms set', () => {
  const fn = grab('openAddFromFile');
  assert.match(fn, /From your file — not editable/);
  assert.match(fn, /c\.group === 'contract' \|\| c\.group === 'finance'/);
  for (const owned of ['merchantName', 'branchCount', 'contactName']) {
    assert.ok(!new RegExp(`data-k="${owned}"`).test(fn), `${owned} must not be typeable here`);
  }
});

// What it creates must equal what an import would have created, plus the terms — otherwise
// adding one merchant by hand quietly produces a different row from adding it in bulk.
test('the created row maps the file through the same field table as the import', () => {
  const fn = grab('openAddFromFile');
  assert.match(fn, /WEEKLY_FIELD_KEY\[label\]/);
  assert.match(fn, /body\.branchCount = branchCount/);
});

test('terms are set in the same save, and no-payout skips the rule', () => {
  const fn = grab('openAddFromFile');
  assert.match(fn, /body\.aggregationMode = card\.querySelector\('#af-agg'\)\.value;/);
  assert.match(fn, /body\.noPayout = nopay\.checked;/);
  assert.match(fn, /if \(!nopay\.checked\) \{/, 'a no-payout merchant needs no rule');
});

// ── The upload is HELD (2026-09-29) ────────────────────────────────────────────────────────
// An upload is a piece of work, not a moment: the file is read once and the differences are
// worked through one at a time. A browser cannot keep a file selection across a reload — that is
// how an afternoon's work was lost — but the PARSED rows can be kept, and they are all the page
// ever needed.
test('a parsed file is held, and the diff deliberately is not', () => {
  const fn = grab('previewUpload');
  assert.match(fn, /saveUploadDraft\(\{ parsed, machines, roster,/);
  assert.ok(!/saveUploadDraft\([^)]*\bdiff\b/.test(fn),
    'the diff must be recomputed, so an added merchant drops out of "new" on its own');
});

test('the held file comes back when the page opens', () => {
  const fn = grab('renderUploadScreen');
  assert.match(fn, /held = await loadUploadDraft\(\)/);
  assert.match(fn, /await restoreUploadDraft\(held\)/);
});

test('restoring recomputes against the CURRENT merchant list', () => {
  const fn = grab('restoreUploadDraft');
  assert.match(fn, /diffWeeklyRows\(parsed, CONTRACTS\)/);
  assert.match(fn, /matchMachineStores\(machines\.byStore, await loadRegistry\(\), roster, CONTRACTS\)/,
    'the matcher gets the file AND the contracts — it stays pure');
});

test('the page says what it is working from, and can forget it', () => {
  assert.match(grab('heldBannerHtml'), /Working from/);
  const fn = grab('restoreUploadDraft');
  assert.match(fn, /clearUploadDraft\(\)/);
  assert.match(fn, /Nothing that has already been added to your merchant list is undone/);
});

// Private mode, a full disk, a blocked database — remembering is a convenience and must never
// stop someone uploading.
test('every storage call fails soft', () => {
  for (const n of ['saveUploadDraft', 'loadUploadDraft', 'clearUploadDraft']) {
    assert.match(grab(n), /catch/, `${n} must swallow storage failures`);
  }
  assert.match(grab('loadUploadDraft'), /catch \{ return null; \}/);
});

test('the held file is scoped to the region', () => {
  assert.match(grab('saveUploadDraft'), /put\(draft, REGION\)/);
  assert.match(grab('loadUploadDraft'), /get\(REGION\)/);
});

// ── Update to the list (2026-09-29) ────────────────────────────────────────────────────────
// The second per-row action: apply exactly the differences the row states. This is the only
// place in the app that writes merchant INFORMATION, which is safe precisely because those
// columns belong to the file — and it must not be able to reach anything else.
test('every changed row carries an Update button', () => {
  const fn = grab('uploadTableHtml');
  assert.match(fn, /up-upd-btn/);
  assert.match(fn, /Update to the list/);
});

test('it writes exactly the diffs the row showed, and nothing else', () => {
  const fn = grab('updateFromFile');
  assert.match(fn, /for \(const d of row\.diffs \|\| \[\]\)/, 'the body comes from the row itself');
  assert.match(fn, /WEEKLY_FIELD_KEY\[d\.field\]/, 'mapped through the same table as the import');
  assert.match(fn, /key === 'merchantName'\) continue/, 'the name is the match key, never a change');
  // The terms set must be unreachable from here.
  for (const k of ['entityId', 'counterParty', 'startDate', 'endDate', 'rule',
                   'aggregationMode', 'noPayout', 'bankName', 'financeContactEmail']) {
    assert.ok(!fn.includes(`'${k}'`), `${k} must be unreachable from a file update`);
  }
});

test('branch count is written as a number, not the file string', () => {
  assert.match(grab('updateFromFile'), /key === 'branchCount' \? \(Number\(d\.to\) \|\| 0\) : d\.to/);
});

test('it refuses when the merchant has gone, rather than creating one', () => {
  const fn = grab('updateFromFile');
  assert.match(fn, /no longer in your list/);
  assert.doesNotMatch(fn, /method: 'POST'/, 'an update never creates');
});

// REVERSED 2026-09-29, by the user: "when I finish an update, it will be removed from the
// table." Rows used to stay, marked ✓ done. Keeping them meant the counts above them drifted
// away from what was actually left to do. Now the differences are recomputed and a handled row
// simply is not among them any more — what remains on screen is exactly what remains to do.
test('a handled row leaves the table, and is confirmed in one line', () => {
  for (const n of ['updateFromFile', 'openAddFromFile']) {
    const fn = grab(n);
    assert.match(fn, /await refreshUploadTable\(`✓ /, `${n} refreshes and confirms`);
  }
});

// ── Archive and Delete (2026-09-29) ────────────────────────────────────────────────────────
// "In your list, not in this file" covers two very different situations — a contract that ended,
// and a shop simply absent from one week's export. So the row states what is at stake, and the
// gentler action is the one in reach.
test('a missing row offers Archive first, then Delete', () => {
  const fn = grab('uploadTableHtml');
  const i = fn.indexOf('up-arch-btn'), j = fn.indexOf('up-del-btn');
  assert.ok(i > 0 && j > i, 'Archive comes before Delete');
  assert.match(fn.slice(j, j + 160), /var\(--loss\)/, 'Delete is visibly the dangerous one');
});

test('the row says what is at stake before either button is pressed', () => {
  const fn = grab('uploadMissingWhy');
  assert.match(fn, /an import never removes a merchant/);
  assert.match(fn, /It has revenue-share terms set/);
  assert.match(fn, /Contract end:/);
});

// Archiving is not deleting: §1b — the row, its terms and its store links all stay, and a past
// run that paid it is untouched.
test('archive keeps everything and says so', () => {
  const fn = grab('archiveFromUpload');
  assert.match(fn, /JSON\.stringify\(\{ archived: true \}\)/, 'it writes only the flag');
  assert.match(fn, /you can unarchive it/);
  assert.doesNotMatch(fn, /method: 'DELETE'/);
});

test('delete warns that terms exist nowhere else, and offers archive instead', () => {
  const fn = grab('deleteFromUpload');
  assert.match(fn, /exist nowhere else/);
  assert.match(fn, /Archive keeps the row/);
  assert.match(fn, /cannot be undone/);
});

test('both refuse when the merchant has already gone, and both confirm first', () => {
  for (const n of ['archiveFromUpload', 'deleteFromUpload']) {
    const fn = grab(n);
    assert.match(fn, /no longer in your list/, `${n} handles a vanished row`);
    assert.match(fn, /if \(!confirm\(/, `${n} must confirm`);
    assert.match(fn, /can\('manageMerchants'\)/, `${n} must be permission-gated`);
  }
});

// ── The misses must be readable (2026-09-29) ───────────────────────────────────────────────
// matchMachineStores pushes {store, machines} OBJECTS. Rendering them as strings printed
// "[object Object]" on every row — the codebase already carried a comment warning about exactly
// that, next to machineMissNames, and it happened anyway.
test('a machine-list miss shows the store name, not an object', () => {
  const fn = grab('uploadTableHtml');
  // Asserted by RUNNING it — the shape of the call has changed twice since, and pinning the
  // call's exact text tested the wrong thing both times.
  const uploadTableHtml = runTable();
  const html = uploadTableHtml(null,
    { unknown: [{ store: 'Named Shop', machines: 2 }], unlinked: [], conflicts: [] },
    { byStore: new Map([['Named Shop', { S8: 2 }]]) }, null);
  assert.ok(html.includes('Named Shop'), 'the store name is rendered');
  assert.ok(!html.includes('[object Object]'), 'never the object itself');
});

// "Give me something to refer to" — the row has to be findable in the file it came from.
test('a miss says how many machines are there, and which models', () => {
  const fn = grab('machineCountText');
  assert.match(fn, /machine\$\{n === 1 \? '' : 's'\}/);
  assert.match(fn, /×\$\{c\}/, 'the model breakdown is what you look for in the file');
  assert.match(fn, /byStore instanceof Map/, 'byStore is a Map, not an object');
});

// Three answers, not two — and the one that matters most is "your file knows this shop".
test('a miss says whether the merchant FILE knows the shop', () => {
  const fn = grab('machineMissWhy');
  assert.match(fn, /x\.fileBrand/, 'the file is consulted before anything else is said');
  assert.match(fn, /add it above and this shop places itself/);
  assert.match(fn, /are not paid to anybody/, 'unlinked: money is at stake');
  assert.match(fn, /A run will not fix it/, 'unknown: a run is a snapshot, not a repair');
});

// REVERSED 2026-09-29, by the user: "you should map two files for merchant and machine
// information, and then map the registry". The first cut asked the registry first, reasoning
// that nothing already resolved should move. That was backwards — the registry is DERIVED
// history, learned from past run rosters, so it can place a shop under last month's merchant
// while the file in your hand says otherwise.
//
// Asserted by RUNNING the matcher, not by where a substring sits in its body — that kind of
// test is what let a ReferenceError reach production earlier in this session.
test('the file wins when both the file and the registry name a live merchant', () => {
  const run = new Function('return ' + grab('matchMachineStores'))();
  const stores = new Map([['Shop', { S5: 1 }]]);
  const cons = [{ contractId: 'a', merchantName: 'Alpha' }, { contractId: 'b', merchantName: 'Beta' }];
  const reg = [{ name: 'Shop', contractId: 'a' }];
  const roster = { merchants: [{ name: 'Shop', partnerName: 'Beta' }] };
  const m = run(stores, reg, roster, cons);
  assert.equal(m.totals.get('b')?.S5, 1, 'the file placed it under Beta');
  assert.equal(m.totals.has('a'), false, 'not under the registry\'s answer');
  assert.equal(m.matchedViaFile, 1);
  assert.equal(m.conflicts.length, 1, 'and the move is reported');
});

test('the registry answers only for shops the file does not mention', () => {
  const run = new Function('return ' + grab('matchMachineStores'))();
  const stores = new Map([['Shop', { S5: 1 }]]);
  const cons = [{ contractId: 'a', merchantName: 'Alpha' }];
  const m = run(stores, [{ name: 'Shop', contractId: 'a' }], { merchants: [] }, cons);
  assert.equal(m.totals.get('a')?.S5, 1);
  assert.equal(m.matchedViaFile, 0);
  assert.equal(m.conflicts.length, 0);
});

// ── Holding the file must not depend on who owns the paint (2026-09-29) ────────────────────
// The save sat AFTER the paint-currency check, so any preview bound by a render that had since
// been superseded returned early and never held the file — the page then looked like it had
// never seen one. Saving is cheap and harmless; it cannot be gated on that.
test('the file is held before the paint check, not after', () => {
  const fn = grab('previewUpload');
  assert.ok(fn.indexOf('saveUploadDraft(') < fn.indexOf('!paintIsCurrent(token)'),
    'holding the file comes first');
});

test('a save that fails says so instead of promising quietly', () => {
  const fn = grab('saveUploadDraft');
  assert.match(fn, /return true;/);
  assert.match(fn, /return false;/);
  assert.match(fn, /onabort/, 'an aborted transaction is a failure too');
  const prev = grab('previewUpload');
  assert.match(prev, /const heldOk = await saveUploadDraft/);
  assert.match(prev, /could <strong>not<\/strong> be held/);
});

test('a held file that cannot be restored is reported, not swallowed', () => {
  const fn = grab('renderUploadScreen');
  assert.match(fn, /could not be\s*\n?\s*restored/);
  assert.match(fn, /catch \{ held = null; \}/);
});

// ── The table is EXECUTED, not just read (2026-09-29) ──────────────────────────────────────
// Every test above greps the source. That let a plain ReferenceError ship: `uploadTableHtml`
// took (diff, misses) while its rows called `machineCountText(x, machines)` — a variable that
// did not exist in that scope — and the page rendered "machines is not defined". Source-shape
// assertions cannot catch that. This one builds the function and calls it.
const runTableWith = (contracts) => {
  const src = ['escape', 'machineCountText', 'machineMissWhy', 'uploadAddedWhy',
               'uploadChangedWhy', 'uploadMissingWhy', 'similarity', 'similarExistingMerchants',
               'closestFileStore', 'uploadTableHtml'].map(grab).join('\n')
    + '\n' + app.slice(app.indexOf('function reconcileKey'),
                        app.indexOf('\n}', app.indexOf('function reconcileKey')) + 2)
    + '\n' + app.slice(app.indexOf('const ruleIsAbsent ='),
                       app.indexOf('\n', app.indexOf('const ruleIsAbsent =')));
  const groups = app.slice(app.indexOf('const UPLOAD_GROUPS'), app.indexOf('let UPLOAD_STATE'));
  return new Function('CONTRACTS', `${groups}\n${src}\nreturn uploadTableHtml;`)(contracts);
};
const runTable = () => {
  const src = ['escape', 'machineCountText', 'machineMissWhy', 'uploadAddedWhy',
               'uploadChangedWhy', 'uploadMissingWhy', 'similarity', 'similarExistingMerchants',
               'closestFileStore', 'uploadTableHtml'].map(grab).join('\n')
    + '\n' + app.slice(app.indexOf('function reconcileKey'),
                        app.indexOf('\n}', app.indexOf('function reconcileKey')) + 2)
    + '\n' + app.slice(app.indexOf('const ruleIsAbsent ='),
                       app.indexOf('\n', app.indexOf('const ruleIsAbsent =')));
  const groups = app.slice(app.indexOf('const UPLOAD_GROUPS'), app.indexOf('let UPLOAD_STATE'));
  return new Function('CONTRACTS', `${groups}\n${src}\nreturn uploadTableHtml;`)([
    { contractId: 'c1', merchantName: 'Old Brand' },
  ]);
};

test('the table renders every bucket without throwing', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['Shop A', { S8: 2 }], ['Shop B', { S5: 1 }]]) };
  const misses = {
    unknown:  [{ store: 'Shop A', machines: 2 }],
    unlinked: [{ store: 'Shop B', machines: 1, fileBrand: 'Glow' }],
    conflicts: [{ store: 'Shop C', machines: 3, fileBrand: 'Glow', registryContractId: 'c1' }],
  };
  const diff = {
    added:   [{ name: 'New One', vals: { Type: 'Retail' } }],
    changed: [{ name: 'Changed One', diffs: [{ field: 'Branch', from: '', to: '3' }] }],
    missing: [{ contractId: 'c9', merchantName: 'Gone One', branchCount: 2 }],
    unchanged: 5,
  };
  const html = uploadTableHtml(diff, misses, machines);
  for (const must of ['New One', 'Changed One', 'Gone One', 'Shop A', 'Shop B', 'Shop C',
                      'S8 ×2', 'S5 ×1', 'Add to list', 'Update to the list', 'Archive', 'Delete']) {
    assert.ok(html.includes(must), `the table must render ${must}`);
  }
  assert.ok(html.includes('Old Brand'), 'a moved shop names the merchant it is leaving');
});

test('it renders with no machine list at all', () => {
  const uploadTableHtml = runTable();
  const html = uploadTableHtml({ added: [], changed: [], missing: [], unchanged: 0 }, null, null);
  assert.match(html, /Nothing differs/);
});

test('a miss with no machine detail still renders', () => {
  const uploadTableHtml = runTable();
  const html = uploadTableHtml(null, { unknown: [{ store: 'Bare', machines: 0 }] }, null);
  assert.ok(html.includes('Bare'));
  assert.ok(html.includes('0 machines'));
});

// ── The registry outlives the contracts it points at (2026-09-29) ──────────────────────────
// Live data: 73 registry rows point at a DELETED contract and 103 at an archived one — deleting
// a merchant never cleans up the shop rows that referenced it. And a store name routinely has
// several registry rows (§1c), so "the first row with a contractId" could be a dangling pointer
// while its live siblings were ignored.
//
// That is what made 'มี่เสวี่ย … เอเชียทีค' look like it had moved away from Mixue: of its three
// registry rows, one pointed at a deleted contract and two said Mixue, the same as the file.
const runMatcher = () => new Function('return ' + grab('matchMachineStores'))();

const REG = [
  { name: 'Mixue Asiatique', contractId: 'gone' },     // first, and dangling
  { name: 'Mixue Asiatique', contractId: 'mixue' },
  { name: 'Mixue Asiatique', contractId: 'mixue' },
];
const CONS = [{ contractId: 'mixue', merchantName: 'Mixue' },
              { contractId: 'old', merchantName: 'Old Brand' },
              { contractId: 'dead', merchantName: 'Archived Brand', archived: true }];
const ROSTER = { merchants: [{ name: 'Mixue Asiatique', partnerName: 'Mixue' }] };
const STORES = new Map([['Mixue Asiatique', { S5: 1 }]]);

test('a live registry row wins over a dangling sibling', () => {
  const m = runMatcher()(STORES, REG, null, CONS);
  assert.equal(m.totals.get('mixue')?.S5, 1, 'the shop resolves to the live contract');
  assert.equal(m.conflicts.length, 0);
});

test('file and registry agreeing is not reported as a move', () => {
  const m = runMatcher()(STORES, REG, ROSTER, CONS);
  assert.equal(m.conflicts.length, 0, 'both say Mixue — there is nothing to report');
  assert.equal(m.totals.get('mixue')?.S5, 1);
});

test('a conflict needs BOTH sides to name a merchant that still exists', () => {
  // Registry says a DELETED contract, file says Mixue: a stale link, not a disagreement.
  const m = runMatcher()(STORES, [{ name: 'Mixue Asiatique', contractId: 'gone' }], ROSTER, CONS);
  assert.equal(m.conflicts.length, 0);
  assert.equal(m.totals.get('mixue')?.S5, 1, 'and the file still places it');

  // Registry says an ARCHIVED contract: same treatment.
  const a = runMatcher()(STORES, [{ name: 'Mixue Asiatique', contractId: 'dead' }], ROSTER, CONS);
  assert.equal(a.conflicts.length, 0);

  // Registry says a DIFFERENT LIVE merchant: that IS a move, and is reported.
  const real = runMatcher()(STORES, [{ name: 'Mixue Asiatique', contractId: 'old' }], ROSTER, CONS);
  assert.equal(real.conflicts.length, 1);
  assert.equal(real.conflicts[0].registryContractId, 'old');
  assert.equal(real.conflicts[0].fileBrand, 'Mixue');
  assert.equal(real.totals.get('mixue')?.S5, 1, 'the file still wins');
});

test('with no file, a dangling-only shop is still unplaced rather than wrongly placed', () => {
  const m = runMatcher()(STORES, [{ name: 'Mixue Asiatique', contractId: 'gone' }], null, CONS);
  assert.equal(m.totals.size, 0);
  assert.equal(m.unlinked.length + m.unknown.length, 1);
});

// ── Step 1: the two files are joined to each other (2026-09-29) ────────────────────────────
// The user's pipeline, stated plainly: "map two files for merchant and machine information, and
// then come up with a merchant information set to map with registry, and for those unmapped
// between two file, you also highlight".
//
// The join had been happening implicitly inside the registry matcher, which meant the gap BETWEEN
// the two files — a shop in one and not the other — was invisible. Machines whose store the
// merchant file never names cannot be attributed to anybody.
const joinFiles = () => new Function('return ' + grab('joinUploadFiles'))();

const ROSTER2 = { merchants: [
  { name: 'Shop A', partnerName: 'Alpha' },
  { name: 'Shop B', partnerName: 'Alpha' },
  { name: 'Shop C', partnerName: 'Beta'  },
] };
const MACH2 = { byStore: new Map([
  ['Shop A', { S5: 2 }],
  ['Shop C', { S8: 1, S5: 1 }],
  ['Shop Z', { S5: 3 }],            // machines, but the merchant file never names it
]) };

test('the join makes one merchant-information set from the two files', () => {
  const j = joinFiles()(ROSTER2, MACH2);
  assert.equal(j.stores.size, 3, 'every shop the merchant file names');
  assert.equal(j.brands.size, 2, 'folded to brands');
  assert.deepEqual(j.brands.get('alpha'), { brand: 'Alpha', stores: 2, machines: 2, counts: { S5: 2 } });
  assert.deepEqual(j.brands.get('beta'),  { brand: 'Beta',  stores: 1, machines: 2, counts: { S8: 1, S5: 1 } });
});

test('a shop with machines and no brand is highlighted, not swallowed', () => {
  const j = joinFiles()(ROSTER2, MACH2);
  assert.deepEqual(j.onlyInMachineFile.map(x => x.store), ['Shop Z']);
  assert.equal(j.onlyInMachineFile[0].machines, 3);
});

test('a shop with a brand and no machines is highlighted too', () => {
  const j = joinFiles()(ROSTER2, MACH2);
  assert.deepEqual(j.onlyInMerchantFile.map(x => x.store), ['Shop B']);
  assert.equal(j.stores.get('shop b').machines, 0, 'it still belongs to the set, with zero');
});

test('matching ignores case and surrounding space', () => {
  const j = joinFiles()({ merchants: [{ name: '  shop a ', partnerName: 'Alpha' }] },
                        { byStore: new Map([['SHOP A', { S5: 1 }]]) });
  assert.equal(j.onlyInMachineFile.length, 0);
  assert.equal(j.onlyInMerchantFile.length, 0);
  assert.equal(j.stores.get('shop a').machines, 1);
});

test('one file alone is not a join, and reports no gaps', () => {
  const j1 = joinFiles()(ROSTER2, null);
  assert.equal(j1.bothFiles, false);
  assert.equal(j1.stores.size, 3, 'the merchant file still makes a set');
  const j2 = joinFiles()(null, MACH2);
  assert.equal(j2.bothFiles, false);
  assert.equal(j2.stores.size, 0);
});

test('the gaps only appear on the page when both files are there', () => {
  const uploadTableHtml = runTable();
  const join = { bothFiles: false, onlyInMachineFile: [{ store: 'X', machines: 1 }],
                 onlyInMerchantFile: [{ store: 'Y', brand: 'B' }], notApproved: [] };
  const html = uploadTableHtml(null, null, { byStore: new Map() }, join);
  assert.ok(!html.includes('>X<') && !html.includes('>Y<'),
    'with one file there is nothing to join, so nothing is claimed');
});

test('the file-to-file gaps are the FIRST thing the table shows', () => {
  const groups = app.slice(app.indexOf('const UPLOAD_GROUPS'), app.indexOf('let UPLOAD_STATE'));
  const order = [...groups.matchAll(/key: '(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(order.slice(0, 4), ['noLabel', 'notAppr', 'noBrand', 'noMach'],
    'step 1 — the two files against each other — comes before everything that depends on it');
});

// ── Update with file data (2026-09-29) ─────────────────────────────────────────────────────
// The file already wins for this upload's machine counts. What it cannot do on its own is move
// the SHOP: the registry row still names the old merchant, so the Assign button, the next
// machine-list upload and anything else reading the registry keep following a link the file has
// already contradicted.
test('a moved shop offers Update with file data', () => {
  const fn = grab('uploadTableHtml');
  assert.match(fn, /up-mov-btn/);
  assert.match(fn, /Update with file data/);
  assert.match(fn, /data-brand="\$\{escape\(x\.fileBrand\)\}"/);
});

test('it writes contractId and nothing else', () => {
  // Scoped to the REQUEST, not the whole function — the comment above it names the fields that
  // are deliberately left alone, and grepping the body for those words tested the prose.
  const fn = grab('repointStoreFromFile');
  const bodies = [...fn.matchAll(/JSON\.stringify\(([^;]*?)\)\s*\}\)/g)].map(m => m[1]);
  assert.equal(bodies.length, 1, 'exactly one write');
  assert.equal(bodies[0].trim(), '{ contractId: target.contractId }');
});

// Leaving siblings pointing at the old merchant is exactly how a shop comes to answer two ways
// at once — the fault that made Mixue look like it had moved.
test('every registry row for that store moves, not just the first', () => {
  const fn = grab('repointStoreFromFile');
  assert.match(fn, /registry\.filter\(r => String\(r\.name \|\| ''\)\.toLowerCase\(\)\.trim\(\) === k\)/);
  assert.match(fn, /for \(const r of moving\)/);
  assert.match(fn, /rows\.filter\(r => r\.contractId !== target\.contractId\)/,
    'rows already pointing at the target are left alone');
});

test('it refuses rather than inventing a merchant that is not in the list', () => {
  const fn = grab('repointStoreFromFile');
  assert.match(fn, /There is no merchant called/);
  assert.match(fn, /Add it first/);
  assert.doesNotMatch(fn, /'\/contracts'/, 'it must never create a contract');
});

test('it confirms, names the count, and promises nothing about past runs', () => {
  const fn = grab('repointStoreFromFile');
  assert.match(fn, /store-registry row\(s\) change/);
  assert.match(fn, /no past run is altered/);
  assert.match(fn, /can\('manageMerchants'\)/);
});

test('a shop already pointing at the right merchant says so instead of writing', () => {
  const fn = grab('repointStoreFromFile');
  assert.ok(fn.indexOf('Already points there') < fn.indexOf("method: 'PUT'"),
    'the no-op case returns before any write');
});

// ── Every shop appears in exactly one bucket (2026-09-29) ──────────────────────────────────
// The first cut let a shop fall into two. "In your machine list, not in your merchant file" and
// "nothing can place" overlapped WITHOUT SAYING SO, and neither contained the other:
//   • a shop in neither file nor registry was in both buckets
//   • a shop absent from the merchant file but present in the registry was counted as a problem
//     while actually being placed
//   • a shop IN the merchant file under a brand the app does not carry was only in the second
// So the two counts could not be reconciled by reading them. The user asked directly whether one
// was a subset of the other; it was not.
test('a shop is reported once, not in two buckets', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['S1', { S5: 1 }], ['S2', { S5: 1 }], ['S3', { S5: 1 }]]) };
  const join = { bothFiles: true,
                 onlyInMachineFile: [{ store: 'S1', machines: 1 }, { store: 'S2', machines: 1 }],
                 onlyInMerchantFile: [] };
  const misses = { unknown: [{ store: 'S1', machines: 1 },
                             { store: 'S3', machines: 1, fileBrand: 'BrandX' }],
                   unlinked: [], conflicts: [] };
  const html = uploadTableHtml(null, misses, machines, join);

  // S1: the file-to-file gap is the one statement made about it.
  assert.equal((html.match(/>S1</g) || []).length, 1, 'S1 appears once');
  // S2: reported as a gap, but not described as unattributable — the index still placed it.
  assert.equal((html.match(/>S2</g) || []).length, 1);
  assert.match(html, /store index still knows it/);
  // S3: not a file-to-file gap at all — the file names it, the app lacks the merchant.
  assert.equal((html.match(/>S3</g) || []).length, 1);
  assert.match(html, /there is no merchant of that name/);
});

test('a placed shop is not told its machines belong to nobody', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['S2', { S5: 1 }]]) };
  const join = { bothFiles: true, onlyInMachineFile: [{ store: 'S2', machines: 1 }], onlyInMerchantFile: [] };
  const html = uploadTableHtml(null, { unknown: [], unlinked: [], conflicts: [] }, machines, join);
  assert.match(html, /its machines are counted/);
  assert.doesNotMatch(html, /counted toward nobody/);
});

test('a genuinely orphaned shop still says so', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['S1', { S5: 1 }]]) };
  const join = { bothFiles: true, onlyInMachineFile: [{ store: 'S1', machines: 1 }], onlyInMerchantFile: [] };
  const misses = { unknown: [{ store: 'S1', machines: 1 }], unlinked: [], conflicts: [] };
  const html = uploadTableHtml(null, misses, machines, join);
  assert.match(html, /counted toward\s*\n?\s*nobody this week/);
});

// ── One fact, one row (2026-09-29) ─────────────────────────────────────────────────────────
// The user: "if you say my file says it belongs to Yunomori, why you don't put in the 'add to'
// section, and the information you say in your app, i search it, and it has nothing".
//
// Both complaints were right. A brand the file names and the app lacks was ALREADY in "New
// merchants this file would add" — and its shops were being nagged about separately, so the same
// fact appeared twice with nothing linking them. And the left column said "In your app" while
// showing a row from the hidden shop index, which is not a merchant anyone can search for.
test('a brand being added is not also complained about shop by shop', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['Shop 1', { L20: 1 }]]) };
  const misses = { unknown: [{ store: 'Shop 1', machines: 1, fileBrand: 'Yunomori' }],
                   unlinked: [], conflicts: [] };
  const diff = { added: [{ name: 'Yunomori', vals: { Type: 'Wellness' } }],
                 changed: [], missing: [], unchanged: 0 };
  const join = { bothFiles: true, onlyInMachineFile: [], onlyInMerchantFile: [],
                 brands: new Map([['yunomori', { brand: 'Yunomori', stores: 3, machines: 3, counts: { L20: 3 } }]]) };
  const html = uploadTableHtml(diff, misses, machines, join);
  assert.equal((html.match(/Shop 1/g) || []).length, 0,
    'the shop is not listed separately — adding the merchant places it');
  assert.match(html, /Brings <strong>3 shops<\/strong> and 3 machines \(L20 ×3\)/,
    'the machines are stated on the row that adds the merchant');
});

test('the left column no longer claims a hidden index row is in your app', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['Orphan', { S5: 1 }]]) };
  const misses = { unknown: [], unlinked: [{ store: 'Orphan', machines: 1 }], conflicts: [] };
  const html = uploadTableHtml(null, misses, machines, null);
  assert.match(html, /Your merchant list<\/th>/, 'the header says what the column really holds');
  // The store name appears once — in the file column — not mirrored into the app column.
  assert.equal((html.match(/Orphan/g) || []).length, 1);
});

test('a brand with no machines still says so on its add row', () => {
  const uploadTableHtml = runTable();
  const diff = { added: [{ name: 'Quiet', vals: {} }], changed: [], missing: [], unchanged: 0 };
  const join = { bothFiles: true, onlyInMachineFile: [], onlyInMerchantFile: [],
                 brands: new Map([['quiet', { brand: 'Quiet', stores: 1, machines: 0, counts: {} }]]) };
  assert.match(uploadTableHtml(diff, null, null, join), /Brings <strong>1 shop<\/strong> and no machines/);
});

// ── NOTHING IS REPORTED TWICE (2026-09-29) ─────────────────────────────────────────────────
// The user, after finding three overlaps by eye: "I believe not just these three, do a check up,
// no nagging about the same thing".
//
// This is the standing guard. It populates EVERY bucket at once with the awkward cases found in
// the audit and asserts each real thing is named on exactly one row. A new bucket that overlaps
// an existing one fails here rather than in front of someone reading the screen.
const ALL_CASES = () => {
  const CONTRACTS = [
    { contractId: 'live', merchantName: 'Live Brand' },
    { contractId: 'arch', merchantName: 'Archived Brand', archived: true },
    { contractId: 'old',  merchantName: 'Old Owner' },
  ];
  const machines = { byStore: new Map([
    ['OnlyMachine', { S5: 1 }],     // machine file only
    ['ArchShop',    { S5: 1 }],     // file names a brand that exists but is archived
    ['CaseShop',    { S5: 1 }],     // same shop as the next, different capitals
    ['caseshop',    { S5: 1 }],
    ['MovedShop',   { S5: 1 }],     // file moves it to a live merchant
    ['AddedShop',   { S5: 1 }],     // belongs to a brand being added
  ]) };
  const join = { bothFiles: true,
    onlyInMachineFile: [{ store: 'OnlyMachine', machines: 1 }],
    onlyInMerchantFile: [{ store: 'QuietShop', brand: 'Brand New' },
                         { store: 'LiveQuiet', brand: 'Live Brand' }],
    brands: new Map([['brand new', { brand: 'Brand New', stores: 2, machines: 1, counts: { S5: 1 } }]]) };
  const misses = {
    unknown:  [{ store: 'ArchShop', machines: 1, fileBrand: 'Archived Brand' },
               { store: 'CaseShop', machines: 1 }, { store: 'caseshop', machines: 1 },
               { store: 'AddedShop', machines: 1, fileBrand: 'Brand New' }],
    unlinked: [],
    conflicts: [{ store: 'MovedShop', machines: 1, fileBrand: 'Live Brand', registryContractId: 'old' }],
  };
  const diff = {
    added:   [{ name: 'Brand New', vals: { Type: 'Retail' } }],
    changed: [{ name: 'Live Brand', diffs: [{ field: 'Phone', from: '', to: '02' }] }],
    missing: [{ contractId: 'x', merchantName: 'Dropped Brand', branchCount: 1 }],
    unchanged: 3,
  };
  return { CONTRACTS, machines, join, misses, diff };
};

const fileCells = (html) =>
  [...html.matchAll(/<td class="rc-c-file">(.*?)<\/td>/gs)].map(m => m[1].replace(/<[^>]+>/g, '').trim());

test('no shop is named on more than one row', () => {
  const { CONTRACTS, machines, join, misses, diff } = ALL_CASES();
  const html = runTableWith(CONTRACTS)(diff, misses, machines, join);
  const cells = fileCells(html).filter(Boolean).map(c => c.toLowerCase());
  const dupes = cells.filter((c, i) => cells.indexOf(c) !== i);
  assert.deepEqual(dupes, [], `these appear more than once: ${dupes.join(', ')}`);
});

test('a brand being added is never also complained about elsewhere', () => {
  const { CONTRACTS, machines, join, misses, diff } = ALL_CASES();
  const html = runTableWith(CONTRACTS)(diff, misses, machines, join);
  const cells = fileCells(html).map(c => c.toLowerCase());
  assert.equal(cells.filter(c => c === 'brand new').length, 1, 'one row for the brand');
  assert.ok(!cells.includes('addedshop'), 'its shop is not listed separately');
  assert.ok(!cells.includes('quietshop'), 'nor nagged for having no machines');
});

test('a shop spelled with different capitals is one shop', () => {
  const { CONTRACTS, machines, join, misses, diff } = ALL_CASES();
  const cells = fileCells(runTableWith(CONTRACTS)(diff, misses, machines, join)).map(c => c.toLowerCase());
  assert.equal(cells.filter(c => c === 'caseshop').length, 1);
});

test('an ARCHIVED merchant is not reported as missing from your list', () => {
  const { CONTRACTS, machines, join, misses, diff } = ALL_CASES();
  const html = runTableWith(CONTRACTS)(diff, misses, machines, join);
  assert.match(html, /is <strong>archived<\/strong>/);
  assert.match(html, /Unarchive it from the Archived screen/);
  // And it must not ALSO claim no such merchant exists.
  const row = html.slice(html.indexOf('ArchShop'));
  assert.doesNotMatch(row.slice(0, 600), /there is no merchant of that name/);
});

test('a shop the file still lists is not reported as having no machines', () => {
  // LiveQuiet belongs to Live Brand, which exists and is only being UPDATED — that is a real
  // finding and stays.
  const { CONTRACTS, machines, join, misses, diff } = ALL_CASES();
  const cells = fileCells(runTableWith(CONTRACTS)(diff, misses, machines, join)).map(c => c.toLowerCase());
  assert.ok(cells.includes('livequiet'), 'a live brand\'s machineless shop is still worth saying');
});

// ── Filtering, and rows that leave when you are done (2026-09-29) ──────────────────────────
// "I also want to filter by brand name, and when I finish an update, it will be removed from
// the table."
test('the table can be filtered by merchant or shop name', () => {
  const uploadTableHtml = runTable();
  const diff = { added: [{ name: 'Alpha Cafe', vals: {} }, { name: 'Beta Bar', vals: {} }],
                 changed: [], missing: [], unchanged: 0 };
  const all = uploadTableHtml(diff, null, null, null, '');
  assert.ok(all.includes('Alpha Cafe') && all.includes('Beta Bar'));

  const some = uploadTableHtml(diff, null, null, null, 'alpha');
  assert.ok(some.includes('Alpha Cafe'));
  assert.ok(!some.includes('Beta Bar'));
  assert.match(some, /1 of 2 merchants/, 'the count says it is filtered');
});

test('filtering matches either column, and is case-insensitive', () => {
  const uploadTableHtml = runTable();
  const misses = { unknown: [{ store: 'Sukhumvit Shop', machines: 1 }], unlinked: [], conflicts: [] };
  const machines = { byStore: new Map([['Sukhumvit Shop', { S5: 1 }]]) };
  assert.ok(uploadTableHtml(null, misses, machines, null, 'SUKHUM').includes('Sukhumvit Shop'));
  assert.ok(!uploadTableHtml(null, misses, machines, null, 'silom').includes('Sukhumvit Shop'));
});

test('a filter that matches nothing says so, differently from nothing differing', () => {
  const uploadTableHtml = runTable();
  const diff = { added: [{ name: 'Alpha', vals: {} }], changed: [], missing: [], unchanged: 0 };
  assert.match(uploadTableHtml(diff, null, null, null, 'zzz'), /Nothing left matching/);
  assert.match(uploadTableHtml({ added: [], changed: [], missing: [], unchanged: 0 }, null, null, null, ''),
    /Nothing differs/);
});

// The row leaves because the DIFFERENCES ARE RECOMPUTED, not because it is hidden: once the
// merchant exists it is no longer new, so it cannot be listed as new. Marking rows done and
// leaving them meant the counts above them slowly stopped meaning anything.
test('a handled row is recomputed away, not annotated', () => {
  const fn = grab('refreshUploadTable');
  assert.match(fn, /diffWeeklyRows\(parsed, CONTRACTS\)/);
  assert.match(fn, /matchMachineStores\(machines\.byStore, await loadRegistry\(\), roster, CONTRACTS\)/);
  assert.match(fn, /joinUploadFiles\(roster, machines\)/);
  assert.match(fn, /up-filter'\)\?\.value/, 'and the filter survives the redraw');
});

test('every row action refreshes instead of marking its own button', () => {
  for (const n of ['openAddFromFile', 'updateFromFile', 'archiveFromUpload',
                   'deleteFromUpload', 'repointStoreFromFile']) {
    assert.match(grab(n), /await refreshUploadTable\(/, `${n} must refresh`);
    assert.ok(!/outerHTML = '<span class="up-added">/.test(grab(n)),
      `${n} must not annotate a button instead`);
  }
});

test('repointing drops the registry cache it just invalidated', () => {
  assert.match(grab('repointStoreFromFile'), /REGISTRY_CACHE = null;/);
});

// ── Near-duplicate merchants (2026-09-29) ──────────────────────────────────────────────────
// Live case: the file offered "EBISU Shoten Silom" as a NEW merchant while "EBISU SHOTEN" was
// already in the list, live, with an entity. `diffWeeklyRows` matches on the exact name, so a
// branch suffix reads as a different merchant — and adding it would have produced two merchants
// for one shop with the terms on only one of them. Reconcile's classifier caught this class;
// taking that screen off the nav lost it, so the check belongs here.
const runSimilar = (contracts) => new Function('CONTRACTS',
  grab('similarity') + '\n'
  + app.slice(app.indexOf('function reconcileKey'), app.indexOf('\n}', app.indexOf('function reconcileKey')) + 2)
  + '\n' + grab('similarExistingMerchants') + '\nreturn similarExistingMerchants;')(contracts);

const LIST = [
  { contractId: 'a', merchantName: 'EBISU SHOTEN', entityId: 'ent1' },
  { contractId: 'b', merchantName: 'Totally Different Cafe' },
  { contractId: 'c', merchantName: 'Old Ebisu', archived: true },
];

test('a branch-suffixed name finds the merchant it belongs to', () => {
  const hits = runSimilar(LIST)('EBISU Shoten Silom');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].contract.merchantName, 'EBISU SHOTEN');
});

test('an archived merchant is not offered as the match', () => {
  assert.deepEqual(runSimilar(LIST)('Old Ebisu Branch').map(h => h.contract.merchantName), []);
});

test('an unrelated name matches nothing', () => {
  assert.deepEqual(runSimilar(LIST)('Somchai Noodles').map(h => h.contract.merchantName), []);
});

test('an exact match is not reported — that is an update, not a duplicate', () => {
  assert.deepEqual(runSimilar(LIST)('ebisu shoten').map(h => h.contract.merchantName), []);
});

test('the row warns before the dialog is even opened', () => {
  const fn = grab('uploadAddedWhy');
  assert.match(fn, /similarExistingMerchants\(a\.name\)/);
  assert.match(fn, /Your list already has/);
});

test('the dialog warns where the second merchant would be created', () => {
  const fn = grab('openAddFromFile');
  assert.match(fn, /close this and update that one instead/);
  assert.match(fn, /creates a second merchant/);
  assert.match(fn, /entityPickerHtml\('af-entity', suggestedEntity\)/,
    "and offers the existing merchant's entity rather than a blank");
});

test('nothing is auto-applied — it is a question, not an answer', () => {
  const fn = grab('similarExistingMerchants');
  assert.match(fn, /slice\(0, 3\)/, 'at most a few candidates');
  assert.ok(!/api\(/.test(fn), 'and it writes nothing');
});

// ── In the file, but not Approved (2026-09-29) ─────────────────────────────────────────────
// Live case: "Kliff Beach Bistro & Bar" was in the merchant file and the page said the file did
// not list it. `parseMerchantList` keeps APPROVED rows only — correct for a payout — and the
// join only ever saw those, so a shop held back by its review state was indistinguishable from
// one nobody had ever heard of. They need different fixes: approve it on the platform, versus
// add it to your file.
test('a shop held back by its review state is not called absent from the file', () => {
  const j = joinFiles()(
    { merchants: [], excluded: [{ name: 'Kliff Beach', label: 'Kliff', reviewState: 'Disapproved' }] },
    { byStore: new Map([['Kliff Beach', { S8: 1 }]]) });
  assert.deepEqual(j.onlyInMachineFile, [], 'not reported as missing from the file');
  assert.equal(j.notApproved.length, 1);
  assert.equal(j.notApproved[0].brand, 'Kliff');
  assert.equal(j.notApproved[0].reviewState, 'Disapproved');
});

test('an Approved row still wins over a held-back one of the same name', () => {
  const j = joinFiles()(
    { merchants: [{ name: 'Shop', partnerName: 'Brand' }],
      excluded: [{ name: 'Shop', label: 'Brand', reviewState: 'Pending' }] },
    { byStore: new Map([['Shop', { S5: 1 }]]) });
  assert.deepEqual(j.notApproved, []);
  assert.equal(j.stores.get('shop').machines, 1);
});

test('a file of ONLY held-back rows still counts as a join', () => {
  const j = joinFiles()(
    { merchants: [], excluded: [{ name: 'A', label: 'B', reviewState: 'Pending' }] },
    { byStore: new Map([['A', { S5: 1 }]]) });
  assert.equal(j.bothFiles, true, 'otherwise the page would say nothing at all');
});

test('the row says the file lists it, and what to do', () => {
  const uploadTableHtml = runTable();
  const html = uploadTableHtml(null, null,
    { byStore: new Map([['Kliff Beach', { S8: 1 }]]) },
    { bothFiles: true, onlyInMachineFile: [], onlyInMerchantFile: [],
      notApproved: [{ store: 'Kliff Beach', machines: 1, brand: 'Kliff', reviewState: 'Disapproved' }] });
  assert.match(html, /DOES list this shop/);
  assert.match(html, /review state is <strong>Disapproved<\/strong>/);
  assert.match(html, /Approve it on the platform/);
  assert.ok(!html.includes('does not\nlist this shop'));
});

test('it is not also reported by the placement buckets', () => {
  const uploadTableHtml = runTable();
  const machines = { byStore: new Map([['Kliff Beach', { S8: 1 }]]) };
  const join = { bothFiles: true, onlyInMachineFile: [], onlyInMerchantFile: [],
                 notApproved: [{ store: 'Kliff Beach', machines: 1, brand: 'Kliff', reviewState: 'Pending' }] };
  const misses = { unknown: [{ store: 'Kliff Beach', machines: 1 }], unlinked: [], conflicts: [] };
  const html = uploadTableHtml(null, misses, machines, join);
  assert.equal((html.match(/Kliff Beach/g) || []).length, 1, 'exactly one row');
});

// ── The two files name the store in DIFFERENT COLUMNS (2026-09-29) ─────────────────────────
// merchant list → 'merchant name.'   ·   machine list → 'Business name'
// Two exports, two strings for one shop. Joining them on an exact match and then telling someone
// "your merchant file does not list this shop" is wrong when the file lists it under a slightly
// different spelling. I asserted a review-state cause for this without evidence and was wrong;
// these are the two causes that actually exist in the code.
test('a blank Merchant label no longer reads as absent from the file', () => {
  const j = joinFiles()(
    { merchants: [{ name: 'Kliff Beach', partnerName: '' }], excluded: [] },
    { byStore: new Map([['Kliff Beach', { S8: 1 }]]) });
  assert.deepEqual(j.onlyInMachineFile, [], 'the file DOES list it');
  assert.equal(j.noLabelShops.length, 1);
  assert.equal(j.noLabelShops[0].store, 'Kliff Beach');
});

test('the row says the label is blank, and where to fix it', () => {
  const uploadTableHtml = runTable();
  const html = uploadTableHtml(null, null, { byStore: new Map([['Kliff Beach', { S8: 1 }]]) },
    { bothFiles: true, onlyInMachineFile: [], onlyInMerchantFile: [], notApproved: [],
      noLabelShops: [{ store: 'Kliff Beach', machines: 1 }], fileStoreNames: ['Kliff Beach'] });
  assert.match(html, /<strong>Merchant label<\/strong> is blank/);
  assert.match(html, /Fill it in on the platform/);
  assert.ok(!html.includes('does not list this shop'));
});

test('a near-miss spelling names what the file actually has', () => {
  const uploadTableHtml = runTable();
  const join = { bothFiles: true, onlyInMerchantFile: [], notApproved: [], noLabelShops: [],
                 onlyInMachineFile: [{ store: 'Kliff Beach Bistro & Bar', machines: 1 }],
                 fileStoreNames: ['Kliff Beach Bistro and Bar'] };
  const html = uploadTableHtml(null, { unknown: [{ store: 'Kliff Beach Bistro & Bar', machines: 1 }],
                                       unlinked: [], conflicts: [] },
    { byStore: new Map([['Kliff Beach Bistro & Bar', { S8: 1 }]]) }, join);
  assert.match(html, /Kliff Beach Bistro and Bar<\/strong>, which is close/);
  assert.match(html, /name the store in different/);
});

test('a genuinely absent shop still says so plainly', () => {
  const uploadTableHtml = runTable();
  const join = { bothFiles: true, onlyInMerchantFile: [], notApproved: [], noLabelShops: [],
                 onlyInMachineFile: [{ store: 'Totally Unrelated Venue', machines: 1 }],
                 fileStoreNames: ['Kliff Beach Bistro and Bar'] };
  const html = uploadTableHtml(null, { unknown: [{ store: 'Totally Unrelated Venue', machines: 1 }],
                                       unlinked: [], conflicts: [] },
    { byStore: new Map([['Totally Unrelated Venue', { S8: 1 }]]) }, join);
  assert.match(html, /does not list this shop/);
});

test('closestFileStore does not reach for a bad match', () => {
  const fn = new Function(grab('similarity') + '\n'
    + app.slice(app.indexOf('function reconcileKey'),
                app.indexOf('\n}', app.indexOf('function reconcileKey')) + 2)
    + '\n' + grab('closestFileStore') + '\nreturn closestFileStore;')();
  assert.equal(fn('Kliff Beach Bistro & Bar', { fileStoreNames: ['Kliff Beach Bistro and Bar'] }),
    'Kliff Beach Bistro and Bar');
  assert.equal(fn('Kliff Beach', { fileStoreNames: ['Somchai Noodle House'] }), null);
  assert.equal(fn('Anything', { fileStoreNames: [] }), null);
});

test('a shop with no label is reported once, not also as unplaceable', () => {
  const uploadTableHtml = runTable();
  const join = { bothFiles: true, onlyInMachineFile: [], onlyInMerchantFile: [], notApproved: [],
                 noLabelShops: [{ store: 'Kliff Beach', machines: 1 }], fileStoreNames: ['Kliff Beach'] };
  const misses = { unknown: [{ store: 'Kliff Beach', machines: 1 }], unlinked: [], conflicts: [] };
  const html = uploadTableHtml(null, misses, { byStore: new Map([['Kliff Beach', { S8: 1 }]]) }, join);
  assert.equal((html.match(/Kliff Beach/g) || []).length, 1);
});
