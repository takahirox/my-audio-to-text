import { TEXT } from './port-contracts.js';
import { textProcessingModel } from './text-summary-models.js';
import { MAX_PENDING_CHARS, processingInputs, processingValues, processingPrompt, processingResult } from './text-summary-policy.js';

// One awaited generation per atomic TEXT delivery; history and windowing are graph-owned.
export class TextProcessingNode {
  outputs = { result: TEXT };
  // Admission happens before Pipeline retains deliveries behind inference.
  inputQueueLimits = { deliveries: 32, chars: MAX_PENDING_CHARS };
  constructor({ type, inputCount = 1, prompt, onEvent = () => {}, workerFactory = url => new Worker(url, { type: 'module' }),
    lazy = false, loadTimeoutMs = 180000, generationTimeoutMs = 180000 } = {}) {
    this.model = textProcessingModel(type);
    this.inputs = processingInputs(inputCount); this.values = Object.fromEntries(Object.keys(this.inputs).map(port => [port, '']));
    Object.assign(this, { type, prompt: processingPrompt(prompt), onEvent, workerFactory, lazy, loadTimeoutMs, generationTimeoutMs });
    this.sequence = 0; this.pending = new Map();
  }
  event(event) { try { this.onEvent(event); } catch { /* observer only */ } }
  async start(context) {
    if (this.started || this.disposed) throw new Error('Text processing requires a fresh session instance.');
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
        if (data.type === 'error' && data.fatal) { this.failure(Error(data.message)); return; }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.type === 'error') pending.reject(new Error(data.message));
        else if (data.type === pending.reply) pending.resolve(data);
        else pending.reject(new Error('Unexpected text processing Worker reply.'));
      };
      worker.onerror = worker.onmessageerror = event => {
        event.preventDefault?.(); this.failure(new Error(event.message || 'Text processing Worker communication failed.'));
      };
      await this.request('load', 'ready', { processor: this.type }, this.loadTimeoutMs);
      this.event({ type: 'ready', message: `${this.model.label} ready · local` });
    }).catch(error => { if (!this.disposed) this.failure(error); });
    return this.ready;
  }
  request(type, reply, payload, timeout = this.generationTimeoutMs) {
    if (this.disposed) return Promise.reject(new DOMException('Text processing canceled.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Text processing ${type} timed out. Check free RAM/GPU memory, then Start again.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, reply, timer });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(port, text, context = this.context) { return this.receiveInputs({ [port]: text }, context); }
  async receiveInputs(values, context = this.context) {
    if (this.disposed || this.stopping) throw new DOMException('Text processing session closed.', 'AbortError');
    const abort = () => this.dispose();
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      if (!this.started || Object.entries(values).some(([port, value]) => !Object.hasOwn(this.inputs, port) || typeof value !== 'string')) {
        throw new TypeError('Text processing requires configured input1…inputN: TEXT after Start.');
      }
      if (!Object.keys(values).length) return;
      if (this.generating) throw new Error('Text processing receive calls must be awaited.');
      // Apply an atomic family before taking its snapshot. Missing siblings in
      // that family clear; independent inputs retain their latest value.
      for (const port of context.groupInputs || []) if (Object.hasOwn(this.inputs, port)) this.values[port] = '';
      Object.assign(this.values, values);
      const inputs = Object.freeze(processingValues(Object.keys(this.inputs).map(port => this.values[port])));
      this.generating = true;
      await this.load();
      context.signal.throwIfAborted();
      if (this.disposed) throw new DOMException('Text processing unavailable.', 'AbortError');
      this.event({ type: 'generating', message: `${this.model.label}: processing text…` });
      const response = await this.request('process', 'result', { inputs, prompt: this.prompt });
      context.signal.throwIfAborted();
      if (this.disposed) throw new DOMException('Text processing canceled.', 'AbortError');
      // Equal results complete too. Keep the delivery's identity across inference.
      const result = processingResult(response.result);
      context.emit('result', result);
      this.event({ type: 'updated', message: `${this.model.label}: AI result updated · verify against the input text`, metrics: response.metrics });
      return result;
    } catch (error) {
      if (!this.disposed) this.failure(error, context);
      throw error;
    } finally { this.generating = false; context.signal.removeEventListener('abort', abort); }
  }
  stop() { this.stopping = true; this.dispose(); }
  failure(error, context = this.context) {
    if (this.disposed) return;
    this.event({ type: 'error', cause: error, message: `${this.model.label} unavailable: ${error.message || error}. Last successful result retained; pending work stopped. Save graph or retry preparation in Models, then Start again. No replacement result was emitted.` });
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
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DOMException('Text processing canceled.', 'AbortError')); }
    this.pending.clear();
  }
}
