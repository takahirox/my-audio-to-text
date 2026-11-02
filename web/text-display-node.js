import { NUMBER, TEXT } from './port-contracts.js';
import { finiteNumber } from './number-node.js';

// Browser implementation of the logical text output sink. DOM is private to
// this host callback; the graph has only primitive inputs and no outputs.
export class TextDisplayNode {
  inputs = { id: NUMBER, input1: TEXT, input2: TEXT };
  outputs = {};
  constructor(onDisplay = () => {}) { this.onDisplay = onDisplay; }
  start(context) {
    this.signal = context.signal; this.closed = false;
    this.id = undefined; this.pending = undefined; this.rows = new Map();
    this.latest = { input1: '', input2: '' };
    this.textPorts = new Set(context.connectedInputs?.filter(port => port !== 'id'));
    this.render(true);
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted || context.signal !== this.signal) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port)) throw TypeError(`Unknown TextDisplay input: ${port}.`);
      if (port === 'id') finiteNumber(value, 'TextDisplay.id');
      else if (typeof value !== 'string') throw TypeError(`TextDisplay.${port} expects TEXT.`);
    }
    const hasId = Object.hasOwn(values, 'id');
    const ports = ['input1', 'input2'].filter(port => Object.hasOwn(values, port));
    const missingId = ports.length && context.groupInputs?.includes('id') && !hasId;
    if (missingId) { this.id = undefined; this.pending = undefined; }
    if (hasId) this.id = values.id;
    const keyed = this.id !== undefined || missingId || context.connectedInputs?.includes('id');
    if (ports.length) {
      const patch = {};
      for (const port of context.groupInputs || []) if (port !== 'id' && Object.hasOwn(this.inputs, port)) patch[port] = '';
      for (const port of ports) { patch[port] = values[port]; this.textPorts.add(port); }
      this.pending = { ...this.pending, ...patch };
    }
    // ID-only changes never replay a completed snapshot. With a connected ID,
    // unidentified text waits instead of becoming an unkeyed visible row.
    if (!this.pending || (keyed && this.id === undefined)) return;
    if (keyed) this.rows.set(this.id, { input1: '', input2: '', ...this.rows.get(this.id), ...this.pending });
    else this.latest = { ...this.latest, ...this.pending };
    this.pending = undefined;
    this.render(keyed);
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  render(keyed = false) {
    const snapshot = document.createDocumentFragment();
    const values = keyed ? this.rows.values() : [this.latest];
    if (this.textPorts.has('input1') && this.textPorts.has('input2')) {
      const table = document.createElement('table'); table.className = 'text-display-pair';
      table.setAttribute('aria-label', 'Paired texts');
      table.style.width = '100%'; table.style.tableLayout = 'fixed';
      const body = document.createElement('tbody');
      for (const value of values) {
        const row = document.createElement('tr');
        for (const [port, label] of [['input1', 'First text'], ['input2', 'Second text']]) {
          const cell = document.createElement('td'); cell.textContent = value[port];
          cell.setAttribute('aria-label', label); cell.tabIndex = 0;
          cell.style.width = '50%'; cell.style.verticalAlign = 'top';
          cell.style.whiteSpace = 'pre-wrap'; cell.style.overflowWrap = 'anywhere';
          row.append(cell);
        }
        body.append(row);
      }
      table.append(body); snapshot.append(table);
    } else if (this.textPorts.size) {
      const port = this.textPorts.has('input1') ? 'input1' : 'input2';
      for (const value of values) {
        const row = document.createElement('div'); row.textContent = value[port];
        row.style.whiteSpace = 'pre-wrap'; row.style.overflowWrap = 'anywhere'; snapshot.append(row);
      }
    }
    this.onDisplay(snapshot);
  }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
