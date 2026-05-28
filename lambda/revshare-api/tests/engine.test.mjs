import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { MACHINE_MODELS, evaluateRun } from '../code/engine.mjs';

test('MACHINE_MODELS enum contains all nine models', () => {
  assert.deepEqual([...MACHINE_MODELS].sort(),
    ['L20','L40','S10','S5','S8','T10','T20','T35','T8']);
});

test('evaluateRun with bad rule throws', () => {
  assert.throws(() => evaluateRun({ rule: null, rows: [], aggregationMode: 'whole' }),
    /rule must be a node/);
});

test('flat_per_machine with single ALL row: 3 machines × 500 = 1500', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: 500 }] },
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 10, revenue: 1000 },
      { storeId: 'A', machineSerial: 'M2', model: 'T35', rentals:  5, revenue: 2000 },
      { storeId: 'A', machineSerial: 'M3', model: 'L20', rentals:  0, revenue:    0 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 1500);
});

test('flat_per_machine: per-model overrides + ALL catch-all', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [
      { model: 'S5',  amount: 300 },
      { model: 'T35', amount: 800 },
      { model: 'ALL', amount: 100 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M2', model: 'S5',  rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M3', model: 'T35', rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M4', model: 'L20', rentals: 1, revenue: 0 },
    ],
    aggregationMode: 'whole'
  });
  // 2×300 + 1×800 + 1×100 = 1500
  assert.equal(result.totalPayout, 1500);
});

test('flat_per_machine: model not covered and no ALL row → 0 contribution', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'S5', amount: 300 }] },
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 1, revenue: 0 },
      { storeId: 'A', machineSerial: 'M2', model: 'L20', rentals: 1, revenue: 0 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 300);
});

