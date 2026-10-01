#!/usr/bin/env node
// Retire the Thai `L40` device type, and give LL40 the name the platform actually uses.
//
//   REVSHARE_TABLE=RevsharePartner AWS_REGION=ap-southeast-7 node infra/retire-l40.mjs [--apply]
//
// WHY. Device Types held two rows:
//     code L40   displayName "Advertising Player-LL40"      ← the wrong code, the right name
//     code LL40  displayName "LL40"
// The terms editor's model dropdown shows displayName and stores `code`, so picking the one
// labelled "Advertising Player-LL40" stored `L40` — a code the platform has never emitted
// (checked against the raw file: 154 × "Advertising Player-LL40", zero "L40"). A per-machine
// term keyed to it matches no roster row and pays NOTHING. SEACON Bangkae earned 17,200 in
// September and was paid 0; Platinum Fashion Mall earned 2,580 and was paid 0; PMCU's minimum
// guarantee could not fire. That is the bug this removes at its source.
//
// RUN `infra/rekey-models.mjs L40=LL40 --apply` FIRST. This script refuses otherwise, because
// deleting the type while a contract still names it would leave a term pointing at nothing with
// no way to see it in the editor.
//
// Does not touch past runs: their `ruleSnapshots` are frozen and still say L40, which is the
// truth about what they paid (§10.5).
const APPLY = process.argv.includes('--apply');
process.env.AWS_REGION ||= 'ap-southeast-7';
const TABLE = process.env.REVSHARE_TABLE || 'RevsharePartner';

const { listContracts, listMachineModels, putMachineModel, deleteMachineModel } =
  await import('../lambda/revshare-api/code/db.mjs');

const OLD = 'L40', NEW = 'LL40', NAME = 'Advertising Player-LL40';

const contracts = await listContracts();
const naming = contracts.filter(c =>
  Object.keys(c.units || {}).includes(OLD) ||
  JSON.stringify(c.rule || {}).includes(`"model":"${OLD}"`));

console.log(`table ${TABLE} · ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`  contracts still naming ${OLD}: ${naming.length}` +
            (naming.length ? '  ' + naming.map(c => c.merchantName).join(', ') : ''));
if (naming.length) {
  console.error(`\nREFUSING: run  infra/rekey-models.mjs ${OLD}=${NEW} --apply  first.`);
  process.exit(1);
}

const models = await listMachineModels();
const oldRow = models.find(m => m.code === OLD);
const newRow = models.find(m => m.code === NEW);
console.log(`  ${OLD}: ${oldRow ? JSON.stringify(oldRow.displayName) : '(already gone)'}`);
console.log(`  ${NEW}: ${newRow ? JSON.stringify(newRow.displayName) : '(MISSING — would have to be created)'}`);
console.log(`\nplan`);
console.log(`  rename ${NEW} → ${JSON.stringify(NAME)}` + (newRow?.displayName === NAME ? '   (already so)' : ''));
console.log(`  delete device type ${OLD}` + (oldRow ? '' : '   (already gone)'));

if (!APPLY) { console.log(`\nDRY RUN — nothing written. Re-run with --apply.`); process.exit(0); }

await putMachineModel({ code: NEW, displayName: NAME });
if (oldRow) await deleteMachineModel(OLD);
const after = await listMachineModels();
console.log(`\ndevice types now: ${after.map(m => `${m.code}=${JSON.stringify(m.displayName)}`).join('  ')}`);
