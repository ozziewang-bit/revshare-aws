const REQUIRED = ['store_id','machine_serial','model','rentals','revenue'];
const FIELD_MAP = {
  store_id: 'storeId',
  machine_serial: 'machineSerial',
  model: 'model',
  rentals: 'rentals',
  revenue: 'revenue'
};

export function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) throw new Error('CSV is empty');
  const header = parseLine(lines[0]);
  for (const col of REQUIRED) {
    if (!header.includes(col)) throw new Error(`missing required column: ${col}`);
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.length !== header.length) {
      throw new Error(`row ${i + 1}: expected ${header.length} cells, got ${cells.length}`);
    }
    const row = {};
    for (let j = 0; j < header.length; j++) {
      const k = FIELD_MAP[header[j]];
      if (!k) continue;
      row[k] = cells[j];
    }
    const r = Number(row.rentals);
    const v = Number(row.revenue);
    if (!Number.isFinite(r)) throw new Error(`row ${i + 1}: rentals not numeric (${row.rentals})`);
    if (!Number.isFinite(v)) throw new Error(`row ${i + 1}: revenue not numeric (${row.revenue})`);
    row.rentals = r;
    row.revenue = v;
    out.push(row);
  }
  return out;
}

function parseLine(line) {
  // simple split — no quoted-cell support; CSV is controlled operational export
  return line.split(',').map(s => s.trim());
}
