export const MACHINE_MODELS = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);

// Count machines by model
function countByModel(rows) {
  const counts = {};
  for (const row of rows) {
    counts[row.model] = (counts[row.model] || 0) + 1;
  }
  return counts;
}

// Sum a numeric field by model
function sumByModel(rows, field) {
  const sums = {};
  for (const row of rows) {
    sums[row.model] = (sums[row.model] || 0) + row[field];
  }
  return sums;
}

// Returns { payout, components: [{ leafType, payout, modelRowsContributed }] }
function evalFlatPerMachine(node, rows) {
  const counts = countByModel(rows);
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  let payout = 0;
  const modelRowsContributed = [];
  for (const row of node.rows) {
    if (row.model === 'ALL') {
      for (const [m, c] of Object.entries(counts)) {
        if (!explicit.has(m)) {
          const contribution = c * row.amount;
          payout += contribution;
          modelRowsContributed.push({ model: m, count: c, amount: row.amount, payout: contribution });
        }
      }
    } else {
      const count = counts[row.model] || 0;
      const contribution = count * row.amount;
      payout += contribution;
      modelRowsContributed.push({ model: row.model, count, amount: row.amount, payout: contribution });
    }
  }
  const component = { leafType: 'flat_per_machine', payout, modelRowsContributed };
  return { payout, components: [component] };
}

function applyTiers(amount, tiers) {
  let payout = 0;
  const tiersHit = [];
  for (const t of tiers) {
    if (amount <= t.from) {
      tiersHit.push({ from: t.from, to: t.to, percent: t.percent, payoutPart: 0 });
      continue;
    }
    const cap = t.to ?? Infinity;
    const slice = Math.min(amount, cap) - t.from;
    const payoutPart = slice > 0 ? slice * (t.percent / 100) : 0;
    payout += payoutPart;
    tiersHit.push({ from: t.from, to: t.to, percent: t.percent, payoutPart });
  }
  return { payout, tiersHit };
}

function evalTieredPercent(node, rows) {
  const sums = sumByModel(rows, node.basis);
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  let payout = 0;
  const modelRowsContributed = [];

  for (const row of node.rows) {
    if (row.model === 'ALL') {
      for (const [m, s] of Object.entries(sums)) {
        if (!explicit.has(m)) {
          const { payout: rowPayout, tiersHit } = applyTiers(s, row.tiers);
          payout += rowPayout;
          modelRowsContributed.push({ model: 'ALL', basis: node.basis, amount: s, tiersHit });
        }
      }
    } else {
      const amount = sums[row.model] || 0;
      const { payout: rowPayout, tiersHit } = applyTiers(amount, row.tiers);
      payout += rowPayout;
      modelRowsContributed.push({ model: row.model, basis: node.basis, amount, tiersHit });
    }
  }

  const component = { leafType: 'tiered_percent', payout, modelRowsContributed };
  return { payout, components: [component] };
}

function evalPercent(node, rows) {
  const sums = sumByModel(rows, 'revenue');
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  let payout = 0;
  const modelRowsContributed = [];

  for (const row of node.rows) {
    if (row.model === 'ALL') {
      for (const [m, s] of Object.entries(sums)) {
        if (!explicit.has(m)) {
          const contribution = s * (row.percent / 100);
          payout += contribution;
          modelRowsContributed.push({ model: m, revenue: s, percent: row.percent, payout: contribution });
        }
      }
    } else {
      const revenue = sums[row.model] || 0;
      const contribution = revenue * (row.percent / 100);
      payout += contribution;
      modelRowsContributed.push({ model: row.model, revenue, percent: row.percent, payout: contribution });
    }
  }

  const component = { leafType: 'percent', payout, modelRowsContributed };
  return { payout, components: [component] };
}

