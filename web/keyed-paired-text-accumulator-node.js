import { KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST } from './port-contracts.js';
import { snapshotPairedText, snapshotPairedTextList } from './paired-text.js';

export class KeyedPairedTextAccumulatorNode {
  inputs = { pair: KEYED_PAIRED_TEXT };
  outputs = { pairs: KEYED_PAIRED_TEXT_LIST };
  start(context) {
    this.signal = context.signal; this.closed = false; this.pairs = new Map();
    context.emit('pairs', snapshotPairedTextList([]));
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted || context.signal !== this.signal) return;
    if (Object.keys(values).some(port => port !== 'pair')) throw TypeError('KeyedPairedTextAccumulator accepts only pair: KEYED_PAIRED_TEXT.');
    if (!Object.hasOwn(values, 'pair')) return;
    const pair = snapshotPairedText(values.pair);
    this.pairs.set(pair.id, pair);
    context.emit('pairs', snapshotPairedTextList([...this.pairs.values()]));
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
