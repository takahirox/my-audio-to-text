import { TEXT } from './port-contracts.js';

export function formatInputs(inputCount = 4) {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) throw Error('Input count must be a positive whole number.');
  return Object.fromEntries(Array.from({ length: inputCount }, (_, index) => [`input${index + 1}`, TEXT]));
}
export const FORMAT_INPUTS = Object.freeze(formatInputs());
// Only numbered substitutions and doubled-brace escaping. No property access,
// expressions, HTML interpretation, or recursive expansion of input strings.
export function parseTemplate(template, inputCount = 4) {
  if (typeof template !== 'string' || template.length > 2048) throw Error('Template must be text of at most 2048 characters.');
  const parts = [];
  for (let i = 0; i < template.length;) {
    const rest = template.slice(i), token = rest.match(/^(\{\{|\}\}|\{[1-9][0-9]*\})/);
    if (token) {
      if (token[0] !== '{{' && token[0] !== '}}' && Number(token[0].slice(1, -1)) > inputCount) throw Error(`Input ${token[0]} is not configured. Add inputs or edit the template (1–${inputCount}).`);
      parts.push(token[0] === '{{' ? '{' : token[0] === '}}' ? '}' : Number(token[0].slice(1, -1)));
      i += token[0].length;
    } else {
      if ('{}'.includes(template[i])) throw Error(`Use {1}–{${inputCount}} for inputs and {{ / }} for literal braces.`);
      parts.push(template[i++]);
    }
  }
  return parts;
}

export class TextFormatterNode {
  outputs = { text: TEXT };
  constructor({ template = '{1}', inputCount = 4 } = {}) {
    this.inputs = formatInputs(inputCount); this.parts = parseTemplate(template, inputCount); this.values = {};
  }
  receiveInputs(values, context) {
    if (context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('TextFormatter expects TEXT inputs.');
    }
    // Explicit groups are snapshots of this producer's connected inputs.
    // Omitted siblings clear; independently emitted values retain latest state.
    for (const port of context.groupInputs || []) if (Object.hasOwn(this.inputs, port)) this.values[port] = '';
    Object.assign(this.values, values);
    context.emit('text', this.parts.map(part => typeof part === 'number' ? this.values[`input${part}`] ?? '' : part).join(''));
  }
  receive(port, value, context) { return this.receiveInputs({ [port]: value }, context); }
}

// Immutable strings can share their existing prefix in JS engines. Keep one
// growing committed string instead of copying an item array on every event.
export class TextAccumulatorNode {
  inputs = { append: TEXT, preview: TEXT };
  outputs = { text: TEXT };
  constructor() { this.committed = ''; this.count = 0; this.preview = ''; }
  get text() { return this.committed + (this.preview ? (this.count ? '\n' : '') + this.preview : ''); }
  start(context) {
    this.committed = ''; this.count = 0; this.preview = '';
    context.emit('text', '');
  }
  receiveInputs(values, context) {
    if (context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('TextAccumulator expects TEXT inputs.');
    }
    // A grouped append wins regardless of key order. Independent deliveries
    // retain queue order; a later preview starts a new uncommitted tail.
    if (Object.hasOwn(values, 'preview')) this.preview = values.preview;
    if (Object.hasOwn(values, 'append')) {
      this.committed += (this.count ? '\n' : '') + values.append;
      this.count++; this.preview = '';
    }
    context.emit('text', this.text);
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  stop(context) {
    if (context.signal.aborted) return;
    if (this.preview) { this.preview = ''; context.emit('text', this.committed); }
  }
  // Cancel drops pending work without publishing to downstream processors.
  // The session may use this value to restore an immediately connected view.
  cancel() { this.preview = ''; return this.committed; }
  dispose() { this.cancel(); }
}

export class LiveTextDisplayNode {
  inputs = { content: TEXT };
  outputs = {};
  constructor(onDisplay = () => {}) { this.onDisplay = onDisplay; }
  start() { this.onDisplay(''); }
  receive(port, value, context) {
    if (context.signal.aborted) return;
    if (port !== 'content' || typeof value !== 'string') throw TypeError('LiveTextDisplay expects content: TEXT.');
    this.onDisplay(value);
  }
}
