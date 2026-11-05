import { ITEM } from './port-contracts.js';
import { snapshotItem } from './paired-text.js';

export const MAX_DISPLAY_INPUTS = 32;
export function displayInputs(inputCount = 1) {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1 || inputCount > MAX_DISPLAY_INPUTS) {
    throw TypeError(`Display inputCount must be a whole number from 1 to ${MAX_DISPLAY_INPUTS}.`);
  }
  return Object.fromEntries(Array.from({ length: inputCount }, (_, i) => [`input${i + 1}`, ITEM]));
}

// Browser host adapter. Each delivery replaces only its pane's complete snapshot.
export class DisplayNode {
  outputs = {};
  constructor(onDisplay = () => {}, settings = {}) {
    this.onDisplay = onDisplay; this.inputs = displayInputs(settings.inputCount);
  }
  start(context) {
    this.signal = context.signal; this.closed = false;
    for (const port of Object.keys(this.inputs)) this.render([], port);
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted) return;
    // Cancel aborts ordinary work before routing cleanup with a fresh signal.
    // A new running lifecycle still rejects contexts from earlier sessions.
    if (context.signal !== this.signal && !this.signal.aborted) return;
    if (Object.keys(values).some(key => !Object.hasOwn(this.inputs, key))) throw TypeError('Unknown Display input.');
    // Validate every supplied ITEM before delivering any part of a grouped update.
    const snapshots = Object.entries(values).map(([port, value]) => [port, snapshotItem(value)]);
    for (const [port, item] of snapshots) this.render(item, port);
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  render(item, port) {
    const fragment = document.createDocumentFragment();
    if (typeof item === 'string') {
      const text = document.createElement('div'); text.textContent = item;
      text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere'; fragment.append(text);
    } else {
      const pairs = Array.isArray(item) ? item : [item];
      if (pairs.length) {
        const table = document.createElement('table'); table.className = 'display-pairs';
        table.setAttribute('aria-label', 'Text rows');
        table.style.width = '100%'; table.style.tableLayout = 'fixed';
        const body = document.createElement('tbody');
        for (const pair of pairs) {
          const row = document.createElement('tr');
          for (const [index, text] of [pair.first, pair.second].entries()) {
            const cell = document.createElement('td'); cell.textContent = text;
            cell.setAttribute('aria-label', `Text ${index + 1}: ${text}`); cell.tabIndex = 0;
            cell.style.verticalAlign = 'top'; cell.style.padding = '.5em'; cell.style.textAlign = 'start';
            cell.style.whiteSpace = 'pre-wrap'; cell.style.overflowWrap = 'anywhere'; row.append(cell);
          }
          body.append(row);
        }
        table.append(body); fragment.append(table);
      }
    }
    this.onDisplay(fragment, port);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
