import { TEXT, ANY } from './port-contracts.js';

// Resolve before topology/routing is built, from graph connections rather than
// settings or the arrival/payload of a trigger.
export const holdSampledOutputs = connectedInputs => connectedInputs.includes('trigger') ? [] : ['value'];
export class HoldNode {
  inputs = { input: TEXT, trigger: ANY };
  outputs = { value: TEXT };
  sampledOutputs = ['value'];
  sampledOutputsForInputs = holdSampledOutputs;
  value = '';
  hasValue = false;
  constructor({ onState = () => {} } = {}) { this.onState = onState; }
  start(context) {
    this.value = ''; this.hasValue = false;
    this.triggerConnected = context.connectedInputs.includes('trigger');
    if (this.triggerConnected) this.onState('Waiting for first TEXT value; triggers emit nothing.');
  }
  readOutput(port) {
    if (port !== 'value') throw TypeError('Unknown Hold output.');
    return this.value;
  }
  receiveInputs(values, context) {
    // A grouped input+trigger always stores first, regardless of port order.
    if (Object.hasOwn(values, 'input')) {
      if (typeof values.input !== 'string') throw TypeError('Hold expects input: TEXT.');
      this.value = values.input; this.hasValue = true;
      if (this.triggerConnected) this.onState('Ready; TEXT updates are held until a trigger.');
    }
    if (this.triggerConnected && Object.hasOwn(values, 'trigger') && this.hasValue) context.emit('value', this.value);
  }
  receive(port, value, context) {
    if (!Object.hasOwn(this.inputs, port)) throw TypeError('Unknown Hold input.');
    this.receiveInputs({ [port]: value }, context);
  }
  dispose() { this.value = ''; this.hasValue = false; }
}
