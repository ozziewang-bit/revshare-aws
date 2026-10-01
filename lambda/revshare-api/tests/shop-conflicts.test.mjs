import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shopConflicts, registryCheck } from '../code/routes/contracts.mjs';

// ── A shop whose registry row points at a different merchant than the file (2026-10-01) ──────
// The registry outlives what it points at: a brand split in two, a shop that changed hands, a
// merchant deleted. 6,770 rows for 2,540 shops. It does not decide a payout — a run resolves by
// the brand label in the file — but it decides which merchant `Assign→` attributes an order to.
//
// Reported ONLY when both sides name a merchant that still exists. A row pointing at a deleted or
// archived contract is a stale link, not a competing answer; counting those would bury the
// handful that matter under a list about merchants that are no longer there. Same rule as
// `matchMachineStores` on the upload — two screens, one definition.
const C = (contractId, merchantName, extra = {}) => ({ contractId, merchantName, ...extra });
const CONTRACTS = [
  C('east', 'Central Eastville'),
  C('central', 'Central'),
  C('seacon', 'SEACON', { archived: true }),
  C('bangkae', 'SEACON Bangkae'),
  C('gg', 'GG Bistro'),
  C('udon', 'Udon'),
];
const roster = (rows) => rows.map(([name, partnerName, model]) => ({ name, partnerName, model }));

test('the file and the registry naming two different LIVE merchants is a conflict', () => {
  const out = shopConflicts(
    roster([['Uniqlo floor', 'Central Eastville', 'LL40']]),
    [{ name: 'Uniqlo floor', contractId: 'central' }],
    CONTRACTS);
  assert.equal(out.length, 1);
  assert.equal(out[0].fileBrand, 'Central Eastville');
  assert.equal(out[0].registryBrand, 'Central');
  assert.equal(out[0].model, 'LL40');
});

// This is the SEACON question: archiving one side settles it.
test('a registry row pointing at an ARCHIVED merchant is not a conflict', () => {
  const out = shopConflicts(
    roster([['Bangkae shop', 'SEACON Bangkae']]),
    [{ name: 'Bangkae shop', contractId: 'seacon' }],
    CONTRACTS);
  assert.deepEqual(out, [], 'the live contract is the only answer; nothing to settle');
});

test('a registry row pointing at a DELETED merchant is not a conflict', () => {
  const out = shopConflicts(
    roster([['Shop', 'GG Bistro']]),
    [{ name: 'Shop', contractId: 'gone-long-ago' }],
    CONTRACTS);
  assert.deepEqual(out, []);
});

test('agreement is not a conflict', () => {
  const out = shopConflicts(
    roster([['Shop', 'GG Bistro']]),
    [{ name: 'Shop', contractId: 'gg' }],
    CONTRACTS);
  assert.deepEqual(out, []);
});

// A shop routinely has several registry rows; a dangling one must not speak for it.
test('a live link wins over a dead one on the same shop', () => {
  const agree = shopConflicts(
    roster([['Shop', 'GG Bistro']]),
    [{ name: 'Shop', contractId: 'deleted' }, { name: 'Shop', contractId: 'gg' }],
    CONTRACTS);
  assert.deepEqual(agree, [], 'the live row says GG Bistro, and so does the file');

  const clash = shopConflicts(
    roster([['Shop', 'GG Bistro']]),
    [{ name: 'Shop', contractId: 'deleted' }, { name: 'Shop', contractId: 'udon' }],
    CONTRACTS);
  assert.equal(clash.length, 1);
  assert.equal(clash[0].registryBrand, 'Udon');
  assert.equal(clash[0].rows, 2, 'and it says how many rows would change');
});

test('a brand the app does not carry is not reported here', () => {
  // That is the "No contract" tab's job. Reporting it twice makes one fact look like two.
  const out = shopConflicts(
    roster([['Shop', 'Brand With No Contract']]),
    [{ name: 'Shop', contractId: 'gg' }],
    CONTRACTS);
  assert.deepEqual(out, []);
});

test('a shop with no registry row at all is not a conflict', () => {
  assert.deepEqual(shopConflicts(roster([['Shop', 'GG Bistro']]), [], CONTRACTS), []);
  assert.deepEqual(shopConflicts(roster([['Shop', 'GG Bistro']]),
                                 [{ name: 'Shop' }], CONTRACTS), [], 'nor one with no link');
});

