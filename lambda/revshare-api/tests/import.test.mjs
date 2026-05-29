import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Copy of the pure functions from routes/import.mjs (tested in isolation)
function parseDeviceType(deviceType) {
  if (!deviceType) return null;
  const m = String(deviceType).match(/-(S5|S8|S10|T8|T10|T20|T35|LL?20|LL?40)$/i);
  if (!m) return null;
  return m[1].toUpperCase().replace('LL', 'L');
}

function compileRule({ gpPercent, mgEnabled, mgAmount, electricity, placement, others }) {
  const children = [];
  const gpLeaf = { type: 'percent', rows: [{ model: 'ALL', percent: Number(gpPercent) }] };
  if (mgEnabled && Number(mgAmount) > 0) {
    children.push({ type: 'max', children: [gpLeaf, { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: Number(mgAmount) }] }] });
  } else {
    children.push(gpLeaf);
  }
  if (Number(electricity) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(electricity) });
  if (Number(placement) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(placement) });
  if (Number(others) > 0) children.push({ type: 'flat_per_partner_total', amount: Number(others) });
  if (children.length === 1) return children[0];
  return { type: 'sum', children };
}

test('parseDeviceType: S5', () => assert.equal(parseDeviceType('Advertising Player-S5'), 'S5'));
test('parseDeviceType: S8', () => assert.equal(parseDeviceType('ChargeSpot Station-S8'), 'S8'));
test('parseDeviceType: LL20 normalised to L20', () => assert.equal(parseDeviceType('Advertising Player-LL20'), 'L20'));
test('parseDeviceType: LL40 normalised to L40', () => assert.equal(parseDeviceType('Advertising Player-LL40'), 'L40'));
test('parseDeviceType: null input', () => assert.equal(parseDeviceType(null), null));
test('parseDeviceType: unrecognised string', () => assert.equal(parseDeviceType('Unknown-X9'), null));

test('compileRule: GP only (no MG, no fees)', () => {
  const rule = compileRule({ gpPercent: 25, mgEnabled: false, mgAmount: 0, electricity: 0, placement: 0, others: 0 });
  assert.deepEqual(rule, { type: 'percent', rows: [{ model: 'ALL', percent: 25 }] });
});

test('compileRule: GP + MG wraps in max', () => {
  const rule = compileRule({ gpPercent: 50, mgEnabled: true, mgAmount: 200, electricity: 0, placement: 0, others: 0 });
  assert.equal(rule.type, 'max');
  assert.equal(rule.children[0].type, 'percent');
  assert.equal(rule.children[1].type, 'flat_per_machine');
  assert.equal(rule.children[1].rows[0].amount, 200);
});

test('compileRule: GP + electricity + placement = sum of 3', () => {
  const rule = compileRule({ gpPercent: 20, mgEnabled: false, mgAmount: 0, electricity: 600, placement: 3300, others: 0 });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 3);
  assert.equal(rule.children[0].type, 'percent');
  assert.equal(rule.children[1].amount, 600);
  assert.equal(rule.children[2].amount, 3300);
});

test('compileRule: zero fees are omitted', () => {
  const rule = compileRule({ gpPercent: 30, mgEnabled: false, mgAmount: 0, electricity: 0, placement: 500, others: 0 });
  assert.equal(rule.type, 'sum');
  assert.equal(rule.children.length, 2);
});
