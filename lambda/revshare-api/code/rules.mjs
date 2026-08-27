// Rule construction, pure. No AWS imports — used by the merchant-sheet importer
// (contracts.mjs) and by routes/import.mjs. It lived in routes/import.mjs until 2026-08-27;
// moving it here is what lets the sheet carry payout terms without contracts.mjs, which must
// stay pure and unit-testable, depending on db.mjs.
// Rule shape: comparable terms (GP / Placement / Others) + optional per-device-type MG
// floor, combined per `method`. Electricity is a cost reimbursement — it never competes
// in a max(), it is added to whatever the comparison settles on.
// Leaves tagged (_t/_m) and the root tagged (_method) so the editor can decompile exactly.
// Keep in lockstep with compileRule in frontend/app.js.
export function compileRule({ gpPercent, electricity, placementRows, mgRows, others, method }) {
  const gpLeaf = Number(gpPercent) > 0
    ? { type: 'percent', _t: 'gp', _m: 'add', rows: [{ model: 'ALL', percent: Number(gpPercent) }] } : null;
  const elecLeaf = Number(electricity) > 0
    ? { type: 'flat_per_partner_total', _t: 'elec', _m: 'add', amount: Number(electricity) } : null;
  const vp = (placementRows || []).filter(r => r.model && Number(r.amount) > 0);
  const placementLeaf = vp.length
    ? { type: 'flat_per_machine', _t: 'placement', _m: 'add', rows: vp.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;
  const othersLeaf = Number(others) > 0
    ? { type: 'flat_per_partner_total', _t: 'others', _m: 'add', amount: Number(others) } : null;
  const vmg = (mgRows || []).filter(r => r.model && Number(r.amount) > 0);
  const mgLeaf = vmg.length
    ? { type: 'flat_per_machine', _t: 'mg', rows: vmg.map(r => ({ model: r.model, amount: Number(r.amount) })) } : null;

  const cmpTerms = [gpLeaf, placementLeaf, othersLeaf].filter(Boolean);   // electricity excluded
  const allTerms = [gpLeaf, elecLeaf, placementLeaf, othersLeaf].filter(Boolean);

  // No explicit method (the /import/rev-share caller) → infer as before.
  const m = ['default', 'hybrid', 'higher', 'hybrid-higher'].includes(method)
    ? method
    : (mgLeaf ? 'hybrid-higher' : (allTerms.length <= 1 ? 'default' : 'hybrid'));

  const zero = () => ({ type: 'percent', _t: 'gp', rows: [{ model: 'ALL', percent: 0 }] });
  const nest = (type, list) => list.length === 0 ? null : (list.length === 1 ? list[0] : { type, children: list });
  const addElec = core => elecLeaf ? (core ? { type: 'sum', children: [core, elecLeaf] } : elecLeaf) : (core || zero());

  let rule;
  if (m === 'higher') {
    rule = addElec(nest('max', mgLeaf ? [...cmpTerms, mgLeaf] : cmpTerms));
  } else if (m === 'hybrid-higher') {
    const s = nest('sum', cmpTerms);
    rule = addElec(mgLeaf ? (s ? { type: 'max', children: [s, mgLeaf] } : mgLeaf) : s);
  } else {
    rule = nest('sum', allTerms) || zero();   // default | hybrid — MG not used
  }
  return { ...rule, _method: m };
}

// A one-line text form of the terms lived here between 2026-08-27 and the same day: the sheet
// briefly carried "GP 25% + Placement S8 100" in a single column. It was replaced by one column
// per term and per machine model, which is what the Merchant view's Edit terms dialog already
// used — free text was too coarse to edit and could fail to parse.
