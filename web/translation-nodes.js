import { portContract } from './pipeline.js';

// Plain strings, no payload envelopes or graph metadata.
export const TEXT = portContract('text');

// Private transport only: every node instance owns its Worker and pending RPCs.
class WorkerTranslationNode {
  inputs = { text: TEXT };
  outputs = { text: TEXT };
  constructor(url, { workerFactory = url => new Worker(url, { type: 'module' }), onEvent = () => {}, loadOptions = {}, requireSingleOutput = false } = {}) {
    this.url = url; this.workerFactory = workerFactory; this.onEvent = onEvent;
    this.loadOptions = loadOptions; this.requireSingleOutput = requireSingleOutput;
    this.pending = new Map(); this.sequence = 0;
  }
  async start(context) {
    if (this.started || this.disposed) throw new Error('Translation nodes require a fresh instance.');
    this.started = true; this.context = context;
    context.signal.throwIfAborted();
    this.worker = this.workerFactory(this.url);
    this.worker.onmessage = ({ data }) => {
      if (this.disposed || context.signal.aborted) return;
      if (data.type === 'progress') {
        try { this.onEvent(data); } catch { /* diagnostic observer only */ }
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return; // completed, unrelated or stale reply
      this.pending.delete(data.id);
      if (data.type === 'error') pending.reject(new Error(data.message));
      else if (data.type === pending.type) pending.resolve(data);
      else pending.reject(new Error(`Unexpected translation Worker reply: ${data.type}`));
    };
    const workerError = event => {
      const error = new Error(event.message || 'Translation Worker communication failed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear(); context.fail(error);
    };
    this.worker.onerror = workerError; this.worker.onmessageerror = workerError;
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    await this.request('load', 'ready', this.loadOptions);
    context.signal.throwIfAborted();
    try { this.onEvent({ type: 'ready' }); } catch { /* diagnostic observer only */ }
  }
  request(type, reply, payload = {}) {
    if (this.disposed || this.context?.signal.aborted) {
      return Promise.reject(new DOMException('Translation canceled.', 'AbortError'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type: reply });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async receive(port, text, context) {
    if (port !== 'text' || typeof text !== 'string') throw new TypeError('Translation input must be a text string.');
    if (text.length > 1000) throw new RangeError('Use a short snippet of at most 1,000 characters.');
    if (!text.trim()) return; // zero outputs; no inference for whitespace
    const result = await this.request('translate', 'result', { text });
    context.signal.throwIfAborted();
    if (!Array.isArray(result.texts) || result.texts.some(value => typeof value !== 'string')) {
      throw new TypeError('Invalid translation Worker output.');
    }
    if (this.requireSingleOutput && (result.texts.length !== 1 || !result.texts[0].trim())) {
      throw new Error('OPUS-MT returned no single nonempty translation.');
    }
    for (const value of result.texts) context.emit('text', value);
  }
  async stop() { await this.request('drain', 'drained'); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    const error = new DOMException('Translation canceled.', 'AbortError');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.context = null;
  }
}

export class OpusMtTranslationNode extends WorkerTranslationNode {
  constructor(options) { super(new URL('./opus-mt-worker.js', import.meta.url), options); }
}
export class TranslateGemmaTranslationNode extends WorkerTranslationNode {
  constructor(options) { super(new URL('./translategemma-worker.js', import.meta.url), options); }
}

export class TextInputNode {
  inputs = {};
  outputs = { text: TEXT };
  constructor(text) { this.text = text; }
  start(context) { context.emit('text', this.text); }
}
export class TextOutputNode {
  inputs = { text: TEXT };
  outputs = {};
  constructor(onText) { this.onText = onText; }
  receive(port, text, context) { return this.onText(text, context.signal); }
}
