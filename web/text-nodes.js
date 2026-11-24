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
  constructor({ template = '{1}', inputCount = 4 } = {}, { separatePreviews = false } = {}) {
    this.inputs = formatInputs(inputCount);
    this.parts = parseTemplate(template, inputCount);
    this.values = {};
    // Desktop insertion needs committed inputs even when Live shows previews.
    this.previews = separatePreviews ? {} : null;
  }
  receiveInputs(values, context) {
    if (context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('TextFormatter expects TEXT inputs.');
    }
    // Explicit groups are snapshots of this producer's connected inputs.
    // Omitted siblings clear; independently emitted values retain latest state.
    for (const port of new Set([...(context.groupInputs || []), ...Object.keys(values)])) {
      if (!Object.hasOwn(this.inputs, port)) continue;
      const value = values[port] ?? '';
      if (this.previews && (context.provisionalInputs?.includes(port) ?? context.provisional)) {
        this.previews[port] = value;
      } else {
        this.values[port] = value;
        if (this.previews) delete this.previews[port];
      }
    }
    const snapshot = this.previews && context.provisional ? { ...this.values, ...this.previews } : this.values;
    context.emit('text', this.parts.map(part => typeof part === 'number' ? snapshot[`input${part}`] ?? '' : part).join(''));
  }
  receive(port, value, context) { return this.receiveInputs({ [port]: value }, context); }
}

// Immutable strings can share their existing prefix in JS engines. Keep one
// growing committed string instead of copying an item array on every event.
export class TextAccumulatorNode {
  inputs = { append: TEXT };
  outputs = { text: TEXT };
  constructor() { this.committed = ''; this.count = 0; }
  get text() { return this.committed; }
  start(context) {
    this.committed = ''; this.count = 0; this.canceled = false;
    context.emit('text', '');
  }
  receiveInputs(values, context) {
    if (this.canceled || context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('TextAccumulator expects append: TEXT.');
    }
    if (!Object.hasOwn(values, 'append')) return;
    this.committed += (this.count ? '\n' : '') + values.append;
    this.count++;
    context.emit('text', this.committed);
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  stop() {}
  cancel() { this.canceled = true; return this.committed; }
  dispose() { this.cancel(); }
}