test('percent leaf: 10% on S5 revenue, 5% on T35', () => {
  const result = evaluateRun({
    rule: { type: 'percent', rows: [
      { model: 'S5', percent: 10 }, { model: 'T35', percent: 5 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 0, revenue: 10000 },
      { storeId: 'A', machineSerial: 'M2', model: 'T35', rentals: 0, revenue: 20000 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 2000);   // 1000 + 1000
});

test('percent leaf: ALL applies to uncovered models', () => {
  const result = evaluateRun({
    rule: { type: 'percent', rows: [
      { model: 'S5', percent: 10 }, { model: 'ALL', percent: 2 },
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5',  rentals: 0, revenue: 10000 },
      { storeId: 'A', machineSerial: 'M2', model: 'L20', rentals: 0, revenue:  5000 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 1100);   // 1000 + 100
});

test('tiered_percent: marginal brackets on revenue, single ALL row', () => {
  const result = evaluateRun({
    rule: { type: 'tiered_percent', basis: 'revenue', rows: [
      { model: 'ALL', tiers: [
        { from: 0, to: 50000, percent: 0 },
        { from: 50000, to: 100000, percent: 10 },
        { from: 100000, percent: 15 },
      ]}
    ]},
    rows: [{ storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 120000 }],
    aggregationMode: 'whole'
  });
  // 50000*0 + 50000*0.10 + 20000*0.15 = 0 + 5000 + 3000 = 8000
  assert.equal(result.totalPayout, 8000);
});

test('tiered_percent: per-model tier ladders are independent', () => {
  const result = evaluateRun({
    rule: { type: 'tiered_percent', basis: 'revenue', rows: [
      { model: 'S5', tiers: [{ from: 0, to: 50000, percent: 0 }, { from: 50000, percent: 10 }]},
      { model: 'T35', tiers: [{ from: 0, to: 30000, percent: 5 }, { from: 30000, percent: 12 }]},
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 80000 },
      { storeId: 'A', machineSerial: 'M2', model: 'T35', rentals: 0, revenue: 42000 },
    ],
    aggregationMode: 'whole'
  });
  // S5: 30000*0.10 = 3000; T35: 30000*0.05 + 12000*0.12 = 1500+1440 = 2940
  assert.equal(result.totalPayout, 5940);
});

test('tiered_percent: basis=rentals counts rentals not revenue', () => {
  const result = evaluateRun({
    rule: { type: 'tiered_percent', basis: 'rentals', rows: [
      { model: 'ALL', tiers: [{ from: 0, to: 100, percent: 0 }, { from: 100, percent: 10 }]}
    ]},
    rows: [{ storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 250, revenue: 0 }],
    aggregationMode: 'whole'
  });
  // 100*0 + 150*0.10 = 15
  assert.equal(result.totalPayout, 15);
});

test('flat_per_partner_total at root contributes its amount', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_partner_total', amount: 5000 },
    rows: [{ storeId: 'A', machineSerial: 'M', model: 'S5', rentals: 0, revenue: 0 }],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 5000);
});

test('flat_per_partner_total nested in max is rejected in per_store mode', () => {
  assert.throws(() => evaluateRun({
    rule: { type: 'max', children: [
      { type: 'percent', rows: [{ model: 'ALL', percent: 10 }] },
      { type: 'flat_per_partner_total', amount: 10000 }
    ]},
    rows: [],
    aggregationMode: 'per_store'
  }), /flat_per_partner_total.*per_store/);
});

test('sum combinator adds child outputs', () => {
  const result = evaluateRun({
    rule: { type: 'sum', children: [
      { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: 100 }] },
      { type: 'percent', rows: [{ model: 'ALL', percent: 10 }] },
    ]},
    rows: [{ storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 1000 }],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 200);  // 100 flat + 100 percent
});

test('max: minimum-guarantee shape returns the larger', () => {
  const result = evaluateRun({
    rule: { type: 'max', children: [
      { type: 'percent', rows: [{ model: 'ALL', percent: 15 }] },
      { type: 'flat_per_partner_total', amount: 10000 },
    ]},
    rows: [{ storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 50000 }],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 10000);   // max(7500, 10000)
});

test('min: cap shape returns the smaller', () => {
  const result = evaluateRun({
    rule: { type: 'min', children: [
      { type: 'percent', rows: [{ model: 'ALL', percent: 20 }] },
      { type: 'flat_per_partner_total', amount: 5000 },
    ]},
    rows: [{ storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 100000 }],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 5000);    // min(20000, 5000)
});

test('whole aggregation: byPartner present, no byStore', () => {
  const result = evaluateRun({
    rule: { type: 'flat_per_machine', rows: [{ model: 'ALL', amount: 100 }] },
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 0 },
      { storeId: 'B', machineSerial: 'M2', model: 'S5', rentals: 0, revenue: 0 },
    ],
    aggregationMode: 'whole'
  });
  assert.equal(result.totalPayout, 200);
  assert.equal(result.byPartner.payout, 200);
  assert.equal(result.byStore, undefined);
});

test('per_store: byStore present, tiers reset per store', () => {
  const result = evaluateRun({
    rule: { type: 'tiered_percent', basis: 'revenue', rows: [
      { model: 'ALL', tiers: [{ from: 0, to: 100, percent: 0 }, { from: 100, percent: 10 }]}
    ]},
    rows: [
      { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 80 },
      { storeId: 'B', machineSerial: 'M2', model: 'S5', rentals: 0, revenue: 80 },
    ],
    aggregationMode: 'per_store'
  });
  assert.equal(result.totalPayout, 0);
  assert.equal(result.byStore.length, 2);
  assert.equal(result.byPartner, undefined);
});

test('per_store vs whole: same data crosses threshold differently', () => {
  const rule = { type: 'tiered_percent', basis: 'revenue', rows: [
    { model: 'ALL', tiers: [{ from: 0, to: 100, percent: 0 }, { from: 100, percent: 10 }]}
  ]};
  const rows = [
    { storeId: 'A', machineSerial: 'M1', model: 'S5', rentals: 0, revenue: 80 },
    { storeId: 'B', machineSerial: 'M2', model: 'S5', rentals: 0, revenue: 80 },
  ];
  const ws = evaluateRun({ rule, rows, aggregationMode: 'whole' });
  // 160 total, 60 above × 10% = 6
  assert.equal(ws.totalPayout, 6);
});