test('each shop is reported once, however many times the file lists it', () => {
  const out = shopConflicts(
    roster([['Shop', 'GG Bistro'], ['SHOP', 'GG Bistro'], [' shop ', 'GG Bistro']]),
    [{ name: 'Shop', contractId: 'udon' }],
    CONTRACTS);
  assert.equal(out.length, 1, 'matched case- and space-insensitively, like everything else here');
});

test('bad input does not throw', () => {
  for (const a of [[null, null, null], [undefined, [], CONTRACTS], [[{}], [{}], [{}]]]) {
    assert.doesNotThrow(() => shopConflicts(...a));
  }
});

// The route must not change anything — it is a reading of two things that already exist.
test('the route only reads', () => {
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export async function rosterConflictsRoute');
  const fn = src.slice(i, src.indexOf('\n}', i)).replace(/\/\/[^\n]*/g, '');
  assert.ok(!/putContract|putMerchant|UpdateCommand|delete/i.test(fn));
  assert.match(fn, /listMerchants\(\)/, 'the registry comparison happens on the server');
});

// ── The tab ─────────────────────────────────────────────────────────────────────────────────
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const grab = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0, k = app.indexOf('(', i);
  for (; k < app.length; k++) { if (app[k] === '(') d++; else if (app[k] === ')') { d--; if (!d) break; } }
  for (let j = app.indexOf('{', k), b = 0; j < app.length; j++) {
    if (app[j] === '{') b++; else if (app[j] === '}') { b--; if (!b) return app.slice(i, j + 1); }
  }
};

