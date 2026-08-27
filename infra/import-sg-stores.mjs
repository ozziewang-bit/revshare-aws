#!/usr/bin/env node
// Load Singapore's 1,223 store rows into RevsharePartnerSG as MERCHANT (store-registry) rows,
// each pointed at the CONTRACT that import-sg-revshare.mjs created for it.
//
// Why it matters even though no screen shows these rows: at run time applyMerchantRoster looks
// up each roster store BY NAME in this registry and reuses its merchantId. With an empty
// registry every SG roster upload would mint fresh rows — the duplication that took Thailand
// from 4,066 to 6,661 rows. Seeding it now means the first real roster matches instead.
//
// Also the only home for per-store facts the contract has no field for: address, the RFA
// reference, the internal PIC and the platform entry time all go into the row's notes rather
// than being dropped or, worse, written into a contract field that means something else.
//   node infra/import-sg-stores.mjs <workbook.xlsx> [--apply]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.AWS_REGION ||= 'ap-southeast-7';
process.env.REVSHARE_TABLE ||= 'RevsharePartnerSG';

const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!FILE) { console.error('usage: node infra/import-sg-stores.mjs <workbook.xlsx> [--apply]'); process.exit(1); }

const { listContracts, listMerchants, putMerchantsBatch, ulid } = await import('../lambda/revshare-api/code/db.mjs');
const { MACHINE_MODELS } = await import('../lambda/revshare-api/code/engine.mjs');

const xl = readFileSync(new URL('../frontend/lib/xlsx.full.min.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ console, Date, Math, RegExp, JSON, Buffer, process, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer });
vm.runInContext(xl, ctx);
const wb = ctx.XLSX.read(new Uint8Array(readFileSync(FILE)), { type: 'array' });
const aoa = n => ctx.XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: null, blankrows: false });
const str = v => String(v ?? '').trim();
const norm = x => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const BRAND_TYPES = new Set(['7 Eleven','Cheers','Maxim','RE&S Group','Sentosa','Yunomori',
  'Frasers Retail (Shopping Mall)','Frasers Commercial','Gardens By The Bay (GBB)',
  'Tan Tock Seng Hospital','Four Points Sheraton Hotel']);
const kaNames = aoa('Key Account Payment').filter(r => typeof r[0] === 'number' && str(r[1])).map(r => str(r[1]));
const kaByNorm = new Map(kaNames.map(n => [norm(n), n]));

const cp = aoa('Copy').slice(1).filter(r => str(r[1]));
const typeById = new Map(cp.map(r => [str(r[0]).replace(/\s/g, ''), str(r[3])]));
// entry time. is an Excel serial on some rows and a string on others — keep whatever is there,
// as a note. It is store registration, NOT a contract start date, so it must not become one.
const entryById = new Map(cp.map(r => [str(r[0]).replace(/\s/g, ''), r[5]]));

const contracts = await listContracts();
const byName = new Map(contracts.map(c => [norm(c.merchantName), c]));

const rows = aoa('Small Merchants Lists').slice(1).filter(r => str(r[1]));
const existing = new Map((await listMerchants()).map(m => [m.nameLower, m]));

const plan = [];
const unresolved = [];
for (const r of rows) {
  const id = str(r[0]).replace(/\s/g, '');
  const name = str(r[1]);
  const type = typeById.get(id) || '';
  const brand = BRAND_TYPES.has(type) ? (kaByNorm.get(norm(type)) || type) : name;
  const contract = byName.get(norm(brand));
  if (!contract) { unresolved.push(`${name} -> ${brand}`); continue; }

  const models = str(r[3]).replace(/Advertising Player-/gi, '').split(',').map(x => x.trim()).filter(Boolean);
  const model = models.find(m => MACHINE_MODELS.has(m)) || null;
  const ex = existing.get(norm(name) ? name.toLowerCase().trim() : '');
  const notes = [str(r[2]) && `Address: ${str(r[2])}`,
                 str(r[6]) && `RFA: ${str(r[6])}`,
                 str(r[8]) && `PIC: ${str(r[8])}`,
                 entryById.get(id) != null && `Entry: ${str(entryById.get(id))}`,
                 models.length > 1 && `Devices: ${models.join(', ')}`].filter(Boolean).join(' | ');
  plan.push({ merchantId: ex?.merchantId || ulid(), createdAt: ex?.createdAt, name,
              contractId: contract.contractId, partnerId: null,
              machineModel: model, externalId: id || null, notes });
}

const noModel = plan.filter(p => !p.machineModel).length;
const badModel = new Set(rows.flatMap(r => str(r[3]).replace(/Advertising Player-/gi, '').split(',').map(x => x.trim()))
  .filter(m => m && !MACHINE_MODELS.has(m)));
console.log(`store rows in sheet : ${rows.length}`);
console.log(`resolved to a contract: ${plan.length}`);
console.log(`unresolved          : ${unresolved.length}${unresolved.length ? ' -> ' + unresolved.slice(0, 5).join(', ') : ''}`);
console.log(`with a machine model: ${plan.length - noModel}   without: ${noModel}`);
if (badModel.size) console.log(`device codes NOT in MACHINE_MODELS (would be left null): ${[...badModel].join(', ')}`);
console.log(`already in the registry (would be updated in place): ${plan.filter(p => p.createdAt).length}`);
console.log('\nsamples:');
for (const p of plan.slice(0, 4)) console.log(`  ${p.name.slice(0, 34).padEnd(36)} model=${String(p.machineModel).padEnd(6)} ext=${String(p.externalId).slice(0, 20).padEnd(21)} ${p.notes.slice(0, 60)}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); process.exit(0); }
await putMerchantsBatch(plan);
console.log(`\nwrote ${plan.length} store rows.`);
