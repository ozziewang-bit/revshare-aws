import { test } from 'node:test';
import { strict as assert } from 'node:assert';

// Copy of the pure functions from routes/import.mjs (tested in isolation)
function parseDeviceType(deviceType) {
  if (!deviceType) return null;
  const m = String(deviceType).match(/-(S5|S8|S10|T8|T10|T20|T35|LL?20|LL?40)$/i);
  if (!m) return null;
  return m[1].toUpperCase().replace('LL', 'L');
}

function compileRule({ gpPercent, electricity, placementRows, mgRows, others }) {
  const adds = [];
  if (Number(gpPercent) > 0) adds.push({ type: 'percent', _t: 'gp', _m: 'add', rows: [{ model: 'ALL', percent: Number(gpPercent) }] });
  if (Number(electricity) > 0) adds.push({ type: 'flat_per_partner_total', _t: 'elec', _m: 'add', amount: Number(electricity) });
  const vp = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  if (vp.length) adds.push({ type: 'flat_per_machine', _t: 'placement', _m: 'add', rows: vp.map(r => ({ model: r.model, amount: Number(r.amount) })) });
  if (Number(others) > 0) adds.push({ type: 'flat_per_partner_total', _t: 'others', _m: 'add', amount: Number(others) });
  const vmg = (mgRows || []).filter(r => r.model && Number(r.amount) > 0);
  const mgLeaf = vmg.length ? { type: 'flat_per_machine', _t: 'mg', rows: vmg.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;

  let rule;
  if (mgLeaf) {
    const s = adds.length === 0 ? { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }] }
      : (adds.length === 1 ? adds[0] : { type: 'sum', children: adds });
    rule = { type: 'max', children: [s, mgLeaf] };
    return { ...rule, _method: 'hybrid-higher' };
  }
  if (!adds.length) return { type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }], _method: 'default' };
  if (adds.length === 1) return { ...adds[0], _method: 'default' };
  return { type: 'sum', children: adds, _method: 'hybrid' };
}

test('parseDeviceType: S5', () => assert.equal(parseDeviceType('Advertising Player-S5'), 'S5'));
test('parseDeviceType: S8', () => assert.equal(parseDeviceType('ChargeSpot Station-S8'), 'S8'));
test('parseDeviceType: LL20 normalised to L20', () => assert.equal(parseDeviceType('Advertising Player-LL20'), 'L20'));
test('parseDeviceType: LL40 normalised to L40', () => assert.equal(parseDeviceType('Advertising Player-LL40'), 'L40'));
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
