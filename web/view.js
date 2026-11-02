// VIEW is data only: { rows: [{ id?: finite number, cells: [string, ...] }] }.
// No host objects, markup, callbacks or presentation options. Copy and freeze
// every level so queued deliveries and fan-out cannot change another snapshot.
function record(value, allowed, required) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw TypeError('VIEW expects plain records.');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => !allowed.includes(key) || !Object.getOwnPropertyDescriptor(value, key).enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) throw TypeError('Invalid VIEW record fields.');
}
function array(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) throw TypeError('VIEW expects plain dense arrays.');
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i)) || {}, 'value')) throw TypeError('VIEW expects data array entries.');
  }
}
export function snapshotView(value) {
  record(value, ['rows'], ['rows']); array(value.rows);
  const ids = new Set();
  const rows = value.rows.map(row => {
    record(row, ['id', 'cells'], ['cells']); array(row.cells);
    if (!row.cells.length || row.cells.some(cell => typeof cell !== 'string')) throw TypeError('VIEW cells must be a nonempty array of TEXT strings.');
    const copy = { cells: Object.freeze([...row.cells]) };
    if (Object.hasOwn(row, 'id')) {
      if (typeof row.id !== 'number' || !Number.isFinite(row.id) || ids.has(row.id)) throw TypeError('VIEW row IDs must be unique finite numbers.');
      ids.add(row.id); copy.id = row.id;
    }
    return Object.freeze(copy);
  });
  return Object.freeze({ rows: Object.freeze(rows) });
}
