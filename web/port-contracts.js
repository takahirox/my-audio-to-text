import { snapshotPairedText, snapshotPairedTextList, snapshotItem } from './paired-text.js';
// A contract is a shared identity, not a payload wrapper.
export const portContract = name => Object.freeze({ name });
export const TEXT = portContract('text');
export const NUMBER = portContract('number');
export const KEYED_PAIRED_TEXT = portContract('keyed_paired_text');
export const KEYED_PAIRED_TEXT_LIST = portContract('keyed_paired_text_list');
// Accepting union only: concrete consumers never accept ITEM implicitly.
export const ITEM = portContract('item');
export const VIEW = portContract('view');
export const DOM = portContract('dom');
export const compatiblePorts = (output, input) => !!output &&
  (output === input || (input === ITEM && [TEXT, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST].includes(output)));

// Snapshot the new structured contracts before queueing or fan-out. For an ITEM
// edge, validate the declared concrete source too (TEXT cannot carry a pair).
export function snapshotPortValue(contract, value) {
  if (contract === KEYED_PAIRED_TEXT) return snapshotPairedText(value);
  if (contract === KEYED_PAIRED_TEXT_LIST) return snapshotPairedTextList(value);
  if (contract === ITEM) return snapshotItem(value);
  if (contract === TEXT && typeof value !== 'string') throw TypeError('TEXT expects a string.');
  return value;
}
