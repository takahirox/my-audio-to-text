// Portable values contain data properties only. Copies are deeply frozen so
// retained emissions and fan-out consumers own independent complete snapshots.
export function snapshotPairedText(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 3 || !['id', 'first', 'second'].every(key => {
        const field = Object.getOwnPropertyDescriptor(value, key);
        return field?.enumerable && Object.hasOwn(field, 'value');
      }) || typeof value.id !== 'number' || !Number.isFinite(value.id) ||
      typeof value.first !== 'string' || typeof value.second !== 'string') {
    throw TypeError('KEYED_PAIRED_TEXT expects exactly { id: finite NUMBER, first: TEXT, second: TEXT }.');
  }
  return Object.freeze({ id: value.id, first: value.first, second: value.second });
}
export function snapshotPairedTextList(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1) throw TypeError('KEYED_PAIRED_TEXT_LIST expects a plain dense array.');
  const ids = new Set(), pairs = [];
  for (let i = 0; i < value.length; i++) {
    const field = Object.getOwnPropertyDescriptor(value, String(i));
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) throw TypeError('KEYED_PAIRED_TEXT_LIST expects data entries.');
    const pair = snapshotPairedText(field.value);
    if (ids.has(pair.id)) throw TypeError('KEYED_PAIRED_TEXT_LIST IDs must be unique.');
    ids.add(pair.id); pairs.push(pair);
  }
  return Object.freeze(pairs);
}
export function snapshotItem(value) {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? snapshotPairedTextList(value) : snapshotPairedText(value);
}