test('the repoint button can report back to a screen with no loaded file', () => {
  const i = app.indexOf('async function repointStoreFromFile(');
  const fn = strip(app.slice(i, app.indexOf('\n}\n', i)));
  assert.match(fn, /repointStoreFromFile\(store, brand, btn, onDone\)/);
  assert.match(fn, /if \(onDone\) await onDone\(/);
  assert.match(fn, /else await refreshUploadTable\(/, 'the upload flow keeps its own behaviour');
  const body = fn.slice(fn.indexOf("method: 'PUT'"), fn.indexOf('});', fn.indexOf("method: 'PUT'")));
  assert.match(body, /JSON\.stringify\(\{ contractId: target\.contractId \}\)/);
});

// ── registryCheck: the whole comparison, not just the clashes (2026-10-01) ───────────────────
// "compare my file with the registry, point out what's mismatched and a button to allow us
// update the registry." Five buckets, each needing a different action.
//
// REVIEW STATE IS NEVER A FILTER. "RUN SHARE AND APPROVED STATUS ARE NOT RELATED" — a shop the
// platform has not approved is still a shop, and leaving it out of the index would make it a
// stranger the week it comes back.
const DOC = {
  merchants: [
    { name: 'Approved shop', nameEn: 'A', partnerName: 'GG Bistro', model: 'S8', externalId: 'x1' },
    { name: 'Wrongly linked', partnerName: 'GG Bistro', model: 'S8' },
    { name: 'Unlinked shop', partnerName: 'GG Bistro', model: 'S5' },
    { name: 'Brand has no merchant', partnerName: 'Nobody Ltd', model: 'S8' },
  ],
  excluded: [
    { name: 'Held back shop', label: 'GG Bistro', reviewState: 'Disapproved' },
  ],
};
const CONTRACTS2 = [C('gg', 'GG Bistro'), C('udon', 'Udon'), C('old', 'Archived', { archived: true })];

test('a shop the file names with no registry row is an ADD', () => {
  const r = registryCheck(DOC, [], CONTRACTS2);
  assert.equal(r.counts.missing, 4, 'three Approved and the held-back one');
  assert.equal(r.counts.missingNoMerchant, 1, 'and the one whose brand has brand not registered');
  assert.ok(r.missing.every(x => x.contractId === 'gg'), 'each carries where to point it');
});

test('a held-back shop is included, with its state shown', () => {
  const r = registryCheck(DOC, [], CONTRACTS2);
  const held = r.missing.find(x => x.name === 'Held back shop');
  assert.ok(held, 'approval is not a filter');
  assert.equal(held.state, 'Disapproved');
  assert.equal(r.missing.find(x => x.name === 'Approved shop').state, 'Approved');
});

test('a row pointing at a live merchant the file does not name is a REPOINT', () => {
  const r = registryCheck(DOC, [{ name: 'Wrongly linked', contractId: 'udon' }], CONTRACTS2);
  assert.equal(r.counts.wrongLink, 1);
  assert.equal(r.wrongLink[0].registryBrand, 'Udon');
  assert.equal(r.wrongLink[0].brand, 'GG Bistro');
  assert.equal(r.wrongLink[0].contractId, 'gg', 'and where it should point');
});

test('a row pointing at nothing, or at an archived merchant, is a LINK', () => {
  const r = registryCheck(DOC, [{ name: 'Unlinked shop' },
                                { name: 'Approved shop', contractId: 'old' }], CONTRACTS2);
  assert.equal(r.counts.noLink, 2, 'an archived link is no link');
  assert.ok(r.noLink.every(x => x.contractId === 'gg'));
});

test('agreement is in no bucket', () => {
  const r = registryCheck(DOC, [{ name: 'Approved shop', contractId: 'gg' }], CONTRACTS2);
  assert.ok(!r.wrongLink.length && !r.noLink.length);
  assert.ok(!r.missing.some(x => x.name === 'Approved shop'));
});

test('a registry shop the file no longer names is reported, never deleted', () => {
  const r = registryCheck(DOC, [{ name: 'Long gone', contractId: 'gg' }], CONTRACTS2);
  assert.equal(r.counts.notInFile, 1);
  assert.equal(r.notInFile[0].brand, 'GG Bistro');
  const src = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const i = src.indexOf('export function registryCheck');
  assert.ok(!/delete/i.test(src.slice(i, src.indexOf('\nexport async function registryCheckRoute'))
    .replace(/\/\/[^\n]*/g, '')));
});

test('duplicate rows are counted, not acted on', () => {
  const r = registryCheck(DOC, [{ name: 'Approved shop', contractId: 'gg' },
                                { name: 'Approved shop', contractId: 'gg' },
                                { name: 'Approved shop', contractId: 'gg' }], CONTRACTS2);
  assert.equal(r.counts.duplicated, 1);
  assert.equal(r.counts.duplicateRows, 2, 'rows beyond one per shop');
});

test('the answer is capped so one bucket cannot become the payload', () => {
  const many = { merchants: Array.from({ length: 900 }, (_, i) =>
    ({ name: 'shop ' + i, partnerName: 'GG Bistro', model: 'S8' })), excluded: [] };
  const r = registryCheck(many, [], CONTRACTS2, 400);
  assert.equal(r.counts.missing, 900, 'the COUNT is honest');
  assert.equal(r.missing.length, 400, 'the list is capped');
});

test('bad input does not throw', () => {
  for (const a of [[null, null, null], [undefined, [], CONTRACTS2], [{}, [{}], [{}]]]) {
    assert.doesNotThrow(() => registryCheck(...a));
  }
});

// ── The tab ─────────────────────────────────────────────────────────────────────────────────
test('every registry write goes through the additive batch route', () => {
  const fn = strip(grab('wireMismatchActions'));
  assert.match(fn, /api\('\/registry', \{ method: 'POST'/);
  assert.ok(!/\/merchants\//.test(fn), 'not the raw per-row CRUD');
  assert.match(fn, /confirm\(/, 'a bulk write asks first');
  assert.match(fn, /No brand, terms or past run are touched/);
});

test('a bulk write sends only what the file states', () => {
  const fn = strip(grab('wireMismatchActions'));
  assert.match(fn, /name: r\.name, contractId: r\.contractId/);
  assert.match(fn, /machineModel: r\.model \|\| null, externalId: r\.externalId \|\| null/);
});

test('an unlinked shop whose brand has no merchant gets no button', () => {
  const fn = strip(grab('registryHtml'));
  assert.match(fn, /r\.contractId\s*\n?\s*\?\s*`<button[^`]*reg-one/);
  assert.match(fn, /brand not registered/);
});

test('the registry tab names every bucket it found', () => {
  const fn = strip(grab('registryHtml'));
  // One vocabulary, settled 2026-10-01: the record that carries terms is a BRAND, the shop list
  // is the SHOP INDEX. The app had been calling the brand row "merchant", "contract" and
  // "merchant record" while "merchant" was also the stored name of the shop row.
  for (const t of ['Not in the registry', 'Pointing at a different brand',
                   'In the registry with no brand', 'In the registry, not in your file',
                   'Merchants with more than one row']) {
    assert.ok(fn.includes(t), t);
  }
});

// ── Machine state (2026-10-01) ───────────────────────────────────────────────────────────────
// A stored machine row only answers these questions if it carries the state. Rows written before
// this change have counts and no `deployed` — reading those as "nothing is deployed" reported all
// 2,380 shops as having no machine, every finding false. Absent means NOT KNOWN, not zero.
const { machineCheck } = await import('../code/routes/contracts.mjs');

const DOC2 = {
  merchants: [{ name: 'Live shop', partnerName: 'GG Bistro' },
              { name: 'Quiet shop', partnerName: 'GG Bistro' }],
  excluded: [{ name: 'Pending shop', label: 'GG Bistro', reviewState: 'Pending' }],
  machines: [
    { store: 'Live shop', counts: { S8: 2 }, deployed: 2, total: 2, businessId: 'b1' },
    { store: 'Quiet shop', counts: { S8: 1 }, deployed: 0, total: 1, businessId: 'b2' },
    { store: 'Pending shop', counts: { S8: 2 }, deployed: 2, total: 2, businessId: 'b3' },
    { store: 'Nobody owns me', counts: { S5: 1 }, deployed: 1, total: 1, businessId: 'b4' },
  ],
};

test('machine rows with no state field are "not known", not "nothing deployed"', () => {
  const old = { ...DOC2, machines: DOC2.machines.map(({ store, counts }) => ({ store, counts })) };
  const r = machineCheck(old);
  assert.equal(r.counts.hasMachineFile, false);
  assert.equal(r.counts.approvedNoDeployed, 0, 'not 2,380 false findings');
  assert.deepEqual(r.approvedNoDeployed, []);
});

test('not approved but machines deployed under it', () => {
  const r = machineCheck(DOC2);
  assert.equal(r.counts.notApprovedDeployed, 1);
  assert.equal(r.notApprovedDeployed[0].name, 'Pending shop');
  assert.equal(r.notApprovedDeployed[0].deployed, 2);
  assert.equal(r.notApprovedDeployed[0].state, 'Pending');
});

test('approved but nothing deployed — a bound machine that is not live still counts as none', () => {
  const r = machineCheck(DOC2);
  assert.deepEqual(r.approvedNoDeployed.map(x => x.name), ['Quiet shop']);
  assert.equal(r.approvedNoDeployed[0].machines, 1, 'and it says a machine IS bound, just not live');
});

test('a deployed machine under a shop no merchant file names', () => {
  const r = machineCheck(DOC2);
  assert.deepEqual(r.deployedUnbound.map(x => x.name), ['Nobody owns me']);
  assert.equal(r.deployedUnbound[0].businessId, 'b4', 'the id is how you find the machine');
});

test('a shop appears in exactly one of the three', () => {
  const r = machineCheck(DOC2);
  const names = [...r.notApprovedDeployed, ...r.approvedNoDeployed, ...r.deployedUnbound]
    .map(x => x.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.includes('live shop'), 'the one that is fine appears nowhere');
});

test('no machine list at all is silent', () => {
  const r = machineCheck({ ...DOC2, machines: [] });
  assert.equal(r.counts.hasMachineFile, false);
  for (const k of ['notApprovedDeployed', 'approvedNoDeployed', 'deployedUnbound']) {
    assert.deepEqual(r[k], [], k);
  }
  assert.doesNotThrow(() => machineCheck(null));
});

test('"deployed" is matched loosely, so a respelling does not read as not-deployed', () => {
  const app2 = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
  const fe = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  assert.match(fe, /const isDeployed = \(v\) => \/deploy\/i\.test/);
  assert.ok(app2.includes('machineCheck'), 'and the comparison lives on the server');
});
