import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registryCheck } from '../code/routes/contracts.mjs';
import { normalizeContractRow } from '../code/contracts.mjs';

// ── The seams between A, B and C (2026-10-01) ────────────────────────────────────────────────
// Each of these is a defect found by walking the spec end to end rather than feature by feature.
// They have nothing in common except their shape: two halves of one flow, each correct alone.
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing function ' + n);
  let d = 0, k = app.indexOf('(', i);
  for (; k < app.length; k++) { if (app[k] === '(') d++; else if (app[k] === ')') { d--; if (!d) break; } }
  for (let j = app.indexOf('{', k), b = 0; j < app.length; j++) {
    if (app[j] === '{') b++; else if (app[j] === '}') { b--; if (!b) return app.slice(i, j + 1); }
  }
  throw new Error('unterminated ' + n);
};
const constTo = (n, end) => {
  const i = app.indexOf(`const ${n} =`);
  return app.slice(i, app.indexOf(end, i) + end.length);
};

// ── A→B: an archived brand is REGISTERED ────────────────────────────────────────────────────
// Three brands in the 1 Oct file already existed, archived — and `Bossotel` carried its terms.
// "Add to list" on one of those makes a second brand of the same name with no terms and leaves
// the negotiated ones where no run can reach them. That is how `Central` was paid zero on
// 51,495 THB (§reconcile). The row has to say which it is.
const fm = new Function(
  constTo('INCOMPLETE_FIELDS', '};') + grab('ruleHasValue') + grab('percentCoversAll')
  + grab('percentModelsOf') + grab('isInternalName') + grab('termModelsOf')
  + 'const entityName = c => String(c.counterParty || "");'
  + grab('fileMismatches') + 'return fileMismatches;')();

const gp = p => ({ type: 'percent', rows: [{ model: 'ALL', percent: p }], _t: 'gp' });
const FILE = {
  'bossotel':   { label: 'Bossotel',   branches: 1, units: { S8: 1 } },
  'brand new':  { label: 'Brand New',  branches: 2, units: { S8: 2 } },
  'no terms co':{ label: 'No Terms Co', branches: 1, units: {} },
};
const CONTRACTS = [
  { contractId: 'boss', merchantName: 'Bossotel', archived: true, archivedAt: '2026-09-30T10:34:52Z',
    rule: gp(25), aggregationMode: 'whole', noPayout: true },
  { contractId: 'nt', merchantName: 'No Terms Co', archived: true, rule: null },
];

test('an archived brand the file still carries is not called unregistered', () => {
  const { noContract } = fm(CONTRACTS, FILE);
  const boss = noContract.find(r => r.label === 'Bossotel');
  assert.ok(boss, 'it is still reported — the file carries it and no live brand answers for it');
  assert.equal(boss.archivedContract.contractId, 'boss', 'and the archived brand is named');
  assert.equal(boss.archivedHasTerms, true, 'carrying terms is THE reason not to re-add it');

  const nt = noContract.find(r => r.label === 'No Terms Co');
  assert.equal(nt.archivedContract.contractId, 'nt');
  assert.equal(nt.archivedHasTerms, false, 'an archived brand with no rule says so');

  const fresh = noContract.find(r => r.label === 'Brand New');
  assert.equal(fresh.archivedContract, null, 'a genuinely new brand has nothing behind it');
});

test('the tab offers Unarchive for those, and Add only for a new brand', () => {
  const i = app.indexOf("} else if (tab === 'noContract') {");
  const block = app.slice(i, app.indexOf("} else if (tab === 'notInFile')", i));
  assert.match(block, /act\('Unarchive', 'unarchive', a\.contractId\)/);
  assert.match(block, /act\('Add to list', 'add', r\.label\)/);
  assert.match(strip(block), /already registered — archived/, 'and says so in a State column');
  assert.match(strip(block), /has terms/);
});

test('the Unarchive button has a handler, and it says what comes back', () => {
  const i = app.indexOf("box.querySelectorAll('.up-fix')");
  assert.match(app.slice(i, app.indexOf('\n  }));', i)), /kind === 'unarchive'/);
  const fn = grab('unarchiveFromUpload');
  assert.match(fn, /archived: false/);
  assert.match(fn, /ruleHasValue\(c\.rule\)/, 'whether terms come back is the whole question');
  assert.match(strip(fn), /no revenue share/, 'and a noPayout flag would still stop it being paid');
  assert.match(fn, /can\('manageMerchants'\)/);
});

