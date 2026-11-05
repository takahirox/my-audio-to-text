import { TEXT } from './port-contracts.js';
import { textSummaryModel } from './text-summary-models.js';
import { MAX_PENDING_CHARS, summaryLanguage, summaryPrompt, summaryText } from './text-summary-policy.js';

// One awaited update per input; previous summary and windowing are graph-owned.
export class TextSummaryNode {
  inputs = { text: TEXT };
  outputs = { summary: TEXT };
  // Admission happens before Pipeline retains deliveries behind inference.
  inputQueueLimits = { deliveries: 32, chars: MAX_PENDING_CHARS };
  constructor({ type, language = 'ja', prompt, onEvent = () => {}, workerFactory = url => new Worker(url, { type: 'module' }),
    lazy = false, loadTimeoutMs = 180000, generationTimeoutMs = 180000 } = {}) {
    this.model = textSummaryModel(type);
    Object.assign(this, { type, language: summaryLanguage(language), prompt: summaryPrompt(prompt), onEvent, workerFactory, lazy, loadTimeoutMs, generationTimeoutMs });
    this.sequence = 0; this.pending = new Map();
  }
  event(event) { try { this.onEvent(event); } catch { /* observer only */ } }
  async start(context) {
    if (this.started || this.disposed) throw new Error('Text summary requires a fresh session instance.');
    this.started = true; this.context = context;
    context.signal.throwIfAborted();
    this.abort = () => {
      // Runtime admission failures abort before receive() can report them.
      if (context.signal.reason?.name !== 'AbortError') this.failure(context.signal.reason);
      else this.dispose();
    };
    context.signal.addEventListener('abort', this.abort, { once: true });
    if (this.lazy) { this.event({ type: 'waiting', message: `${this.model.label}: waiting for TEXT; model loads on first request.` }); return; }
    await this.load();
  }
  load() {
    if (this.ready) return this.ready;
    const context = this.context;
    this.event({ type: 'loading', message: `Loading ${this.model.label} locally…` });
    this.ready = Promise.resolve().then(async () => {
      context.signal.throwIfAborted();
      const worker = this.worker = this.workerFactory(new URL('./text-summary-worker.js', import.meta.url));
      worker.onmessage = ({ data }) => {
        if (this.disposed || this.worker !== worker || context.signal.aborted) return;
        if (data.type === 'progress') { this.event(data); return; }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.type === 'error') pending.reject(new Error(data.message));
        else if (data.type === pending.reply) pending.resolve(data);
        else pending.reject(new Error('Unexpected text summary Worker reply.'));
      };
      worker.onerror = worker.onmessageerror = event => {
        event.preventDefault?.(); this.failure(new Error(event.message || 'Text summary Worker communication failed.'));
      };
      await this.request('load', 'ready', { processor: this.type }, this.loadTimeoutMs);
      this.event({ type: 'ready', message: `${this.model.label} ready · ${this.language} · local` });
    }).catch(error => { if (!this.disposed) this.failure(error); });
    return this.ready;
  }
  request(type, reply, payload, timeout = this.generationTimeoutMs) {
    if (this.disposed) return Promise.reject(new DOMException('Text summary canceled.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Text summary ${type} timed out. Check free RAM/GPU memory, then Start again.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, reply, timer });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async receive(port, text, context = this.context) {
    if (this.disposed || this.stopping) throw new DOMException('Text summary session closed.', 'AbortError');
    const abort = () => this.dispose();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      if (!this.started || port !== 'text' || typeof text !== 'string') throw new TypeError('Text summary requires text: TEXT after Start.');
      if (!text.trim() || text.length > MAX_PENDING_CHARS) throw new RangeError('Text summary needs nonempty input of at most 32,768 characters; no evidence was truncated.');
      if (this.generating) throw new Error('Text summary receive calls must be awaited.');
      this.generating = true;
      await this.load();
      context.signal.throwIfAborted();
      if (this.disposed) throw new DOMException('Text summary unavailable.', 'AbortError');
      this.event({ type: 'generating', message: `${this.model.label}: summarizing text…` });
      const result = await this.request('summarize', 'result', { text, language: this.language, prompt: this.prompt });
      context.signal.throwIfAborted();
      if (this.disposed) throw new DOMException('Text summary canceled.', 'AbortError');
      // Equality is a successful completion too. Retain delivery identity across
      // inference, never emit from the session's unrelated startup context.
      const summary = summaryText(result.summary);
      context.emit('summary', summary);
      this.event({ type: 'updated', message: `${this.model.label}: AI draft updated · verify against the input text`, metrics: result.metrics });
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
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DOMException('Text summary canceled.', 'AbortError')); }
    this.pending.clear();
  }
}
