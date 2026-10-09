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
    if (!this.target || (this.selected && !this.target.fieldId)) throw Error('Authorize the output tab and pick the selected field in Live before Start.');
    this.connection = this.connectionFactory(this.target, event => { if (event.event === 'ended' && !this.disposed) this.failure(event.error); });
    await this.connection.request('output', { mode: this.selected ? 'selected' : 'focused', target: this.target.fieldId });
    context.signal.throwIfAborted();
    this.onState(`${this.target.label}${this.selected ? ` · ${this.target.fieldLabel}` : ' · focused editable field'} · confirmed text only`);
  }
  failure(message) {
    this.failed = true; this.connection?.close();
    this.onState(`Insertion detached: ${message} Stop, reauthorize/reselect and Start again. Live continues.`);
  }
  async receive(port, value, context) {
    if (this.failed || this.disposed || context.signal.aborted || !['final', 'translatedFinal'].includes(port)) return;
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
      if (!context.signal.aborted) this.onState(`${this.target.label} · inserted ${this.sequence} confirmed utterance(s)`);
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
