import { snapshotPairedText, snapshotPairedTextList, snapshotItem } from './paired-text.js';
// A contract is a shared identity, not a payload wrapper. Structured contracts
// may supply a validator/snapshot for Pipeline admission before queueing.
export const portContract = (name, snapshot) => Object.freeze({ name, ...(snapshot ? { snapshot } : {}) });

// Unions accept concrete outputs only. Nesting flattens by shared identity; a
// union itself can never be emitted, even to another union or ANY.
const unions = new WeakMap();
export const isInputUnion = contract => unions.has(contract);
export const inputOnlyContract = contract => contract === ANY || isInputUnion(contract);
export function inputUnion(...contracts) {
  const members = [...new Set(contracts.flatMap(contract => unions.get(contract) || [contract]))];
  if (!members.length || members.some(contract => !contract || typeof contract !== 'object'
      || typeof contract.name !== 'string' || contract === ANY || contract === ITEM)) {
    throw TypeError('An input union needs concrete contracts.');
  }
  const union = portContract(members.map(contract => contract.name).join(' | '));
  unions.set(union, Object.freeze(members));
  return union;
}
export const TEXT = portContract('text');
export const NUMBER = portContract('number');
export const KEYED_PAIRED_TEXT = portContract('keyed_paired_text');
export const KEYED_PAIRED_TEXT_LIST = portContract('keyed_paired_text_list');
// Accepting union only: concrete consumers never accept ITEM implicitly.
export const ITEM = portContract('item');
// Sink-only arrival contract; never a legal output contract.
export const ANY = portContract('any');
export const compatiblePorts = (output, input) => !!output &&
  !inputOnlyContract(output) && (input === ANY || output === input || unions.get(input)?.includes(output) || (input === ITEM && [TEXT, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST].includes(output)));

// Snapshot the new structured contracts before queueing or fan-out. For an ITEM
// edge, validate the declared concrete source too (TEXT cannot carry a pair).
export function snapshotPortValue(contract, value) {
  if (contract === KEYED_PAIRED_TEXT) return snapshotPairedText(value);
  if (contract === KEYED_PAIRED_TEXT_LIST) return snapshotPairedTextList(value);
  if (contract === ITEM) return snapshotItem(value);
  if (contract === TEXT && typeof value !== 'string') throw TypeError('TEXT expects a string.');
  return contract?.snapshot ? contract.snapshot(value) : value;
}