// ── A: the footer must not attribute a merchant to a fix that would not help it ──────────────
// Rule A2: only an APPROVED merchant with a DEPLOYED machine belongs in the registry. The brand
// test used to run first, so a merchant that is simply not Approved was counted as "waiting on a
// brand fix" and the footer sent you to two tabs that could not account for it — 1,612 reported
// against an honest 3 on the 1 Oct file.
const DOC = {
  merchants: [
    { name: 'Eligible, brand missing', partnerName: 'Nowhere Brand', model: 'S8' },
    { name: 'Eligible, brand there',   partnerName: 'Known Brand',   model: 'S8' },
  ],
  excluded: [
    { name: 'Pending, brand missing', label: 'Nowhere Brand', reviewState: 'Pending' },
    { name: 'Pending, brand there',   label: 'Known Brand',   reviewState: 'Pending' },
  ],
  machines: [
    { store: 'Eligible, brand missing', deployed: 1, counts: { S8: 1 } },
    { store: 'Eligible, brand there',   deployed: 1, counts: { S8: 1 } },
    { store: 'Pending, brand missing',  deployed: 1, counts: { S8: 1 } },
    { store: 'Pending, brand there',    deployed: 1, counts: { S8: 1 } },
  ],
};
test('a merchant that is not Approved is counted as ineligible, not as waiting on a brand', () => {
  const { counts } = registryCheck(DOC, [], [{ contractId: 'k', merchantName: 'Known Brand' }]);
  assert.equal(counts.notEligible, 2, 'both Pending merchants, whatever their brand');
  assert.equal(counts.missingNoMerchant, 1, 'only the eligible one whose brand is unregistered');
  assert.equal(counts.missing, 1, 'and the one that can actually be added');
});

test('eligibility is tested before the brand, in that order', () => {
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('if (!list) {');
  const block = strip(src.slice(i, src.indexOf('continue;\n    }', i)));
  assert.ok(block.indexOf('qualifies(f)') < block.indexOf('if (!want)'),
    'the brand tabs must only be blamed for a merchant a brand fix would actually release');
});

// ── C: every total in an entity letter is the entity's ──────────────────────────────────────
// One entity can hold eight brands. `{{payout}}` was already the group's; `{{revenue}}` and
// `{{sharePct}}` were still the FIRST brand's, so a letter could state the entity's payout
// against one brand's revenue. Same shape as the statement bug of 2026-10-01.
test('the entity letter recomputes revenue and share, not only payout', () => {
  // The vars moved into mailVarsForGroup — one definition, used by both senders.
  const fn = grab('mailVarsForGroup');
  const vars = fn;
  for (const k of ['revenue', 'sharePct', 'payout']) {
    assert.match(vars, new RegExp(`\\b${k}:`), `${k} must be the group's, not results[0]'s`);
  }
  assert.match(fn, /group\.results\.reduce\(\(a, r\) => a \+ \(Number\(r\.revenue\) \|\| 0\), 0\)/);
  assert.match(grab('mailSendDialog'), /const vars = mailVarsForGroup\(group, run\)/,
    'and the dialog reads that one definition rather than its own copy');
  assert.match(vars, /group\.payout \/ groupRevenue/, 'and the percentage divides the two group figures');
});

// ── The near-miss: a displayed label that is also a wire key ─────────────────────────────────
// `WEEKLY_FIELD_KEY` is keyed by the field name the diff preview PRINTS, and the weekly batch
// posts that same name as a header the backend resolves through `GRID_FIELDS`. Renaming the
// display alone leaves the row visible in the preview and silently unwritten.
test('every header the weekly batch posts is one the backend importer resolves', () => {
  const i = app.indexOf('const fields = [...parsed.fields,');
  const extra = app.slice(i, app.indexOf(']', i)).match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.ok(extra.length, 'the synthetic column(s) appended to the posted header');
  for (const name of extra) {
    // One row, that column only: the importer has to come back with a value for it.
    const header = ['Merchant/Brand', name];
    const row = normalizeContractRow(['A Brand', 7], header, ['Merchant', 'Merchant']);
    assert.equal(row.branchCount, 7,
      `the backend does not know the header "${name}" — the count would be dropped in silence`);
  }
});

