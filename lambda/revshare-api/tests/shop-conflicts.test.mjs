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

// REVISED 2026-10-01: rule A2 — only an APPROVED merchant reaches the registry, so a held-back
// one is counted rather than offered. Review state is still shown on every row it does list, and
// held-back merchants with machines live have their own tab; what changed is that the registry
// stopped offering an Add button for something the rule forbids.
test('a merchant the file names with no registry row is an ADD, if it is Approved', () => {
  const r = registryCheck(DOC, [], CONTRACTS2);
  assert.equal(r.counts.missing, 3, 'the three Approved ones');
  assert.equal(r.counts.notEligible, 1, 'the held-back one is counted, not offered');
  assert.equal(r.counts.missingNoMerchant, 1, 'and the one whose brand is not registered');
  assert.ok(r.missing.every(x => x.contractId === 'gg'), 'each carries where to point it');
});

test('a held-back merchant is never offered, and state is shown where it IS listed', () => {
  const r = registryCheck(DOC, [], CONTRACTS2);
  assert.ok(!r.missing.some(x => x.name === 'Held back shop'));
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

// ── One name, one page (2026-10-01) ──────────────────────────────────────────────────────────
// "please don't show the same mismatch in different sub page, it's really confusing." A brand
// with one merchant shares its name with that merchant, so `Minato Shokudou` appeared as an
// unregistered BRAND and as a MERCHANT with no brand linked — one fact, two tabs. Measured: 11
// names on two pages. Precedence: the BRAND is fixed first, because registering it resolves every
// merchant under it.
const DOC3 = {
  merchants: [
    { name: 'Minato Shokudou', partnerName: 'Minato Shokudou', model: 'S8' },  // brand unregistered
    { name: 'Real shop', partnerName: 'GG Bistro', model: 'S8' },
  ],
  excluded: [],
};
const CONTRACTS3 = [C('gg', 'GG Bistro'), C('left', 'Brand That Left')];

test('a merchant whose brand is not registered is NOT also listed under the registry', () => {
  const r = registryCheck(DOC3, [{ name: 'Minato Shokudou' }], CONTRACTS3);
  assert.deepEqual(r.noLink.map(x => x.name), [],
    'the brand tab asks for it once; asking here too is the same request twice');
  assert.ok(r.counts.onBrandTab >= 1, 'but it is counted, not silently dropped');
});

test('a merchant of a brand that left the file is not listed either', () => {
  const r = registryCheck(DOC3, [{ name: 'Old shop', contractId: 'left' }], CONTRACTS3);
  assert.deepEqual(r.notInFile.map(x => x.name), []);
  assert.ok(r.counts.onBrandTab >= 1);
});

test('a merchant whose brand IS registered is still listed', () => {
  const r = registryCheck(DOC3, [{ name: 'Real shop' }], CONTRACTS3);
  assert.deepEqual(r.noLink.map(x => x.name), ['Real shop'],
    'nothing is hidden when the brand is fine and the merchant is the problem');
});

test('no name appears in two sections of the registry answer', () => {
  const r = registryCheck(DOC3, [{ name: 'Real shop' }, { name: 'Real shop' }], CONTRACTS3);
  const seen = new Map();
  for (const k of ['missing', 'wrongLink', 'noLink', 'notInFile']) {
    for (const x of r[k]) {
      const n = String(x.name).toLowerCase();
      assert.ok(!seen.has(n), `${x.name} is in both ${seen.get(n)} and ${k}`);
      seen.set(n, k);
    }
  }
});

test('the page says how many were left out, and where they went', () => {
  const app2 = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = app2.indexOf('function registryHtml');
  const fn = app2.slice(i, app2.indexOf('\n}\n', i));
  assert.match(fn, /c\.missingNoMerchant \+ \(c\.onBrandTab \|\| 0\)/);
  assert.match(fn, /whose brand is the thing/);
  assert.match(fn, /sorting the brand sorts every merchant under it/);
});

// ── Only what rule A2 allows is offered (2026-10-01) ─────────────────────────────────────────
// "Demo Ying also shows at not approved, machines live" — because the registry list ignored
// review state. Rule A2: ONLY an Approved merchant with a machine deployed and bound to it
// reaches the registry. Measured: of 347 offered with an Add button, 334 were Disapproved and 11
// Pending; 2 qualified. Offering the rest asks for something the rule forbids, and puts the same
// merchant on two tabs.
const DOC4 = {
  merchants: [{ name: 'Good one', partnerName: 'GG Bistro' },
              { name: 'No machine', partnerName: 'GG Bistro' }],
  excluded: [{ name: 'Pending one', label: 'GG Bistro', reviewState: 'Pending' },
             { name: 'Disapproved one', label: 'GG Bistro', reviewState: 'Disapproved' }],
  machines: [{ store: 'Good one', counts: { S8: 1 }, deployed: 1, total: 1 },
             { store: 'No machine', counts: { S8: 1 }, deployed: 0, total: 1 },
             { store: 'Pending one', counts: { S8: 2 }, deployed: 2, total: 2 }],
};

test('a merchant that is not Approved is never offered for the registry', () => {
  const r = registryCheck(DOC4, [], [C('gg', 'GG Bistro')]);
  assert.deepEqual(r.missing.map(x => x.name), ['Good one']);
  assert.equal(r.counts.notEligible, 3, 'the other three are counted, not silently dropped');
});

test('an Approved merchant with nothing deployed is not offered either', () => {
  const r = registryCheck(DOC4, [], [C('gg', 'GG Bistro')]);
  assert.ok(!r.missing.some(x => x.name === 'No machine'));
});

// Machine rows written before 2026-10-01 carry counts and no state. Treating that as "nothing is
// deployed" would empty the list for the wrong reason.
test('with no machine state on record, Approved alone is the test', () => {
  const old = { ...DOC4, machines: DOC4.machines.map(({ store, counts }) => ({ store, counts })) };
  const r = registryCheck(old, [], [C('gg', 'GG Bistro')]);
  assert.deepEqual(r.missing.map(x => x.name).sort(), ['Good one', 'No machine']);
  assert.equal(r.counts.notEligible, 2, 'and the two not Approved are still excluded');
});

test('the page says how many were held back and why', () => {
  const app2 = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = app2.indexOf('function registryHtml');
  const fn = app2.slice(i, app2.indexOf('\n}\n', i));
  assert.match(fn, /c\.notEligible/);
  assert.match(fn, /not Approved, or\s*\n?\s*have no deployed machine/);
  assert.match(fn, /Not approved, machines live/, 'and points at the tab that does cover them');
});

test('the section says the brand is already registered', () => {
  const app2 = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
  const i = app2.indexOf('function registryHtml');
  const fn = app2.slice(i, app2.indexOf('\n}\n', i));
  // "shouldn't Kliff Beach Bistro & Bar be at brand not registered part?" — no: the BRAND is
  // registered, only the merchant row is missing, and a one-merchant brand shares its name.
  assert.match(fn, /whose brand is already registered/);
  assert.match(fn, /A brand with one merchant shares its name/);
});