// Validate that flat_per_partner_total only appears in allowed positions in per_store mode.
// Allowed: root, or direct child of root sum.
function validatePerStoreTree(node, depth = 0, parentType = null) {
  if (node.type === 'flat_per_partner_total') {
    if (depth > 0 && !(depth === 1 && parentType === 'sum')) {
      throw new Error(
        'flat_per_partner_total is not allowed in per_store mode except at root or as direct child of root sum'
      );
    }
  }
  if (node.children) {
    for (const child of node.children) {
      validatePerStoreTree(child, depth + 1, node.type);
    }
  }
}

function evalNode(node, rows) {
  switch (node.type) {
    case 'flat_per_machine':
      return evalFlatPerMachine(node, rows);
    case 'percent':
      return evalPercent(node, rows);
    case 'tiered_percent':
      return evalTieredPercent(node, rows);
    case 'flat_per_partner_total': {
      const component = { leafType: 'flat_per_partner_total', payout: node.amount, modelRowsContributed: [] };
      return { payout: node.amount, components: [component] };
    }
    case 'sum': {
      let total = 0;
      const allComponents = [];
      for (const child of node.children) {
        const { payout, components } = evalNode(child, rows);
        total += payout;
        allComponents.push(...components);
      }
      return { payout: total, components: allComponents };
    }
    case 'max': {
      const results = node.children.map(c => evalNode(c, rows));
      const maxResult = results.reduce((best, cur) => cur.payout > best.payout ? cur : best);
      return maxResult;
    }
    case 'min': {
      const results = node.children.map(c => evalNode(c, rows));
      const minResult = results.reduce((best, cur) => cur.payout < best.payout ? cur : best);
      return minResult;
    }
    default:
      throw new Error(`unknown rule type: ${node.type}`);
  }
}

// Split top-level flat_per_partner_total leaves out of the rule for per_store mode
function splitTopLevel(rule) {
  if (rule.type === 'flat_per_partner_total')
    return { perStoreRule: null, topLevelLeaves: [rule] };
  if (rule.type === 'sum') {
    const topLevel = [], keep = [];
    for (const c of rule.children) (c.type === 'flat_per_partner_total' ? topLevel : keep).push(c);
    if (!keep.length) return { perStoreRule: null, topLevelLeaves: topLevel };
    return { perStoreRule: { type: 'sum', children: keep }, topLevelLeaves: topLevel };
  }
  return { perStoreRule: rule, topLevelLeaves: [] };
}

// Group rows by storeId
function groupByStore(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.storeId)) groups.set(row.storeId, []);
    groups.get(row.storeId).push(row);
  }
  return groups;
}

// Count all machines by model across all rows
function totalMachineCounts(rows) {
  return countByModel(rows);
}

export function evaluateRun({ rule, rows, aggregationMode }) {
  if (!rule || typeof rule !== 'object' || !rule.type)
    throw new Error('rule must be a node with a type field');

  if (aggregationMode === 'per_store') {
    validatePerStoreTree(rule);

    const { perStoreRule, topLevelLeaves } = splitTopLevel(rule);
    const storeGroups = groupByStore(rows);
    const byStore = [];
    let storeTotal = 0;
    for (const [storeId, storeRows] of storeGroups) {
      const { payout, components } = perStoreRule ? evalNode(perStoreRule, storeRows) : { payout: 0, components: [] };
      storeTotal += payout;
      byStore.push({ storeId, payout, components });
    }

    // Evaluate top-level leaves once across all rows
    let topLevelPayout = 0;
    let topLevelComponents = [];
    for (const leaf of topLevelLeaves) {
      const { payout, components } = evalNode(leaf, rows);
      topLevelPayout += payout;
      topLevelComponents.push(...components);
    }

    const total = storeTotal + topLevelPayout;
    const machineCounts = totalMachineCounts(rows);
    const result = { totalPayout: total, byStore, machineCounts };
    if (topLevelLeaves.length > 0) {
      result.topLevel = { payout: topLevelPayout, components: topLevelComponents };
    }
    return result;

  } else {
    // whole aggregation
    const { payout, components } = evalNode(rule, rows);
    const machineCounts = totalMachineCounts(rows);
    return { totalPayout: payout, byPartner: { payout, components }, machineCounts };
  }
}
