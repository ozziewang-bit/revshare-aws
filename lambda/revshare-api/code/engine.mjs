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

function evalFlatPerMachine(node, rows) {
  const counts = countByModel(rows);
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  let total = 0;
  for (const row of node.rows) {
    if (row.model === 'ALL') {
      for (const [m, c] of Object.entries(counts))
        if (!explicit.has(m)) total += c * row.amount;
    } else {
      total += (counts[row.model] || 0) * row.amount;
    }
  }
  return total;
}

function applyTiers(amount, tiers) {
  let payout = 0;
  for (const t of tiers) {
    if (amount <= t.from) break;
    const cap = t.to ?? Infinity;
    const slice = Math.min(amount, cap) - t.from;
    if (slice > 0) payout += slice * (t.percent / 100);
  }
  return payout;
}

function evalTieredPercent(node, rows) {
  const sums = sumByModel(rows, node.basis);
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  let total = 0;
  for (const row of node.rows) {
    if (row.model === 'ALL') {
      for (const [m, s] of Object.entries(sums))
        if (!explicit.has(m)) total += applyTiers(s, row.tiers);
    } else {
      total += applyTiers(sums[row.model] || 0, row.tiers);
    }
  }
  return total;
}

function evalPercent(node, rows) {
  const sums = sumByModel(rows, 'revenue');
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  let total = 0;
  for (const row of node.rows) {
    if (row.model === 'ALL') {
      for (const [m, s] of Object.entries(sums))
        if (!explicit.has(m)) total += s * (row.percent / 100);
    } else {
      total += (sums[row.model] || 0) * (row.percent / 100);
    }
  }
  return total;
}

// Validate that flat_per_partner_total only appears in allowed positions in per_store mode.
// Allowed: root, or direct child of root sum.
function validatePerStoreTree(node, depth = 0, parentType = null) {
  if (node.type === 'flat_per_partner_total') {
    // Only allowed at root (depth 0) or as direct child of root sum (depth 1, parent = 'sum')
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
    case 'flat_per_partner_total':
      return node.amount;
    case 'sum': {
      let total = 0;
      for (const child of node.children) total += evalNode(child, rows);
      return total;
    }
    case 'max': {
      return Math.max(...node.children.map(c => evalNode(c, rows)));
    }
    case 'min': {
      return Math.min(...node.children.map(c => evalNode(c, rows)));
    }
    default:
      throw new Error(`unknown rule type: ${node.type}`);
  }
}

export function evaluateRun({ rule, rows, aggregationMode }) {
  if (!rule || typeof rule !== 'object' || !rule.type)
    throw new Error('rule must be a node with a type field');

  if (aggregationMode === 'per_store') {
    validatePerStoreTree(rule);
  }

  const payout = evalNode(rule, rows);
  return { totalPayout: payout };
}
