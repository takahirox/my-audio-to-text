import { TEXT, TRANSCRIPT } from './port-contracts.js';
import { validateInput, validateCandidate } from './correction-policy.js';
export { TEXT } from './port-contracts.js';

// Connect SpeechToTextNode.final explicitly. IDs/alignment remain in consumers.
export class FinalTranscriptTextNode {
  inputs = { final: TRANSCRIPT };
  outputs = { text: TEXT };
  receive(port, transcript, context) {
    if (port !== 'final' || typeof transcript?.text !== 'string') throw new TypeError('Expected a final transcript with text.');
    context.emit('text', transcript.text);
  }
}

export class SpeechTranscriptCorrectionNode {
  inputs = { text: TEXT };
  outputs = { text: TEXT };
  constructor({ enabled = true, language = 'auto', onFailure = 'error', onEvent = () => {},
    workerFactory = url => new Worker(url, { type: 'module' }) } = {}) {
    if (!['auto', 'ja', 'en'].includes(language)) throw new TypeError('Choose auto, ja or en.');
    if (!['error', 'bypass'].includes(onFailure)) throw new TypeError('Choose error or bypass on failure.');
    this.enabled = enabled; this.language = language; this.onFailure = onFailure;
    this.onEvent = onEvent; this.workerFactory = workerFactory;
    this.pending = new Map(); this.sequence = 0;
  }
  event(event) { try { this.onEvent(event); } catch { /* observer only */ } }
  async start(context) {
    if (this.started || this.disposed) throw new Error('Correction requires a fresh node instance.');
    this.started = true; this.context = context;
    context.signal.throwIfAborted();
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    if (!this.enabled) { this.event({ type: 'bypass', message: 'Correction disabled.' }); return; }
    try {
      this.worker = this.workerFactory(new URL('./qwen3-correction-worker.js', import.meta.url));
      this.worker.onmessage = ({ data }) => {
        if (this.disposed || context.signal.aborted) return;
        if (data.type === 'progress') { this.event(data); return; }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.type === 'error') pending.reject(new Error(data.message));
        else if (data.type === pending.reply) pending.resolve(data);
        else pending.reject(new Error(`Unexpected correction Worker reply: ${data.type}`));
      };
      const failed = event => {
        const error = new Error(event.message || 'Correction Worker communication failed.');
        this.releaseWorker(error);
        if (this.onFailure === 'bypass') this.bypass(error);
        else context.fail(error);
      };
      this.worker.onerror = this.worker.onmessageerror = failed;
      await this.request('load', 'ready', { language: this.language });
      context.signal.throwIfAborted();
      this.event({ type: 'ready' });
    } catch (error) {
      context.signal.throwIfAborted();
      if (this.onFailure !== 'bypass') throw error;
      if (!this.unavailable) this.bypass(error);
    }
  }
  bypass(error) {
    this.unavailable = true;
    this.releaseWorker(error);
    this.event({ type: 'bypass', message: `Correction bypassed: ${error.message || error}` });
  }
  request(type, reply, payload = {}) {
    if (this.disposed || this.context?.signal.aborted) return Promise.reject(new DOMException('Correction canceled.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, reply });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) {
        this.pending.delete(id);
        if (this.onFailure === 'bypass') this.bypass(error);
        reject(error);
      }
    });
  }
  async receive(port, text, context) {
    if (port !== 'text') throw new TypeError('Correction input port must be text.');
    validateInput(text);
    if (!this.enabled || this.unavailable || !text.trim()) { context.emit('text', text); return; }
    try {
      const result = await this.request('correct', 'result', { text });
      context.signal.throwIfAborted();
      context.emit('text', validateCandidate(result.text, text));
    } catch (error) {
      context.signal.throwIfAborted();
      if (this.onFailure !== 'bypass') throw error;
      if (!this.unavailable) this.event({ type: 'bypass', message: `Candidate rejected; passing original: ${error.message || error}` });
      context.emit('text', text);
    }
  }
  async stop() {
    if (this.enabled && !this.unavailable) {
      try { await this.request('drain', 'drained'); }
      catch (error) {
        this.context?.signal.throwIfAborted();
        if (this.onFailure !== 'bypass') throw error;
        if (!this.unavailable) this.bypass(error);
      }
    }
  }
  releaseWorker(error) {
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    this.releaseWorker(new DOMException('Correction canceled.', 'AbortError'));
    this.context = null;
  }
}
