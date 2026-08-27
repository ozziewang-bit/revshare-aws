import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContractRow } from '../code/contracts.mjs';

// The merchant sheet mirrors the Merchant view grid: same column ORDER, and row 1 carries the
// grid's own category names. It is read by HEADER NAME, not position — the old 23-column
// layout was positional, which is why it had to keep dead columns forever and why a single
// inserted column silently shifted every field. Legacy files still take the positional path.
//
// Machine columns are 8 blank slots under the "Machines" category; whatever model code the
// user types in row 2 becomes the model. That is what lets one sheet serve both regions
// without the app dictating the model list.
const GROUPS = ['Merchant','Merchant','Merchant','Contact','Contact','Contact',
                'Machines','Machines','Machines','Machines','Machines','Machines','Machines','Machines','Machines',
                'Contract','Contract','Contract','Contract','Contract','Share terms','Share terms','Share terms'];
const HEADER = ['Merchant','Type','Counter party','Contact','Phone','Email',
                'Units','S5','S8','S10-A',null,null,null,null,null,
                'Start','End','Notice','Auto-renewal','Contract','Mode','GP %','Placement S5'];
const row = vals => normalizeContractRow(vals, HEADER, GROUPS);

test('reads the grid columns by name, in grid order', () => {
  const r = row(['Acme','Retail','Acme Pte Ltd','Jane','+65 1','jane@x.com',
                 12, 4, null, 8, null, null, null, null, null,
                 '2026-01-01','2026-12-31', 60, 'Auto', 'https://x/y', 'Hybrid', 25, 500]);
  assert.equal(r.merchantName, 'Acme');
  assert.equal(r.merchantType, 'Retail');
  assert.equal(r.counterParty, 'Acme Pte Ltd');
  assert.equal(r.contactName, 'Jane');
  assert.equal(r.contactEmail, 'jane@x.com');
  assert.equal(r.installedUnits, 12);
  assert.equal(r.startDate, '2026-01-01');
  assert.equal(r.endDate, '2026-12-31');
  assert.equal(r.terminationNoticeDays, 60);
  assert.equal(r.contractLink, 'https://x/y');
  assert.equal(r.rule.type, 'sum');
  assert.equal(r.rule.children.find(c => c.type === 'percent').rows[0].percent, 25);
  assert.deepEqual(r.rule.children.find(c => c.type === 'flat_per_machine').rows, [{ model: 'S5', amount: 500 }]);
});

test('machine columns take their model from whatever the user typed in row 2', () => {
  const r = row(['Acme',null,null,null,null,null, 12, 4, null, 8, null,null,null,null,null,
                 null,null,null,null,null,null,null,null]);
  assert.deepEqual(r.units, { S5: 4, 'S10-A': 8 });
});

test('a blank machine header contributes nothing, even with a value under it', () => {
  // Otherwise a stray number in an unlabelled spare slot would invent a model.
  const r = row(['Acme',null,null,null,null,null, 12, null,null,null, 99, null,null,null,null,
                 null,null,null,null,null,null,null,null]);
  assert.deepEqual(r.units, {});
});

test('only columns under the Machines category become unit counts', () => {
  // "Units" is the total, not a model, and must never become units.Units.
  const r = row(['Acme',null,null,null,null,null, 7, 1, null,null,null,null,null,null,null,
                 null,null,null,null,null,null,null,null]);
  assert.equal(r.installedUnits, 7);
  assert.deepEqual(r.units, { S5: 1 });
});

test('a legacy positional sheet still imports unchanged', () => {
  const c = new Array(23).fill(null);
  c[1] = 'Old Format'; c[2] = 'Retail'; c[5] = 3; c[22] = 'https://old/link';
  const r = normalizeContractRow(c);
  assert.equal(r.merchantName, 'Old Format');
  assert.equal(r.merchantType, 'Retail');
  assert.equal(r.units.S5, 3);
  assert.equal(r.contractLink, 'https://old/link');
});

test('a row with no merchant name is skipped in either shape', () => {
  assert.equal(row([null,'Retail']), null);
  assert.equal(normalizeContractRow(new Array(23).fill(null)), null);
});

import { buildImportPlan } from '../code/contracts.mjs';

// ── Share terms, as structured columns ────────────────────────────────────
// One column per term and per machine model, matching the Edit terms dialog. A single free-text
// column was tried and dropped the same day: too coarse to edit, and it could fail to parse.
const TG = [...GROUPS.slice(0, 20), 'Share terms','Share terms','Share terms','Share terms','Share terms','Share terms'];
const TH2 = [...HEADER.slice(0, 20), 'Mode','No payout','GP %','Placement S5','MG S8','Electricity'];
const trow = (...terms) => normalizeContractRow(
  ['Acme',null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null, ...terms], TH2, TG);

test('structured term columns compile to a rule', () => {
  const r = trow('Hybrid', null, 25, 500, null, 300);
  assert.equal(r.rule._method, 'hybrid');
  assert.equal(r.noPayout, false);
  const flat = JSON.stringify(r.rule);
  assert.match(flat, /"percent":25/);
  assert.match(flat, /"model":"S5","amount":500/);
  assert.match(flat, /"amount":300/);
});

test('MG is a floor: it produces a max, not another addend', () => {
  const r = trow('Whichever is higher', null, 25, null, 200, null);
  assert.equal(r.rule.type, 'max');
  assert.equal(r.rule._method, 'higher');
  assert.deepEqual(r.rule.children.find(c => c._t === 'mg').rows, [{ model: 'S8', amount: 200 }]);
});

test('No payout = Y marks the merchant unpaid and writes no rule', () => {
  const r = trow(null, 'Y', null, null, null, null);
  assert.equal(r.noPayout, true);
  assert.equal(r.rule, undefined, 'marking not-paid must not also rewrite the rule');
});

test('every term cell blank leaves rule absent, so an import cannot clear terms', () => {
  const r = trow(null, null, null, null, null, null);
  assert.equal(r.rule, undefined);
  assert.equal(r.noPayout, undefined);
});

test('blank term columns leave an existing rule untouched end-to-end', () => {
  const existing = [{ merchantNameLower: 'acme', contractId: 'c1', merchantName: 'Acme',
                      rule: { type: 'percent', rows: [{ model: 'ALL', percent: 40 }] } }];
  const { updates } = buildImportPlan([trow(null, null, null, null, null, null)], existing, []);
  assert.deepEqual(updates[0].rule, existing[0].rule);
});

test('a filled term column DOES replace the stored rule', () => {
  const existing = [{ merchantNameLower: 'acme', contractId: 'c1', merchantName: 'Acme',
                      rule: { type: 'percent', rows: [{ model: 'ALL', percent: 40 }] } }];
  const { updates } = buildImportPlan([trow('Default', null, 15, null, null, null)], existing, []);
  assert.equal(updates[0].rule.rows[0].percent, 15);
});
