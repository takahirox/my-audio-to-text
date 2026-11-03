import { NUMBER, TEXT, KEYED_PAIRED_TEXT } from './port-contracts.js';
import { snapshotPairedText } from './paired-text.js';
import { finiteNumber } from './number-node.js';

export class KeyedTextPairNode {
  inputs = { id1: NUMBER, input1: TEXT, id2: NUMBER, input2: TEXT };
  outputs = { id: NUMBER, input1: TEXT, input2: TEXT, pair: KEYED_PAIRED_TEXT };
  start(context) {
    this.signal = context.signal;
    this.closed = false;
    this.branches = [1, 2].map(() => ({ id: undefined, pending: undefined, values: new Map() }));
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted || context.signal !== this.signal) return;
    // Validate the whole delivery before applying either branch.
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port)) throw TypeError(`Unknown KeyedTextPair input: ${port}.`);
      if (port === 'id1' || port === 'id2') finiteNumber(value, `KeyedTextPair.${port}`);
      else if (typeof value !== 'string') throw TypeError(`KeyedTextPair.${port} expects TEXT.`);
    }
    const affected = new Set();
    for (const n of [1, 2]) {
      const branch = this.branches[n - 1], idPort = `id${n}`, textPort = `input${n}`;
      const hasId = Object.hasOwn(values, idPort), hasText = Object.hasOwn(values, textPort);
      // A grouped payload with an omitted ID cannot borrow a previous key.
      if (hasText && context.groupInputs?.includes(idPort) && !hasId) branch.id = undefined;
      if (hasId) branch.id = values[idPort];
      if (hasText) branch.pending = values[textPort];
      // Only never-applied text waits for an ID. ID-only changes never replay
      // a completed value, clear a pair, or copy text between keys.
      if (branch.id === undefined || branch.pending === undefined) continue;
      branch.values.set(branch.id, branch.pending);
      branch.pending = undefined;
      affected.add(branch.id);
    }
    // Apply both branches first so an atomic group emits once per affected ID.
    for (const id of affected) {
      const first = this.branches[0].values.get(id) ?? '';
      const second = this.branches[1].values.get(id) ?? '';
      context.emitOutputs({ id, input1: first, input2: second, pair: snapshotPairedText({ id, first, second }) });
    }
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
