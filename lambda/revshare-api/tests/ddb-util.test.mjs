import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryAll, chunkUnique } from '../code/ddb-util.mjs';

// A DynamoDB Query returns at most 1MB per call and signals more with LastEvaluatedKey.
// db.mjs used to ignore that and return only the first page: with 6,142 MERCHANT rows it
// returned 2,289, so applyMerchantRoster treated ~3,800 existing stores as new and wrote a
// duplicate row for each. 2,076 junk rows were created on 2026-08-20 alone.
test('queryAll follows LastEvaluatedKey until the last page', async () => {
  const pages = [
    { Items: [1, 2], LastEvaluatedKey: { sk: 'a' } },
    { Items: [3, 4], LastEvaluatedKey: { sk: 'b' } },
    { Items: [5] },
  ];
  const seen = [];
  let i = 0;
  const send = async params => { seen.push(params.ExclusiveStartKey); return pages[i++]; };

  const items = await queryAll(send, { TableName: 'T' });

  assert.deepEqual(items, [1, 2, 3, 4, 5]);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen, [undefined, { sk: 'a' }, { sk: 'b' }]);
});

test('queryAll does not mutate the caller params between pages', async () => {
  const params = { TableName: 'T' };
  let i = 0;
  const pages = [{ Items: [1], LastEvaluatedKey: { sk: 'a' } }, { Items: [2] }];
  await queryAll(async () => pages[i++], params);
  assert.deepEqual(params, { TableName: 'T' });
});

test('queryAll handles a single empty page', async () => {
  assert.deepEqual(await queryAll(async () => ({}), {}), []);
});

// BatchWriteItem rejects an entire batch that contains two requests for the same key. Two
// roster rows sharing a store name resolve to the same existing merchantId, so that is a live
// case, not a theoretical one — the old code did one PutItem per row, where the second simply
// overwrote the first. Dedupe must preserve that last-write-wins result.
test('chunkUnique keeps the last value for a repeated key', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 }];
  assert.deepEqual(chunkUnique(rows, r => r.id, 25), [[{ id: 'a', v: 3 }, { id: 'b', v: 2 }]]);
});

test('chunkUnique splits into batches of at most `size`', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ id: String(i) }));
  const chunks = chunkUnique(rows, r => r.id, 3);
  assert.deepEqual(chunks.map(c => c.length), [3, 3, 1]);
  assert.equal(chunks.flat().length, 7);
});

test('chunkUnique on an empty list produces no batches', () => {
  assert.deepEqual(chunkUnique([], r => r.id, 25), []);
});
