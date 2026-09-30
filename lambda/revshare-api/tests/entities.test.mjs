import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requiredPermission } from '../code/auth.mjs';

// The legal entity a payout is settled with, as a record rather than a string re-typed on every
// contract. ONE ENTITY COVERS MANY BRANDS — Central Pattana holds Central Ladprao, Eastville and
// Westgate; BTS Group holds BTS and Turtle Shop.
//
// The property that matters most is what it does NOT do: `counterParty` is never rewritten and
// never removed, so every contract that exists today keeps reading its own string until someone
// deliberately links it to an entity.

const route = readFileSync(new URL('../code/routes/entities.mjs', import.meta.url), 'utf8');
const contractsRoute = readFileSync(new URL('../code/routes/contracts.mjs', import.meta.url), 'utf8');
const db = readFileSync(new URL('../code/db.mjs', import.meta.url), 'utf8');

test('entity reads are open; writes need manageMerchants', () => {
  assert.equal(requiredPermission('GET', '/entities'), null);
  assert.equal(requiredPermission('PUT', '/entities'), 'manageMerchants');
  assert.equal(requiredPermission('DELETE', '/entities/abc'), 'manageMerchants');
  assert.equal(requiredPermission('GET', '/entities/abc'), null);
});

// The whole reason this record exists: a free-text field split one company in two on a space.
test('a duplicate entity name is refused, ignoring case and spacing', () => {
  const squash = new Function(route.slice(route.indexOf('function squash')) + '\nreturn squash;')();
  assert.equal(squash('บริษัท เอ็มแอนด์ เอ็ม 2007 จำกัด'), squash('บริษัท เอ็มแอนด์เอ็ม 2007 จำกัด'));
  assert.equal(squash('Nai Chan Estate Co., Ltd.'), squash('nai chan estate co., ltd.'));
  assert.notEqual(squash('Boutique Bangkok Sukhuvit 16-2'), squash('Boutique Bangkok Sukhuvit 26-2'));
  assert.match(route, /error: 'name_taken'/);
});

test('an entity must be named', () => {
  assert.match(route, /if \(!name\) return resp\(400, \{ error: 'name_required' \}\)/);
});

// Deleting would not lose the contract's own string, but it would silently unlink brands from a
// grouping someone made. Refused while anything points at it.
test('an entity in use cannot be deleted, and the refusal names who uses it', () => {
  assert.match(route, /error: 'entity_in_use'/);
  assert.match(route, /merchants: used\.slice\(0, 20\)/);
});

// ── The additive guarantee (Ozzie's standing rule, 2026-09-29) ─────────────────────────────
test('counterParty is kept, never replaced by the entity', () => {
  assert.match(contractsRoute, /'entityId',/, 'entityId is writable');
  assert.match(contractsRoute, /'counterParty'/, 'counterParty stays writable and stored');
  assert.doesNotMatch(route, /counterParty\s*[:=]/,
    'the entity routes must never write or clear a contract\'s counterParty');
  assert.doesNotMatch(route, /putContract/,
    'creating or editing an entity must not write a contract at all');
});

test('the entity record stores its name exactly as typed', () => {
  // squash() exists to compare, not to normalise for storage — an entity named with the spacing
  // a company actually uses must keep it, because that string goes on a statement.
  assert.match(route, /e\.name = name;/);
  assert.doesNotMatch(route, /e\.name = squash/);
});

test('db exports every entity helper the routes import by name', () => {
  // A named ESM import of a missing export fails the WHOLE module load — the exact shape that
  // has taken Singapore down three times (§8). db.mjs is never synced, so both regions must
  // define these by hand.
  for (const fn of ['listEntities', 'getEntity', 'putEntity', 'deleteEntity']) {
    assert.ok(db.includes(`export async function ${fn}(`), `db.mjs must export ${fn}`);
  }
});

test('entities are their own row family, not a contract field', () => {
  assert.match(db, /pk: 'ENTITY'/);
  assert.match(db, /sk: `ENTITY#\$\{entity\.entityId\}`/);
});

// ── The UI half ────────────────────────────────────────────────────────────────────────────
const app = readFileSync(new URL('../../../frontend/app.js', import.meta.url), 'utf8');
const grabFn = (n) => {
  const i = app.indexOf(`function ${n}(`);
  if (i < 0) throw new Error('missing ' + n);
  let d = 0;
  for (let k = app.indexOf('{', i); k < app.length; k++) {
    if (app[k] === '{') d++; else if (app[k] === '}') { d--; if (!d) return app.slice(i, k + 1); }
  }
};

// The grid is now a table you READ. Editing is one button, one dialog, one save — a stray click
// on a cell can no longer open an input, and a mistyped value can no longer save on blur.
test('no cell in the merchant grid is editable in place', () => {
  const row = grabFn('contractRowHtml');
  assert.match(row, /const editable = false;/);
  assert.doesNotMatch(row, /EDITABLE_GROUPS\.has/);
});

// The Edit BUTTON is the only way in. Opening the editor from a cell click was the first cut
// and was wrong for the same reason inline editing was: it opens by accident, on a table you are
// mostly reading and selecting text in.
test('the Edit button is the only thing that opens the editor', () => {
  assert.doesNotMatch(app, /if \(td && td\.dataset\.key\) startCellEdit\(td\)/,
    'no inline cell editing');
  assert.doesNotMatch(app, /openContractEditor\(td\.dataset\.id\)/,
    'a cell click must not open the editor');
  assert.match(app, /if \(peBtn\) \{ openContractEditor\(peBtn\.dataset\.id\); return; \}/,
    'the row button opens it');
});

