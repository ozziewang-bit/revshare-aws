import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseCsv } from '../code/csv.mjs';

test('parseCsv accepts canonical header order', () => {
  const csv = `store_id,machine_serial,model,rentals,revenue
TPE-001,SN-A1,S5,120,36000
TPE-001,SN-A2,T35,40,28000`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    storeId: 'TPE-001', machineSerial: 'SN-A1',
    model: 'S5', rentals: 120, revenue: 36000
  });
});

test('parseCsv accepts permuted header order', () => {
  const csv = `model,rentals,revenue,machine_serial,store_id
S5,120,36000,SN-A1,TPE-001`;
  const rows = parseCsv(csv);
  assert.equal(rows[0].storeId, 'TPE-001');
  assert.equal(rows[0].model, 'S5');
});

test('parseCsv rejects missing required column', () => {
  const csv = `store_id,model,rentals,revenue
TPE-001,S5,120,36000`;
  assert.throws(() => parseCsv(csv), /missing required column: machine_serial/);
});

test('parseCsv rejects non-numeric rentals', () => {
  const csv = `store_id,machine_serial,model,rentals,revenue
TPE-001,SN-A1,S5,abc,36000`;
  assert.throws(() => parseCsv(csv), /row 2.*rentals/);
});

test('parseCsv handles CRLF line endings', () => {
  const csv = "store_id,machine_serial,model,rentals,revenue\r\nTPE-001,SN-A1,S5,1,100\r\n";
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
});

test('parseCsv skips empty trailing rows', () => {
  const csv = `store_id,machine_serial,model,rentals,revenue
TPE-001,SN-A1,S5,1,100

`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
});
