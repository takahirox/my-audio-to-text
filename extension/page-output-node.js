import { TRANSCRIPT } from '../web/transcription-nodes.js';
import { TRANSLATION } from './translation-scheduler.js';
import { PageConnection } from './page-target.js';

export class PageTextOutputNode {
  inputs = { final: TRANSCRIPT, translatedFinal: TRANSLATION };
  outputs = {};
  constructor({ target, selected = false, connectionFactory = (...args) => new PageConnection(...args), onState = () => {} }) {
    this.target = target && { ...target }; this.selected = selected; this.connectionFactory = connectionFactory; this.onState = onState;
    this.seen = new Set(); this.sequence = 0; this.lastId = -1;
  }
  async start(context) {
    this.context = context;
    context.signal.throwIfAborted();
    // A field destination is optional. Never connect, inject or ask permission
    // for an unset target; this decision lasts for this node's entire session.
    if (!Number.isInteger(this.target?.tabId) || typeof this.target.documentId !== 'string' || !this.target.documentId) { this.skip('no authorized target'); return; }
    if (this.selected && !this.target.fieldId) { this.skip('no selected field'); return; }
    try {
      this.connection = this.connectionFactory(this.target, event => { if (event.event === 'ended') this.failure(event.error); });
      await this.connection.request('output', { mode: this.selected ? 'selected' : 'focused', target: this.target.fieldId });
      context.signal.throwIfAborted();
      if (!this.skipped && !this.failed && !this.disposed) {
        this.connected = true;
        this.onState(`${this.target.label}${this.selected ? ` · ${this.target.fieldLabel}` : ' · focused editable field'} · connected and authorized · confirmed text only`, true);
      }
    } catch (error) {
      // A stale document/field or lost permission disables only this sink.
      if (!context.signal.aborted && !this.skipped && !this.failed && !this.disposed) this.skip(`target unavailable (${error.message})`);
    }
  }
  skip(reason) {
    this.skipped = true; this.connection?.close();
    this.onState(`${this.selected ? 'Selected field' : 'Focused input'} output skipped: ${reason}. Select/authorize a page${this.selected ? ' and pick a field' : ''} in Input and output targets to enable it next session.`, false);
  }
  failure(message) {
    if (this.failed || this.skipped || this.disposed) return;
    if (!this.connected) { this.skip(`target unavailable (${message})`); return; }
    this.failed = true; this.connection?.close();
    this.onState(`Insertion detached: ${message} Stop, reauthorize/reselect and Start again. Other branches continue.`, false);
  }
  async receive(port, value, context) {
    if (this.skipped || this.failed || this.disposed || context.signal.aborted || !['final', 'translatedFinal'].includes(port)) return;
    if (port === 'translatedFinal' && value.status !== 'complete') return;
    const id = port === 'translatedFinal' ? value.source?.id : value.id;
    // Production ASR gives monotonically increasing utterance IDs. Require them
    // rather than guessing whether equal text is a retry or a new utterance.
    if (!Number.isSafeInteger(id) || id < 0) { this.failure('Final text has no stable utterance ID.'); return; }
    const key = `${port}:${id}`;
    if (this.seen.has(key) || id <= this.lastId) return;
    this.seen.add(key); this.lastId = id;
    const text = value.text?.trim(); if (!text) return;
    try {
      await this.connection.request('append', { key, sequence: this.sequence++, text });
      if (!context.signal.aborted && !this.failed && !this.disposed) this.onState(`${this.target.label} · inserted ${this.sequence} confirmed utterance(s)`, true);
    } catch (error) { if (!context.signal.aborted) this.failure(error.message); }
  }
  stop() { this.dispose(); }
  dispose() { this.disposed = true; this.connection?.close(); }
}

export class FocusedInputTextOutputNode extends PageTextOutputNode {
  constructor(options) { super({ ...options, selected: false }); }
}
export class SelectedFormFieldTextOutputNode extends PageTextOutputNode {
  constructor(options) { super({ ...options, selected: true }); }
}
