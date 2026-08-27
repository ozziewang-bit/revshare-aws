import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { compileRule, parseDeviceType } from '../code/routes/import.mjs';

test('parseDeviceType: S5', () => assert.equal(parseDeviceType('Advertising Player-S5'), 'S5'));
test('parseDeviceType: S8', () => assert.equal(parseDeviceType('ChargeSpot Station-S8'), 'S8'));
// LL20, LL40 and L20 are DISTINCT codes — the Thai roster carries both "Advertising
// Player-LL40" (152 rows) and "Advertising Player-L20" (5). The old `.replace('LL','L')` fold is
// why Thai contracts stored L40; the data was wrong, not the code.
test('parseDeviceType: LL20 stays LL20', () => assert.equal(parseDeviceType('Advertising Player-LL20'), 'LL20'));
test('parseDeviceType: LL40 stays LL40', () => assert.equal(parseDeviceType('Advertising Player-LL40'), 'LL40'));
test('parseDeviceType: L20 stays L20', () => assert.equal(parseDeviceType('Advertising Player-L20'), 'L20'));
test('parseDeviceType: S10-A wins over S10', () => assert.equal(parseDeviceType('Advertising Player-S10-A'), 'S10-A'));
test('parseDeviceType: null input', () => assert.equal(parseDeviceType(null), null));
test('parseDeviceType: unrecognised string', () => assert.equal(parseDeviceType('Unknown-X9'), null));

test('compileRule: GP only (no MG, no fees)', () => {
  const rule = compileRule({ gpPercent: 25, electricity: 0, placementRows: [], mgRows: [], others: 0 });
  assert.equal(rule.type, 'percent');
  assert.equal(rule.rows[0].percent, 25);
  assert.equal(rule._t, 'gp');
});

test('compileRule: GP + per-type MG → max(GP, MG)', () => {
  const rule = compileRule({ gpPercent: 50, electricity: 0, placementRows: [], mgRows: [{ model: 'S8', amount: 200 }, { model: 'S5', amount: 150 }], others: 0 });
  assert.equal(rule.type, 'max');
  assert.equal(rule.children[0].type, 'percent');
  assert.equal(rule.children[1].type, 'flat_per_machine');
  assert.equal(rule.children[1]._t, 'mg');
  assert.equal(rule.children[1].rows.length, 2);
  assert.equal(rule.children[1].rows[0].amount, 200);
});

test('compileRule: GP + electricity + per-type placement = sum of 3', () => {
  const rule = compileRule({ gpPercent: 20, electricity: 600, placementRows: [{ model: 'S8', amount: 3300 }], mgRows: [], others: 0 });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 3);
  assert.equal(rule.children[0].type, 'percent');
  assert.equal(rule.children[1].amount, 600);
  assert.equal(rule.children[2].type, 'flat_per_machine');
});

test('compileRule: zero fees are omitted', () => {
  const rule = compileRule({ gpPercent: 30, electricity: 0, placementRows: [{ model: 'S8', amount: 500 }], mgRows: [], others: 0 });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 2);
});

// ── Electricity is a cost reimbursement: always added, never a comparison candidate ──

test('compileRule WH: GP + electricity + MG → sum( max(GP, MG) , Elec )', () => {
  const rule = compileRule({
    gpPercent: 50, electricity: 600, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule._method, 'higher');
  assert.equal(rule.children.length, 2);
  assert.equal(rule.children[0].type, 'max');
  assert.equal(rule.children[0].children[0]._t, 'gp');
  assert.equal(rule.children[0].children[1]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
  assert.equal(rule.children[1].amount, 600);
});

test('compileRule HH: GP + placement + electricity + MG → sum( max( sum(GP,Placement) , MG ) , Elec )', () => {
  const rule = compileRule({
    gpPercent: 20, electricity: 600, placementRows: [{ model: 'S8', amount: 3300 }],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'hybrid-higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule._method, 'hybrid-higher');
  assert.equal(rule.children.length, 2);
  const cmp = rule.children[0];
  assert.equal(cmp.type, 'max');
  assert.equal(cmp.children[0].type, 'sum');
  assert.equal(cmp.children[0].children.length, 2);
  assert.equal(cmp.children[0].children[0]._t, 'gp');
  assert.equal(cmp.children[0].children[1]._t, 'placement');
  assert.equal(cmp.children[1]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
});

test('compileRule WH: electricity only, no MG → bare electricity leaf', () => {
  const rule = compileRule({
    gpPercent: 0, electricity: 600, placementRows: [], mgRows: [], others: 0, method: 'higher',
  });
  assert.equal(rule.type, 'flat_per_partner_total');
  assert.equal(rule._t, 'elec');
  assert.equal(rule.amount, 600);
  assert.equal(rule._method, 'higher');
});

test('compileRule WH: electricity + MG only → sum( MG , Elec )', () => {
  const rule = compileRule({
    gpPercent: 0, electricity: 600, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 2);
  assert.equal(rule.children[0]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
});

test('compileRule HH without electricity is unchanged: max( GP , MG )', () => {
  const rule = compileRule({
    gpPercent: 50, electricity: 0, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 0, method: 'hybrid-higher',
  });
  assert.equal(rule.type, 'max');
  assert.equal(rule.children[0]._t, 'gp');
  assert.equal(rule.children[1]._t, 'mg');
});

test('compileRule hybrid still sums electricity inline, in editor order', () => {
  const rule = compileRule({
    gpPercent: 20, electricity: 600, placementRows: [{ model: 'S8', amount: 3300 }],
    mgRows: [], others: 0, method: 'hybrid',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 3);
  assert.equal(rule.children[0]._t, 'gp');
  assert.equal(rule.children[1]._t, 'elec');
  assert.equal(rule.children[2]._t, 'placement');
});

test('compileRule default: electricity as the only term', () => {
  const rule = compileRule({
    gpPercent: 0, electricity: 600, placementRows: [], mgRows: [], others: 0, method: 'default',
  });
  assert.equal(rule.type, 'flat_per_partner_total');
  assert.equal(rule._t, 'elec');
  assert.equal(rule._method, 'default');
});

// ── Others stays INSIDE the comparison; only electricity leaves it ──────────

test('compileRule WH: GP + others + electricity + MG → others is inside max, elec is outside', () => {
  const rule = compileRule({
    gpPercent: 50, electricity: 600, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 100, method: 'higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule._method, 'higher');
  assert.equal(rule.children.length, 2);
  const cmp = rule.children[0];
  assert.equal(cmp.type, 'max');
  assert.equal(cmp.children.length, 3);
  assert.equal(cmp.children[0]._t, 'gp');
  assert.equal(cmp.children[1]._t, 'others');
  assert.equal(cmp.children[2]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
});

test('compileRule HH: GP + others + electricity + MG → others is inside the summed comparison, elec is outside', () => {
  const rule = compileRule({
    gpPercent: 20, electricity: 600, placementRows: [],
    mgRows: [{ model: 'S8', amount: 200 }], others: 100, method: 'hybrid-higher',
  });
  assert.equal(rule.type, 'sum');
  assert.equal(rule._method, 'hybrid-higher');
  assert.equal(rule.children.length, 2);
  const cmp = rule.children[0];
  assert.equal(cmp.type, 'max');
  assert.equal(cmp.children[0].type, 'sum');
  assert.equal(cmp.children[0].children.length, 2);
  assert.equal(cmp.children[0].children[0]._t, 'gp');
  assert.equal(cmp.children[0].children[1]._t, 'others');
  assert.equal(cmp.children[1]._t, 'mg');
  assert.equal(rule.children[1]._t, 'elec');
});
