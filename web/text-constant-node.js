import { TEXT } from './port-contracts.js';

export class TextNode {
  inputs = {};
  outputs = { value: TEXT };
  constructor({ value = '' } = {}) {
    if (typeof value !== 'string') throw new TypeError('Text.value must be a string.');
    this.value = value;
  }
  start(context) { context.emit('value', this.value); }
}