// The whole point of the two categories: this dialog may only touch what a human owns.
test('the editor sends only contract, finance and entity fields', () => {
  const fn = grabFn('openContractEditor');
  assert.match(fn, /col\.group === 'contract' \|\| col\.group === 'finance'/);
  for (const owned of ['merchantName', 'branchCount', 'contactName', 'installedUnits']) {
    assert.ok(!new RegExp(`data-k="${owned}"`).test(fn),
      `${owned} is file-owned and must not appear in the editor`);
  }
});

// Additive rule: linking an entity must not erase the string the contract already carries.
test('picking an entity never clears counterParty', () => {
  const fn = grabFn('openContractEditor');
  assert.match(fn, /body\.entityId = await resolveEntityInput\(card\.querySelector\('#ce-entity'\)\.value\);/);
  assert.ok(!/body\.counterParty/.test(fn), 'the editor must not write counterParty at all');
  assert.match(fn, /does not erase it/, 'and it should say so to the user');
});

test('an unlinked contract still reads its own counterParty', () => {
  // `entityName` delegates to `entityNameOf`, which takes the entity list explicitly so the
  // helpers that already receive `contracts` stay pure. The rule itself is unchanged.
  const fn = grabFn('entityNameOf');
  assert.match(fn, /c\.counterParty/);
  assert.match(fn, /entities \|\| \[\]\)\.find\(x => x\.entityId === id\)/);
  assert.match(grabFn('entityName'), /entityNameOf\(c, ENTITIES\)/);
});

// Filtering reads like the merchant search beside it: type any part of the name. Matching on
// entityName() rather than entityId is deliberate — that helper falls back to the contract's own
// counterParty, so a brand nobody has linked yet is still found by the company it names.
test('the grid filters by entity NAME, matching unlinked rows too', () => {
  const fn = grabFn('paintContracts');
  assert.match(fn, /entityName\(c\)\.toLowerCase\(\)\.includes\(entity\)/);
  assert.match(fn, /\.toLowerCase\(\)\.trim\(\)/, 'the typed value is normalised');
});

test('the entity filter is a text input, right after the merchant search', () => {
  const i = app.indexOf('id="ct-search"');
  const j = app.indexOf('id="ct-entity"');
  const k = app.indexOf('id="ct-status"');
  assert.ok(i > 0 && j > i && k > j, 'order is search, entity, status');
  assert.match(app.slice(j, j + 200), /list="ct-entities"/, 'it offers the entity names');
});

// ── One control that both assigns and creates (2026-09-29) ─────────────────────────────────
// A dropdown can only assign. A separate "new entity" button makes creating one feel like a
// different task from choosing one — which is how a free-text field ended up holding the same
// company spelled two ways.
test('the entity control offers the existing entities and accepts a new name', () => {
  const fn = grabFn('entityPickerHtml');
  assert.match(fn, /list="\$\{id\}-list"/, 'it filters against the entities that exist');
  assert.match(fn, /type a new company to create it/);
  assert.match(fn, /brand\$\{n === 1 \? '' : 's'\}/, 'each option says how many brands it covers');
});

test('a typed name only creates an entity when it is genuinely new', () => {
  const fn = grabFn('resolveEntityInput');
  assert.match(fn, /if \(!name\) return null;/, 'blank means no entity, not a new one');
  assert.match(fn, /toLowerCase\(\)\.replace\(\/\\s\+\/g, ''\)/,
    'matching ignores case and spacing, like the backend refusal');
  assert.match(fn, /if \(found\) return found\.entityId;/);
  assert.match(fn, /method: 'PUT', body: JSON\.stringify\(\{ name \}\)/);
});

test('both dialogs use the one control', () => {
  assert.match(grabFn('openContractEditor'), /entityPickerHtml\('ce-entity'/);
  assert.match(grabFn('openAddFromFile'), /entityPickerHtml\('af-entity'/);
});

// ── The terms viewer must not be a dead end (2026-09-30) ───────────────────────────────────
// "why pavarisa can't edit PMCU terms" — she could: manageMerchants granted, the route allows
// it, PMCU is live with the simplest possible rule. What stopped her was the screen. Every grid
// cell was made inert the day before EXCEPT the Rev terms cell, which opens a READ-ONLY viewer.
// Clicking the thing that most looks like "the terms" gave a window you cannot type in, whose
// only advice pointed at a column label ("Edit terms") that had been renamed to "Edit".
test('the read-only terms viewer offers a way to edit', () => {
  const fn = grabFn('openTermsView');
  assert.match(fn, /id="ct-tv-edit"/);
  assert.match(fn, /close\(\); openContractEditor\(contractId\);/);
  assert.match(fn, /can\('manageMerchants'\) \?/, 'and only to someone who may');
});

test('it no longer points at a column label that does not exist', () => {
  const fn = grabFn('openTermsView');
  assert.ok(!/Edit terms<\/strong> at the end of the row/.test(fn));
  assert.match(fn, /contract, finance and share terms are changed together/);
});

test('a read-only user is told WHY, not sent somewhere', () => {
  const fn = grabFn('openTermsView');
  assert.match(fn, /needs the “Manage merchants” permission/);
});

// The grid itself still edits nothing — the rule from 2026-09-29 stands.
test('the terms cell still opens the viewer, never the editor', () => {
  assert.match(app, /if \(terms\) \{ openTermsView\(terms\.closest\('tr'\)\.dataset\.id\); return; \}/);
});
