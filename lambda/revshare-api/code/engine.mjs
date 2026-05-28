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

function evalPercent(node, rows) {
  const sums = sumByModel(rows, 'revenue');
  const explicit = new Set(node.rows.map(r => r.model).filter(m => m !== 'ALL'));
  const allRow = node.rows.find(r => r.model === 'ALL');
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

function evalNode(node, rows) {
  switch (node.type) {
    case 'flat_per_machine':
      return evalFlatPerMachine(node, rows);
    case 'percent':
      return evalPercent(node, rows);
    default:
      throw new Error(`unknown rule type: ${node.type}`);
  }
}

export function evaluateRun({ rule, rows, aggregationMode }) {
  if (!rule || typeof rule !== 'object' || !rule.type)
    throw new Error('rule must be a node with a type field');

  const payout = evalNode(rule, rows);
  return { totalPayout: payout };
}
