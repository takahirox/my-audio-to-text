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
  receive(port, value, context) {
    if (context.signal.aborted) return;
    if (port !== 'text' || typeof value !== 'string') throw TypeError('TextToDOM expects text: TEXT.');
    const snapshot = document.createElement('div');
    snapshot.style.whiteSpace = 'pre-wrap'; snapshot.style.overflowWrap = 'anywhere';
    snapshot.textContent = value;
    context.emit('dom', snapshot);
  }
}

const pairedCSS = `
.paired-text-dom { width: 100%; border-collapse: collapse; table-layout: fixed; white-space: normal; }
.paired-text-dom th, .paired-text-dom td { width: 50%; padding: .6em; vertical-align: top; text-align: start; }
.paired-text-dom td { white-space: pre-wrap; overflow-wrap: anywhere; border-block-start: 1px solid #8886; }
.paired-text-dom tbody tr:hover > td, .paired-text-dom tbody tr:focus-within > td { background: #8883; }
.paired-text-dom td:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
`;

export class PairedTextToDOMNode {
  inputs = { source: TEXT, text: TEXT, error: TEXT };
  outputs = { dom: DOM };
  constructor() { this.rows = []; }
  start(context) { this.rows = []; this.closed = false; this.render(context); }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError('PairedTextToDOM expects TEXT inputs.');
    }
    // One atomic delivery, never a cache of independently arriving strings.
    if (!['source', 'text'].every(port => context.groupInputs?.includes(port)) ||
        !Object.hasOwn(values, 'source')) {
      throw Error('PairedTextToDOM requires a completed grouped source/text/error result from one producer.');
    }
    // An omitted successful-text sibling signals failure even if error is not
    // connected. Never reuse an earlier translation or drop the source row.
    const error = values.error || (!Object.hasOwn(values, 'text') ? 'No translation returned.' : '');
    this.rows.push({ source: values.source, text: error ? '' : values.text, error });
    this.render(context);
  }
  render(context) {
    const snapshot = document.createDocumentFragment(), style = document.createElement('style');
    style.textContent = pairedCSS;
    const table = document.createElement('table'); table.className = 'paired-text-dom';
    table.setAttribute('aria-label', 'Original and translation comparison');
    const head = document.createElement('thead'), labels = document.createElement('tr');
    for (const label of ['Original', 'Translation']) {
      const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; labels.append(cell);
    }
    head.append(labels); const body = document.createElement('tbody');
    for (const pair of this.rows) {
      const row = document.createElement('tr');
      for (const text of [pair.source, pair.error ? `Translation failed: ${pair.error}` : pair.text]) {
        const cell = document.createElement('td'); cell.tabIndex = 0; cell.textContent = text; row.append(cell);
      }
      body.append(row);
    }
    table.append(head, body); snapshot.append(style, table); context.emit('dom', snapshot);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
