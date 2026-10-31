import { DOM, TEXT } from './port-contracts.js';

// Main-thread, immutable snapshots only. Never send these through a Worker.
// Inert HTML formatting and code-authored CSS are allowed; active content,
// custom elements, resource loads and event/URL attributes are rejected.
const tags = new Set('div span p pre br hr b strong i em u s small sub sup code blockquote ul ol li dl dt dd h1 h2 h3 h4 h5 h6 table caption thead tbody tfoot tr th td style'.split(' '));
export function cloneDOM(value) {
  const NodeClass = value?.ownerDocument?.defaultView?.Node || globalThis.Node;
  if (!NodeClass || !(value instanceof NodeClass)) throw TypeError('DOM expects an actual inert HTML Node or DocumentFragment.');
  function check(node) {
    if (node.nodeType === 3) return;
    if (node.nodeType !== 11) {
      if (node.nodeType !== 1 || node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !tags.has(node.localName)) throw TypeError('DOM contains active or unsupported content.');
      for (const attr of node.attributes) {
        if (!/^(class|role|tabindex|lang|dir|style|colspan|rowspan|scope|aria-[\w-]+)$/.test(attr.name)) throw TypeError('DOM contains an unsupported attribute.');
        if (attr.name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(attr.value)) throw TypeError('DOM CSS must not load resources.');
      }
      if (node.localName === 'style' && /url\s*\(|@import|expression\s*\(/i.test(node.textContent)) throw TypeError('DOM CSS must not load resources.');
    }
    for (const child of node.childNodes) check(child);
  }
  check(value);
  return value.cloneNode(true);
}

export class TextToDOMNode {
  inputs = { text: TEXT };
  outputs = { dom: DOM };
  constructor({ className = '' } = {}) {
    if (typeof className !== 'string') throw TypeError('TextToDOM className must be a string.');
    this.className = className;
  }
  receive(port, value, context) {
    if (context.signal.aborted) return;
    if (port !== 'text' || typeof value !== 'string') throw TypeError('TextToDOM expects text: TEXT.');
    const snapshot = document.createElement('div');
    if (this.className) snapshot.className = this.className;
    snapshot.style.whiteSpace = 'pre-wrap'; snapshot.style.overflowWrap = 'anywhere';
    snapshot.textContent = value;
    context.emit('dom', snapshot);
  }
}

const pairedCSS = `
.paired-text-dom { width: 100%; border-collapse: collapse; table-layout: fixed; white-space: normal; }
.paired-text-dom td { width: 50%; padding: .6em; vertical-align: top; text-align: start; }
.paired-text-dom td { white-space: pre-wrap; overflow-wrap: anywhere; border-block-start: 1px solid #8886; }
.paired-text-dom tbody tr:hover > td, .paired-text-dom tbody tr:focus-within > td { background: #8883; }
.paired-text-dom td:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
`;

export class PairedTextToDOMNode {
  inputs = { input1: TEXT, input2: TEXT };
  outputs = { dom: DOM };
  start() { this.values = { input1: '', input2: '' }; this.closed = false; }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('PairedTextToDOM expects TEXT inputs.');
    }
    if (!Object.keys(values).length) return;
    // Explicit groups are producer snapshots: clear omitted siblings only in
    // that family. Independent deliveries retain the other side's latest text.
    for (const port of context.groupInputs || []) if (Object.hasOwn(this.inputs, port)) this.values[port] = '';
    Object.assign(this.values, values);
    this.render(this.values, context);
  }
  receive(port, value, context) { return this.receiveInputs({ [port]: value }, context); }
  render(pair, context) {
    const snapshot = document.createDocumentFragment(), style = document.createElement('style');
    style.textContent = pairedCSS;
    const table = document.createElement('table'); table.className = 'paired-text-dom';
    table.setAttribute('aria-label', 'Paired texts');
    // Each snapshot is a complete, headerless pair. A generic accumulator can
    // stack snapshots without duplicating column headings or joining tables.
    const body = document.createElement('tbody'), row = document.createElement('tr');
    for (const [label, text] of [['First text', pair.input1], ['Second text', pair.input2]]) {
      const cell = document.createElement('td'); cell.tabIndex = 0;
      cell.setAttribute('aria-label', `${label}: ${text}`); cell.textContent = text; row.append(cell);
    }
    body.append(row);
    table.append(body); snapshot.append(style, table); context.emit('dom', snapshot);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}

// Own both the retained tree and every emitted snapshot. Appending a fragment
// must never consume the producer's nodes or let a consumer mutate history.
export class DOMAccumulatorNode {
  inputs = { append: DOM };
  outputs = { dom: DOM };
  start(context) {
    this.committed = document.createDocumentFragment(); this.closed = false;
    context.emit('dom', cloneDOM(this.committed));
  }
  receive(port, value, context) {
    if (this.closed || context.signal.aborted) return;
    if (port !== 'append') throw TypeError('DOMAccumulator expects append: DOM.');
    this.committed.append(cloneDOM(value));
    context.emit('dom', cloneDOM(this.committed));
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}

// Two replacement snapshots, with no knowledge of their producers or content.
export class DOMCombinerNode {
  inputs = { first: DOM, second: DOM };
  outputs = { dom: DOM };
  start(context) {
    this.snapshots = {}; this.closed = false;
    context.emit('dom', document.createDocumentFragment());
  }
  receive(port, value, context) {
    if (this.closed || context.signal.aborted) return;
    if (!Object.hasOwn(this.inputs, port)) throw TypeError('DOMCombiner expects first/second: DOM.');
    this.snapshots[port] = cloneDOM(value);
    const combined = document.createDocumentFragment();
    for (const input of ['first', 'second']) {
      if (this.snapshots[input]) combined.append(cloneDOM(this.snapshots[input]));
    }
    context.emit('dom', combined);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; this.snapshots = {}; }
}
