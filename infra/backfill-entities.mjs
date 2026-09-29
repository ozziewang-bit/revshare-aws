#!/usr/bin/env node
// Create one ENTITY record per distinct `counterParty` and link its contracts.
//
//   REVSHARE_TABLE=RevsharePartner AWS_REGION=ap-southeast-7 node infra/backfill-entities.mjs
//   …same, plus --apply                                      to actually write
//
// ADDITIVE ONLY. This is the rule the whole script is built around:
//   • `counterParty` is never read-modified-written. It stays on every contract exactly as typed.
//   • A contract that already has an `entityId` is left alone — re-running changes nothing.
//   • Only two fields are ever written: a new ENTITY row, and `entityId` on a contract that
//     had none. Everything else on the contract is carried through untouched.
//   • Nothing is MERGED. Entity names that look like the same company are printed for a human
//     to decide, never combined — 'Boutique Bangkok Sukhuvit 16-2' and '26-2' are probably two
//     real SPVs, while two spellings of one Thai company are probably one. A script cannot tell.
//
// Dry run by default; prints the whole mapping so the write is reviewed before it happens.

const APPLY = process.argv.includes('--apply');
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';
const REGION = process.env.AWS_REGION || 'ap-southeast-7';

// AWS_REGION must be set before db.mjs is imported — it reads it at module scope.
process.env.AWS_REGION = REGION;
process.env.REVSHARE_TABLE = TABLE;

const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, UpdateCommand } =
  await import('@aws-sdk/lib-dynamodb');
const { ulid } = await import('ulid');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function queryAll(pk) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'pk = :p',
      ExpressionAttributeValues: { ':p': pk },
      ExclusiveStartKey,
    }));
    out.push(...(r.Items || []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

const squash = s => String(s || '').toLowerCase().replace(/\s+/g, '');
const norm = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function similarity(a, b) {
  if (a === b) return 1;
  const [s, l] = a.length > b.length ? [b, a] : [a, b];
  if (!l.length) return 1;
  let hits = 0;
  const used = new Array(l.length).fill(false);
  for (const ch of s) {
    const i = l.split('').findIndex((c, j) => !used[j] && c === ch);
    if (i >= 0) { used[i] = true; hits++; }
  }
  return hits / l.length;
}

const contracts = await queryAll('CONTRACT');
const entities = await queryAll('ENTITY');
const live = contracts.filter(c => !c.archived);

console.log(`table ${TABLE} · region ${REGION} · ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  contracts        : ${contracts.length} (${live.length} live)`);
console.log(`  entities already : ${entities.length}`);

// Existing entities win — re-running never mints a second record for a name already present.
const byKey = new Map(entities.map(e => [squash(e.name), e]));

// Group LIVE contracts by their counterParty string. Archived rows keep their string and are
// left entirely alone: linking an ended contract to an entity records a relationship nobody
// asked for, and the Merchant view excludes them anyway.
const groups = new Map();
let noEntity = 0, alreadyLinked = 0;
for (const c of live) {
  if (c.entityId) { alreadyLinked++; continue; }
  const name = String(c.counterParty || '').trim();
  if (!name) { noEntity++; continue; }
  const k = squash(name);
  if (!groups.has(k)) groups.set(k, { name, contracts: [] });
  groups.get(k).contracts.push(c);
}

const creates = [], links = [];
for (const [k, g] of groups) {
  const existing = byKey.get(k);
  const entityId = existing ? existing.entityId : ulid();
  if (!existing) creates.push({ entityId, name: g.name, brands: g.contracts.length });
  for (const c of g.contracts) links.push({ contractId: c.contractId, merchantName: c.merchantName, entityId, entityName: g.name });
}

console.log(`\nplan`);
console.log(`  entities to create        : ${creates.length}`);
console.log(`  contracts to link         : ${links.length}`);
console.log(`  already linked (skipped)  : ${alreadyLinked}`);
console.log(`  live contracts with NO counterParty (left alone): ${noEntity}`);

const multi = creates.filter(c => c.brands > 1).sort((a, b) => b.brands - a.brands);
console.log(`\n  entities covering more than one brand: ${multi.length}`);
for (const m of multi) {
  const brands = links.filter(l => l.entityId === m.entityId).map(l => l.merchantName);
  console.log(`    ${String(m.brands).padStart(2)} brands  ${m.name}`);
  console.log(`              ${brands.join(', ')}`);
}

// Names that look like one company written two ways. NOT merged — printed only.
const names = creates.map(c => c.name);
const pairs = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const r = similarity(norm(names[i]), norm(names[j]));
    if (r >= 0.9) pairs.push([r, names[i], names[j]]);
  }
}
if (pairs.length) {
  console.log(`\n  ⚠ ${pairs.length} pair(s) look like the same company. NOT merged — decide by hand:`);
  for (const [r, a, b] of pairs.sort((x, y) => y[0] - x[0])) {
    console.log(`    ${r.toFixed(3)}  ${a}`);
    console.log(`           ${b}`);
  }
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to write.`);
  process.exit(0);
}

let madeE = 0, madeL = 0;
for (const c of creates) {
  const now = new Date().toISOString();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { pk: 'ENTITY', sk: `ENTITY#${c.entityId}`, entityId: c.entityId, name: c.name,
            nameLower: c.name.toLowerCase().trim(), createdAt: now, updatedAt: now,
            createdBy: 'infra/backfill-entities.mjs' },
    // Never clobber an entity that appeared while this was running.
    ConditionExpression: 'attribute_not_exists(sk)',
  }));
  madeE++;
}
for (const l of links) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { pk: 'CONTRACT', sk: `CONTRACT#${l.contractId}` },
    // SET one attribute, and ONLY if it is still absent. counterParty is not named here at all,
    // so it cannot be touched; and a contract someone linked in the meantime is skipped rather
    // than overwritten.
    UpdateExpression: 'SET entityId = :e',
    ConditionExpression: 'attribute_not_exists(entityId)',
    ExpressionAttributeValues: { ':e': l.entityId },
  })).then(() => { madeL++; }).catch(err => {
    if (err.name !== 'ConditionalCheckFailedException') throw err;
  });
}
console.log(`\nwrote ${madeE} entities, linked ${madeL} contracts. counterParty untouched on all ${contracts.length} rows.`);
