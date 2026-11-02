import { NUMBER } from './port-contracts.js';

export function finiteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Number.value must be a finite number.');
  return value;
}

// A generic constant source. Consumers own units and domain-specific limits.
export class NumberNode {
  inputs = {};
  outputs = { value: NUMBER };
  constructor({ value = 6 } = {}) { this.value = finiteNumber(value); }
  start(context) { context.emit('value', this.value); }
}

export function validateRowId(id) {
  if (!Number.isSafeInteger(id) || id < 0) throw TypeError('Row ID must be a nonnegative safe integer NUMBER.');
}
