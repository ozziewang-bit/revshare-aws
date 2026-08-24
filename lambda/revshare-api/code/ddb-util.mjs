// DynamoDB pagination, as a pure helper. No AWS imports — the caller injects `send`, so this
// is unit-tested without the SDK.
//
// A Query/Scan returns at most 1MB of items per call and sets LastEvaluatedKey when there is
// more. Every list function in db.mjs used to read `out.Items` from a single call and return
// it, silently dropping everything past the first page. That is not a theoretical limit: with
// 6,142 MERCHANT rows the first page held 2,289, so applyMerchantRoster saw ~3,800 existing
// stores as new and wrote a duplicate row for each — 2,076 junk rows on 2026-08-20 alone, and
// ~4,000 needless PutItems that pushed /bulk-runs/prepare past its 30s Lambda timeout.
// Anything that lists a whole row family MUST go through here.
export async function queryAll(send, params) {
  const items = [];
  let start;
  do {
    // Fresh object per page: never mutate the caller's params.
    const out = await send(start ? { ...params, ExclusiveStartKey: start } : params);
    if (out?.Items) items.push(...out.Items);
    start = out?.LastEvaluatedKey;
  } while (start);
  return items;
}

// Group items into BatchWriteItem-sized chunks, collapsing repeated keys.
//
// BatchWriteItem rejects the WHOLE batch if two requests target the same key ("Provided list
// of item keys contains duplicates"), so this is not optional. Two roster rows can share a
// store name and therefore resolve to the same merchantId; the previous one-PutItem-per-row
// code simply let the second overwrite the first, so the last value must win here too.
export function chunkUnique(items, keyOf, size = 25) {
  const byKey = new Map();
  for (const item of items) byKey.set(keyOf(item), item);   // insertion order, last value wins
  const chunks = [];
  const unique = [...byKey.values()];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}
