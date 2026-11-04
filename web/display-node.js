import { ITEM } from './port-contracts.js';
import { snapshotItem } from './paired-text.js';

// Browser host adapter. Each input replaces the entire display; no row state.
export class DisplayNode {
  inputs = { input: ITEM };
  outputs = {};
  constructor(onDisplay = () => {}) { this.onDisplay = onDisplay; }
  start(context) {
    this.signal = context.signal; this.closed = false;
    this.render([]);
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted) return;
    // Cancel aborts ordinary work before routing cleanup with a fresh signal.
    // A new running lifecycle still rejects contexts from earlier sessions.
    if (context.signal !== this.signal && !this.signal.aborted) return;
    if (Object.keys(values).some(key => key !== 'input')) throw TypeError('Display accepts only input.');
    if (Object.hasOwn(values, 'input')) this.render(snapshotItem(values.input));
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  render(item) {
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
    this.onDisplay(fragment);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
