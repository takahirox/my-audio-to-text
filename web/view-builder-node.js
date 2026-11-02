import { NUMBER, TEXT, VIEW } from './port-contracts.js';
import { finiteNumber } from './number-node.js';
import { snapshotView } from './view.js';

// History and text-to-row construction are portable processing, before the host.
export class ViewBuilderNode {
  inputs = { id: NUMBER, input1: TEXT, input2: TEXT };
  outputs = { view: VIEW };
  start(context) {
    this.signal = context.signal; this.closed = false;
    this.id = undefined; this.pending = undefined; this.rows = new Map();
    this.latest = { input1: '', input2: '' };
    this.textPorts = new Set(context.connectedInputs?.filter(port => port !== 'id'));
    context.emit('view', snapshotView({ rows: [] }));
  }
  receiveInputs(values, context) {
    if (this.closed || context.signal.aborted || context.signal !== this.signal) return;
    for (const [port, value] of Object.entries(values)) {
      if (!Object.hasOwn(this.inputs, port)) throw TypeError(`Unknown ViewBuilder input: ${port}.`);
      if (port === 'id') finiteNumber(value, 'ViewBuilder.id');
      else if (typeof value !== 'string') throw TypeError(`ViewBuilder.${port} expects TEXT.`);
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
    // Only unidentified, never-applied text waits for an ID. ID-only changes
    // never replay completed text or create empty rows.
    if (!this.pending || (keyed && this.id === undefined)) return;
    if (keyed) this.rows.set(this.id, { input1: '', input2: '', ...this.rows.get(this.id), ...this.pending });
    else this.latest = { ...this.latest, ...this.pending };
    this.pending = undefined;
    const cellPorts = ['input1', 'input2'].filter(port => this.textPorts.has(port));
    const row = value => ({ cells: cellPorts.map(port => value[port]) });
    context.emit('view', snapshotView({ rows: keyed
      ? [...this.rows].map(([id, value]) => ({ id, ...row(value) })) : [row(this.latest)] }));
  }
  receive(port, value, context) { this.receiveInputs({ [port]: value }, context); }
  stop() { this.closed = true; }
  cancel() { this.closed = true; }
  dispose() { this.closed = true; }
}
