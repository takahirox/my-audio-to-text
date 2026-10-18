import { TEXT } from './port-contracts.js';
import { validateCondition, validateText, validateDecision, MAX_QUEUED_INPUTS, MAX_QUEUED_CHARS } from './if-condition-policy.js';

// An instance owns one Worker, a bounded FIFO and its immutable condition.
// Stop drains; Cancel/dispose kills load/inference and invalidates every reply.
export class IfConditionNode {
  inputs = { text: TEXT };
  outputs = { yes: TEXT, no: TEXT };
  constructor({ condition = 'Is this a question?', onEvent = () => {},
    workerFactory = url => new Worker(url, { type: 'module' }), loadTimeoutMs = 120000, decisionTimeoutMs = 30000 } = {}) {
    this.condition = validateCondition(condition);
    Object.assign(this, { onEvent, workerFactory, loadTimeoutMs, decisionTimeoutMs });
    this.jobs = []; this.queuedChars = 0; this.sequence = 0; this.pending = new Map();
  }
  event(event) { try { this.onEvent(event); } catch { /* observer only */ } }
  async start(context) {
    if (this.started || this.disposed) throw new Error('IfCondition requires a fresh node instance.');
    this.started = true; this.context = context;
    context.signal.throwIfAborted();
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    this.event({ type: 'loading', message: 'Loading local IfCondition model…' });
    this.ready = Promise.resolve().then(async () => {
      context.signal.throwIfAborted();
      const worker = this.worker = this.workerFactory(new URL('./if-condition-worker.js', import.meta.url));
      worker.onmessage = ({ data }) => {
        if (this.disposed || this.worker !== worker || context.signal.aborted) return;
        if (data.type === 'progress') { this.event(data); return; }
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.type === 'error') pending.reject(new Error(data.message));
        else if (data.type === pending.reply) pending.resolve(data);
        else pending.reject(new Error(`Unexpected IfCondition Worker reply: ${data.type}`));
      };
      worker.onerror = worker.onmessageerror = event => {
        event.preventDefault?.(); this.failure(new Error(event.message || 'IfCondition Worker communication failed.'));
      };
      await this.request('load', 'ready', { condition: this.condition }, this.loadTimeoutMs);
      context.signal.throwIfAborted();
      this.event({ type: 'ready', message: 'Local IfCondition ready' });
    }).catch(error => { if (!this.disposed) this.failure(error); });
    await this.ready;
  }
  request(type, reply, payload = {}, timeout = this.decisionTimeoutMs) {
    if (this.disposed) return Promise.reject(new DOMException('IfCondition canceled.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IfCondition ${type} timed out. Start again after checking model assets and available memory.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, reply, timer });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  receive(port, text) {
    if (this.disposed || this.stopping) return;
    try {
      if (!this.started) throw new Error('Start IfCondition before sending text.');
      if (port !== 'text') throw new TypeError('IfCondition input port must be text.');
      validateText(text);
      if (this.jobs.length + (this.active ? 1 : 0) >= MAX_QUEUED_INPUTS || this.queuedChars + text.length > MAX_QUEUED_CHARS) {
        throw new Error('IfCondition backlog limit exceeded (32 inputs / 32,768 characters). Slow the producer and Start again.');
      }
      this.jobs.push(text); this.queuedChars += text.length;
      this.pump();
    } catch (error) { this.failure(error); }
  }
  pump() {
    if (this.working || this.disposed) return;
    this.working = this.run().catch(error => { if (!this.disposed) this.failure(error); }).finally(() => {
      this.working = null;
      if (this.jobs.length && !this.disposed) this.pump();
    });
  }
  async run() {
    await this.ready;
    while (!this.disposed && this.jobs.length) {
      const text = this.jobs.shift(); this.active = true;
      // Empty/whitespace-only TEXT takes No verbatim after successful model load.
      const branch = text.trim() ? validateDecision(await this.request('decide', 'result', { text })) : 'no';
      if (this.disposed || this.context.signal.aborted) return;
      this.context.emit(branch, text);
      this.queuedChars -= text.length; this.active = false;
    }
  }
  async stop() {
    this.stopping = true;
    await this.ready;
    await this.working;
    if (!this.disposed) {
      try { await this.request('drain', 'drained'); }
      catch (error) { if (!this.disposed) this.failure(error); }
    }
    this.dispose();
  }
  failure(error) {
    if (this.disposed) return;
    this.error = error;
    const context = this.context;
    this.event({ type: 'error', message: `IfCondition unavailable: ${error.message || error}. No decision was fabricated. Fix the input or Save graph to retry preparation, then Start again.` });
    this.dispose();
    context?.fail(error);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new DOMException('IfCondition canceled.', 'AbortError'));
    }
    this.pending.clear(); this.jobs = []; this.queuedChars = 0; this.active = false;
  }
}