test('and the diff preview names the same column the apply path looks up', () => {
  const key = constTo('WEEKLY_FIELD_KEY', '};');
  const reported = [...app.matchAll(/diffs\.push\(\{ field: '([^']+)'/g)].map(m => m[1]);
  assert.ok(reported.length);
  for (const f of reported) assert.ok(key.includes(`'${f}'`), `${f} is reported but never resolved`);
});

// ── C5: the recovery is computed, stored AND shown ──────────────────────────────────────────
// `recoverDepartedMerchants` reads earlier uploads so a merchant the latest file has dropped
// still gets its revenue to its brand, and the run stores what it found in
// `recoveredFromArchive`. For three weeks nothing read that field — so the one question it
// answers, "my file has no such merchant, where is this row from", went unanswered on screen.
test('the run detail reads recoveredFromArchive, not just the run that writes it', () => {
  const back = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
  assert.match(back, /bulkRun\.recoveredFromArchive = recovered\.map/, 'the run records it');
  assert.ok(app.includes('run.recoveredFromArchive'), 'and the run detail reads it');
  const i = app.indexOf('const recoveredNote =');
  const note = app.slice(i, app.indexOf('`;', app.indexOf('</p>`', i)));
  assert.match(note, /no longer in your latest file/, 'it says what it means');
  assert.match(note, /escape\(r\.name\)/, 'and names them');
  assert.match(note, /escape\(r\.brand\)/, 'with the brand the revenue went to');
});

test('a run with nothing recovered says nothing', () => {
  const i = app.indexOf('const recoveredNote =');
  assert.match(app.slice(i, i + 80), /!recovered\.length \? '' :/);
});

// ── A run never reads a review state (2026-10-02) ────────────────────────────────────────────
// "For registry: yes, always approved merchant with deployed machine binding. For run share:
// ALWAYS READ ONLY ORDER LIST FOR THE RENTAL MERCHANT COLUMN, and you do mapping with the brands
// to apply the rule."
import { expandRunRoster, deadRosterModels } from '../code/routes/bulk-runs.mjs';

const RUNFILE = {
  // The Approved half: what the run used to read, and the only thing it read.
  merchants: [
    { name: 'Approved A', nameLower: 'approved a', partnerName: 'Big Brand', model: 'S8', externalId: '1' },
    { name: 'Approved B', nameLower: 'approved b', partnerName: 'Big Brand', model: 'S5', externalId: '2' },
  ],
  // The held-back half. THE ONLY PLACE a non-Approved merchant's Merchant label is recorded.
  excluded: [
    { name: 'Disapproved C', label: 'Big Brand', reviewState: 'Disapproved' },
    { name: 'Pending D',     label: 'Big Brand', reviewState: 'Pending' },
    { name: 'No label E',    label: '',          reviewState: 'Pending' },
  ],
  machines: [
    { store: 'Approved A',    deployed: 1, counts: { S8: 4 }, businessId: '1' },
    { store: 'Disapproved C', deployed: 1, counts: { S8: 1 }, businessId: '3' },
    { store: 'Pending D',     deployed: 0, counts: { S8: 1 }, businessId: '4' },
    { store: 'No label E',    deployed: 1, counts: { S8: 1 }, businessId: '5' },
  ],
  orders: [{ merchantName: 'Pending D', netAmount: 100 }],
};

test('a merchant with a machine deployed is in the run whatever its review state', () => {
  const { roster, addedByMachine } = expandRunRoster(RUNFILE);
  const names = roster.map(r => r.name);
  assert.ok(names.includes('Disapproved C'), 'Disapproved, machine live — it earns, so it is paid');
  assert.equal(addedByMachine.length, 1);
  assert.equal(addedByMachine[0].brand, 'Big Brand', 'mapped through the held-back half of the file');
});

test('a merchant the orders name is in the run even with no machine on file', () => {
  const { roster, addedByOrder } = expandRunRoster(RUNFILE);
  assert.ok(roster.some(r => r.name === 'Pending D'), 'the revenue proves the machine was there');
  assert.deepEqual(addedByOrder.map(a => a.name), ['Pending D']);
});

test('a merchant with no Merchant label anywhere is NOT invented a brand', () => {
  const { roster } = expandRunRoster(RUNFILE);
  assert.ok(!roster.some(r => r.name === 'No label E'),
    'nothing in the file says which brand to pay — it stays unmatched and is reported');
});

test('a bound but UNDEPLOYED machine adds nothing', () => {
  const only = { ...RUNFILE, orders: [] };
  const { roster } = expandRunRoster(only);
  assert.ok(!roster.some(r => r.name === 'Pending D'),
    'deployed is the test — a machine that is not out there earns no fee');
});

test('a STATION, not a cabinet: four S8 cabinets at one merchant is ONE row', () => {
  // §1h. The Approved half counts stations; counting the machine file's cabinets here would pay
  // one merchant four placements while the merchant beside it gets one.
  const { roster } = expandRunRoster(RUNFILE);
  assert.equal(roster.filter(r => r.name === 'Approved A').length, 1);
  assert.equal(roster.filter(r => r.name === 'Disapproved C').length, 1);
});

test('the Approved rows are passed through untouched', () => {
  const { roster } = expandRunRoster(RUNFILE);
  for (const m of RUNFILE.merchants) {
    assert.ok(roster.includes(m), `${m.name} must be the very same object the file gave`);
  }
});

test('the orders are NOT the only input — a silent station keeps its fee', () => {
  // The literal reading costs 71,700 THB on the August run: 352 stations held a machine all
  // month and took no rental, 7-Eleven 59,950 of it. "even with no revenue, if there's any fixed
  // fee, we still have to pay, including electricity."
  const { roster } = expandRunRoster({ ...RUNFILE, orders: [] });
  assert.ok(roster.some(r => r.name === 'Approved A'));
  assert.ok(roster.some(r => r.name === 'Approved B'), 'no orders at all, still in the run');
});

test('it is idempotent — running it on its own output changes nothing', () => {
  const once = expandRunRoster(RUNFILE);
  const twice = expandRunRoster({ ...RUNFILE, merchants: once.roster });
  assert.equal(twice.roster.length, once.roster.length);
  assert.equal(twice.addedByMachine.length, 0);
  assert.equal(twice.addedByOrder.length, 0);
});

test('computeBulkRun goes through it, so the CLI re-run cannot differ from the route', () => {
  const back = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
  const i = back.indexOf('export async function computeBulkRun');
  const head = back.slice(i, back.indexOf('applyMerchantRoster', i) + 60);
  assert.match(head, /expandRunRoster\(\{ merchants, excluded, machines, orders \}\)/);
  assert.match(head, /applyMerchantRoster\(expanded\.roster/);
});

test('the run records which merchants that brought in, and the page shows them', () => {
  const back = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
  assert.match(back, /addedByMachine: expanded\.addedByMachine/);
  assert.match(back, /addedByOrder: expanded\.addedByOrder/);
  assert.ok(app.includes('run.addedByMachine') && app.includes('run.addedByOrder'),
    'stored and never read is the defect this already cost us once');
  const i = app.indexOf('const addedNote =');
  assert.match(app.slice(i, app.indexOf('</p>`', i)), /does not read a review state/);
});

// ── A recompute must not pay less because a Device Type was deleted ──────────────────────────
test('a retired machine model is caught before anything is computed', () => {
  const dead = deadRosterModels([
    { model: 'S8', partnerName: 'Fine' },
    { model: 'L40', partnerName: '7-Eleven' },
    { model: 'L40', partnerName: 'BTS' },
    { model: 'L40', partnerName: '7-Eleven' },
    { model: '', partnerName: 'No model' },
  ], ['S8', 'S5', 'LL40']);
  assert.equal(dead.length, 1);
  assert.equal(dead[0].model, 'L40');
  assert.equal(dead[0].rows, 3, 'how many rows carry it');
  assert.deepEqual(dead[0].brands, ['7-Eleven', 'BTS'], 'and which brands lose their payout');
});

test('a blank model is not reported as retired', () => {
  // Two different problems: a type that was deleted, and a roster row whose device type never
  // parsed. Only the first is fixed by restoring a type.
  assert.deepEqual(deadRosterModels([{ model: '', partnerName: 'X' }], ['S8']), []);
});

test('recompute refuses, names the cost, and writes nothing', () => {
  const back = readFileSync(new URL('../code/routes/bulk-runs.mjs', import.meta.url), 'utf8');
  const i = back.indexOf('export async function recomputeBulkRunRoute');
  const fn = back.slice(i, back.indexOf('\n}\n', i));
  const check = fn.indexOf('deadRosterModels');
  assert.ok(check > 0, 'the guard is in the route');
  assert.ok(check < fn.indexOf('computeBulkRun('), 'and runs BEFORE anything is computed');
  assert.ok(check < fn.indexOf('putBulkRun'), 'and before anything is written');
  assert.ok(check < fn.indexOf('deleteBulkRun'), 'and before the original is deleted');
  assert.match(fn, /retired_machine_model/);
  assert.match(fn, /Device types/, 'it says where to fix it');
  assert.match(fn, /has not been changed/, 'and that nothing happened');
});
