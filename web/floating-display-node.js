import { TEXT } from './port-contracts.js';

export class FloatingDisplayNode {
  inputs = { text: TEXT };
  outputs = {};

  constructor(show) { this.show = show; }

  start(context) { this.signal = context.signal; }

  receive(port, text, context) {
    if (port !== 'text' || typeof text !== 'string') throw TypeError('Floating Display requires TEXT.');
    if (context.signal === this.signal && !context.signal.aborted) this.show(text);
  }
}
