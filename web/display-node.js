import { VIEW } from './port-contracts.js';
import { snapshotView } from './view.js';

// Browser host adapter. Every input is the entire view; there is no row state.
export class DisplayNode {
  inputs = { view: VIEW };
  outputs = {};
  constructor(onDisplay = () => {}) { this.onDisplay = onDisplay; }
  start(context) {
    this.signal = context.signal; this.closed = false;
    this.render({ rows: [] });
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted || context.signal !== this.signal) return;
    if (Object.keys(values).some(port => port !== 'view')) throw TypeError('Display accepts only view: VIEW.');
    if (Object.hasOwn(values, 'view')) this.render(snapshotView(values.view));
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  render(view) {
    const fragment = document.createDocumentFragment();
    if (view.rows.some(row => row.cells.length > 1)) {
      const columns = view.rows.reduce((max, row) => Math.max(max, row.cells.length), 1);
      const table = document.createElement('table'); table.className = 'display-view';
      table.setAttribute('aria-label', 'Text rows');
      table.style.width = '100%'; table.style.tableLayout = 'fixed';
      const body = document.createElement('tbody');
      for (const { cells } of view.rows) {
        const row = document.createElement('tr');
        for (const [index, text] of cells.entries()) {
          const cell = document.createElement('td'); cell.textContent = text;
          cell.setAttribute('aria-label', `Text ${index + 1}: ${text}`); cell.tabIndex = 0;
          if (cells.length === 1) cell.colSpan = columns;
          cell.style.verticalAlign = 'top';
          cell.style.padding = '.5em'; cell.style.textAlign = 'start';
          cell.style.whiteSpace = 'pre-wrap'; cell.style.overflowWrap = 'anywhere';
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body); fragment.append(table);
    } else for (const { cells } of view.rows) {
      const row = document.createElement('div'); row.textContent = cells[0];
      row.style.whiteSpace = 'pre-wrap'; row.style.overflowWrap = 'anywhere'; fragment.append(row);
    }
    this.onDisplay(fragment);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
