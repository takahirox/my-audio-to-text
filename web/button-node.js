import { NUMBER } from './port-contracts.js';

export const BUTTON_LABEL_MAX_LENGTH = 120;
export function buttonLabel(label = '') {
  if (typeof label !== 'string' || label.length > BUTTON_LABEL_MAX_LENGTH) throw TypeError('Button label must be text of at most 120 characters.');
  return label.trim() || 'Run action';
}
// The UI owns admission; each accepted press is an ordinary typed emission.
export class ButtonNode {
  inputs = {};
  outputs = { trigger: NUMBER };
  start(context) { this.context = context; }
  press() {
    if (!this.context || this.context.signal.aborted || this.closed) return false;
    this.context.emit('trigger', 1);
    return true;
  }
  stop() { this.closed = true; }
  dispose() { this.closed = true; this.context = undefined; }
}
