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

export class LiveTextDisplayNode {
  inputs = { replace: TEXT, append: TEXT };
  outputs = {};
  constructor(onDisplay = () => {}, { appendConnected = false } = {}) { this.onDisplay = onDisplay; this.appendConnected = appendConnected; this.preview = ''; this.items = []; }
  publish() { this.onDisplay({ preview: this.preview, items: [...this.items] }); }
  start() { this.publish(); }
  receiveInputs(values, context) {
    if (context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('LiveTextDisplay expects TEXT inputs.');
    }
    // Append wins in a directly grouped emission regardless of key order.
    // Every append is a new item (including empty/repeated text), and consumes
    // the pending preview. Separate later replace emissions start a new preview.
    if (Object.hasOwn(values, 'replace')) this.preview = values.replace;
    if (Object.hasOwn(values, 'append')) { this.items.push(values.append); this.preview = ''; }
    this.publish();
  }
  receive(port, value, context) { return this.receiveInputs({ [port]: value }, context); }
  clearPreview() { this.preview = ''; this.publish(); }
  finish() { if (this.appendConnected) this.clearPreview(); }
  stop() { this.finish(); }
  dispose() { this.finish(); }
}
