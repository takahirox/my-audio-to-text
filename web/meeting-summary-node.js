import { TEXT } from './port-contracts.js';
import { meetingSummaryModel } from './meeting-summary-models.js';
import { MAX_PENDING_CHARS, summaryLanguage, summaryText } from './meeting-summary-policy.js';

// One awaited update per input; previous summary and windowing are graph-owned.
export class MeetingSummaryNode {
  inputs = { text: TEXT };
  outputs = { summary: TEXT };
  constructor({ type, language = 'ja', onEvent = () => {}, workerFactory = url => new Worker(url, { type: 'module' }),
    loadTimeoutMs = 180000, generationTimeoutMs = 180000 } = {}) {
    this.model = meetingSummaryModel(type);
    Object.assign(this, { type, language: summaryLanguage(language), onEvent, workerFactory, loadTimeoutMs, generationTimeoutMs });
    this.sequence = 0; this.pending = new Map();
  }
  event(event) { try { this.onEvent(event); } catch { /* observer only */ } }
  async start(context) {
    if (this.started || this.disposed) throw new Error('Meeting summary requires a fresh session instance.');
    this.started = true; this.context = context;
    context.signal.throwIfAborted();
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    this.event({ type: 'loading', message: `Loading ${this.model.label} locally…` });
    this.ready = Promise.resolve().then(async () => {
      context.signal.throwIfAborted();
      const worker = this.worker = this.workerFactory(new URL('./meeting-summary-worker.js', import.meta.url));
      worker.onmessage = ({ data }) => {
        if (this.disposed || this.worker !== worker || context.signal.aborted) return;
        if (data.type === 'progress') { this.event(data); return; }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.type === 'error') pending.reject(new Error(data.message));
        else if (data.type === pending.reply) pending.resolve(data);
        else pending.reject(new Error('Unexpected meeting summary Worker reply.'));
      };
      worker.onerror = worker.onmessageerror = event => {
        event.preventDefault?.(); this.failure(new Error(event.message || 'Meeting summary Worker communication failed.'));
      };
      await this.request('load', 'ready', { processor: this.type }, this.loadTimeoutMs);
      this.event({ type: 'ready', message: `${this.model.label} ready · ${this.language} · local` });
    }).catch(error => { if (!this.disposed) this.failure(error); });
    await this.ready;
  }
  request(type, reply, payload, timeout = this.generationTimeoutMs) {
    if (this.disposed) return Promise.reject(new DOMException('Meeting summary canceled.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Meeting summary ${type} timed out. Check free RAM/GPU memory, then Start again.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, reply, timer });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async receive(port, text, context = this.context) {
    if (this.disposed || this.stopping) throw new DOMException('Meeting summary session closed.', 'AbortError');
    const abort = () => this.dispose();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      if (!this.started || port !== 'text' || typeof text !== 'string') throw new TypeError('Meeting summary requires text: TEXT after Start.');
      if (!text.trim() || text.length > MAX_PENDING_CHARS) throw new RangeError('Meeting summary needs nonempty input of at most 32,768 characters; no evidence was truncated.');
      if (this.generating) throw new Error('Meeting summary receive calls must be awaited.');
      this.generating = true;
      this.event({ type: 'generating', message: `${this.model.label}: updating summary…` });
      const result = await this.request('summarize', 'result', { text, language: this.language });
      context.signal.throwIfAborted();
      if (this.disposed) throw new DOMException('Meeting summary canceled.', 'AbortError');
      // Equality is a successful completion too. Retain delivery identity across
      // inference, never emit from the session's unrelated startup context.
      const summary = summaryText(result.summary);
      context.emit('summary', summary);
      this.event({ type: 'updated', message: `${this.model.label}: AI draft updated · verify facts, decisions and owners against the transcript`, metrics: result.metrics });
      return summary;
    } catch (error) {
      if (!this.disposed) this.failure(error, context);
      throw error;
    } finally { this.generating = false; context.signal.removeEventListener('abort', abort); }
  }
  stop() { this.stopping = true; this.dispose(); }
  failure(error, context = this.context) {
    if (this.disposed) return;
    this.event({ type: 'error', message: `${this.model.label} unavailable: ${error.message || error}. Last successful summary retained; pending work stopped. Save graph or retry preparation in Models, then Start again. No replacement summary was emitted.` });
    this.dispose(); context?.fail(error);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DOMException('Meeting summary canceled.', 'AbortError')); }
    this.pending.clear();
  }
}
