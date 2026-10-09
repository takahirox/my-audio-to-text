import { TEXT } from '../web/translation-nodes.js';
import { PageConnection } from './page-target.js';

export class FocusedInputTextOutputNode {
  inputs = { text: TEXT };
  outputs = {};
  constructor({ target, connectionFactory = (...args) => new PageConnection(...args), onState = () => {} }) {
    this.target = target && { ...target }; this.connectionFactory = connectionFactory; this.onState = onState;
    this.sequence = 0; this.inserted = 0;
  }
  async start(context) {
    this.context = context;
    context.signal.throwIfAborted();
    if (!Number.isInteger(this.target?.tabId) || typeof this.target.documentId !== 'string' || !this.target.documentId) { this.skip('no authorized toolbar document'); return; }
    try {
      this.connection = this.connectionFactory(this.target, event => { if (event.event === 'ended') this.failure(event.error); });
      await this.connection.request('output');
      context.signal.throwIfAborted();
      if (!this.skipped && !this.failed && !this.disposed) {
        this.connected = true;
        this.onState(`${this.target.label} · focused editable field · connected and authorized · plain text ready`, true);
      }
    } catch (error) {
      if (!context.signal.aborted && !this.skipped && !this.failed && !this.disposed) this.skip(`target unavailable (${error.message})`);
    }
  }
  skip(reason) {
    this.skipped = true; this.connection?.close();
    this.onState(`Focused input output skipped: ${reason}. Stop and invoke the toolbar on a normal page to enable it next session.`, false);
  }
  failure(message) {
    if (this.failed || this.skipped || this.disposed) return;
    if (!this.connected) { this.skip(`target unavailable (${message})`); return; }
    this.failed = true; this.connection?.close();
    this.onState(`Insertion detached: ${message} Stop and invoke that page's toolbar action again. Other branches continue.`, false);
  }
  async receive(port, text, context) {
    if (this.skipped || this.failed || this.disposed || context.signal.aborted || port !== 'text' || typeof text !== 'string' || !text.trim()) return;
    try {
      // Pipeline serializes this sink. Sequence is only page-session delivery
      // identity, never part of the plain TEXT contract. Never retry an edit.
      const result = await this.connection.request('append', { sequence: this.sequence++, text });
      if (context.signal.aborted || this.failed || this.disposed) return;
      if (result?.skipped) this.onState(`Insertion skipped: ${result.skipped} Other branches continue.`, false);
      else if (result?.inserted) this.onState(`${this.target.label} · inserted ${++this.inserted} text value(s)`, true);
    } catch (error) { if (!context.signal.aborted) this.failure(error.message); }
  }
  stop() { this.dispose(); }
  dispose() { this.disposed = true; this.connection?.close(); }
}
