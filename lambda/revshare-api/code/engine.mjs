export const MACHINE_MODELS = new Set(['S5','S8','S10','T8','T10','T20','T35','L20','L40']);

export function evaluateRun({ rule, rows, aggregationMode }) {
  if (!rule || typeof rule !== 'object' || !rule.type)
    throw new Error('rule must be a node with a type field');
  return { totalPayout: 0 };
}
