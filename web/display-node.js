import { ITEM, VIEW } from './port-contracts.js';
import { snapshotItem } from './paired-text.js';
import { snapshotView } from './view.js';

// Browser host adapter. Every input is the entire view; there is no row state.
export class DisplayNode {
  inputs = { input: ITEM };
  outputs = {};
  constructor(onDisplay = () => {}, { legacyView = false } = {}) {
    this.onDisplay = onDisplay; this.legacyView = legacyView;
    if (legacyView) this.inputs = { view: VIEW };
  }
  start(context) {
    this.signal = context.signal; this.closed = false;
    this.render({ rows: [] });
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted || context.signal !== this.signal) return;
    const port = this.legacyView ? 'view' : 'input';
    if (Object.keys(values).some(key => key !== port)) throw TypeError(`Display accepts only ${port}.`);
    if (!Object.hasOwn(values, port)) return;
    if (this.legacyView) { this.render(snapshotView(values.view)); return; }
    const item = snapshotItem(values.input);
    this.render({ rows: typeof item === 'string' ? [{ cells: [item] }] :
      (Array.isArray(item) ? item : [item]).map(pair => ({ cells: [pair.first, pair.second] })) });
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
