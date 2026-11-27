import { TEXT } from '../web/port-contracts.js';

export class FocusedApplicationTextOutputNode {
  inputs = { text: TEXT };
  outputs = {};

  constructor(insert) { this.insert = insert; }

  start(context) { this.signal = context.signal; }

  receive(port, text, context) {
    if (port !== 'text' || typeof text !== 'string') throw TypeError('Focused application output requires TEXT.');
    // Cancel cleanup can have its own signal. It has no authority to insert.
    if (text && context.signal === this.signal && !context.signal.aborted) return this.insert(text);
  }
}
