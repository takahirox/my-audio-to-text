import { TEXT } from './port-contracts.js';

// Readable state, never an event source. Pipeline samples it with the next
// ordinary delivery to a consumer; storing a value cannot trigger that consumer.
export class HoldNode {
  inputs = { input: TEXT };
  outputs = { value: TEXT };
  sampledOutputs = ['value'];
  value = '';
  start() { this.value = ''; }
  readOutput(port) {
    if (port !== 'value') throw TypeError('Unknown Hold output.');
    return this.value;
  }
  receive(port, value) {
    if (port !== 'input' || typeof value !== 'string') throw TypeError('Hold expects input: TEXT.');
    this.value = value;
  }
  dispose() { this.value = ''; }
}
