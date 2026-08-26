#!/usr/bin/env node
// Preflight for deploy-lambda-all.sh: does every name the SYNCED code imports from db.mjs
// actually exist in EACH region's db.mjs?
//
// db.mjs is deliberately never synced (it holds each region's table and bucket), but every
// other module IS synced verbatim — and they import from it BY NAME. A named import is a
// static ESM binding: if the target module lacks the export, the module does not partially
// degrade, it fails to load, and every route 500s. This has taken Singapore down three times:
// once for three hours, once for ~2 minutes on DEFAULT_CURRENCY, and again on 2026-08-26 when
// db.mjs was mirrored before getBulkRunInputs existed and never re-mirrored.
//
//   node infra/check-db-exports.mjs <th-code-dir> <sg-code-dir>
//
// Exits non-zero and names the missing exports, so the deploy aborts before it ships.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [thDir, sgDir] = process.argv.slice(2);
if (!thDir || !sgDir) { console.error('usage: check-db-exports.mjs <th-code-dir> <sg-code-dir>'); process.exit(2); }

const sourceFiles = dir => {
  const out = [];
  for (const f of readdirSync(dir)) if (f.endsWith('.mjs') && f !== 'db.mjs') out.push(join(dir, f));
  const routes = join(dir, 'routes');
  if (existsSync(routes)) for (const f of readdirSync(routes)) if (f.endsWith('.mjs')) out.push(join(routes, f));
  return out;
};

// Every NAMED import of db.mjs across the synced code. Namespace imports (import * as db)
// are deliberately ignored: a missing property there degrades to undefined instead of
// failing the load, which is why bulk-runs.mjs reads DEFAULT_CURRENCY that way.
const wanted = new Map();                        // name -> file that imports it
for (const file of sourceFiles(thDir)) {
  const src = readFileSync(file, 'utf8');
  // The path segment must be exactly db.mjs — otherwise this also matches users-db.mjs,
  // which is a different module with its own DynamoDB client.
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](?:[^'"]*\/)?db\.mjs['"]/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) wanted.set(name, file.replace(thDir, ''));
    }
  }
}

const exportsOf = path => {
  const src = readFileSync(path, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm))
    for (const raw of m[1].split(',')) {
      const n = raw.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  return names;
};

let failed = false;
for (const [label, dir] of [['Thailand', thDir], ['Singapore', sgDir]]) {
  const dbPath = join(dir, 'db.mjs');
  if (!existsSync(dbPath)) { console.error(`✗ ${label}: no db.mjs at ${dbPath}`); failed = true; continue; }
  const have = exportsOf(dbPath);
  const missing = [...wanted].filter(([n]) => !have.has(n));
  if (missing.length) {
    failed = true;
    console.error(`✗ ${label} db.mjs is missing ${missing.length} export(s) the synced code imports by name:`);
    for (const [n, f] of missing) console.error(`    ${n}   (imported by ${f})`);
  } else {
    console.log(`✓ ${label} db.mjs exports all ${wanted.size} names the synced code imports.`);
  }
}
if (failed) {
  console.error('\nDeploy aborted. Mirror the missing export(s) into that region\'s db.mjs by hand —');
  console.error('db.mjs is never synced, so a new db function must be added to BOTH repos.');
  process.exit(1);
}
