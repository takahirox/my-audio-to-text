import { TEXT } from './port-contracts.js';
import { meetingSummaryModel } from './meeting-summary-models.js';
import { BATCH_CHARS, BATCH_WAIT_MS, MAX_PENDING_CHARS, summaryLanguage, summaryText } from './meeting-summary-policy.js';

// Session-owned bounded text, one in-flight inference, and one owned Worker.
export class MeetingSummaryNode {
  inputs = { text: TEXT };
  outputs = { summary: TEXT };
  constructor({ type, language = 'ja', onEvent = () => {}, workerFactory = url => new Worker(url, { type: 'module' }),
    loadTimeoutMs = 180000, generationTimeoutMs = 180000 } = {}) {
    this.model = meetingSummaryModel(type);
    Object.assign(this, { type, language: summaryLanguage(language), onEvent, workerFactory, loadTimeoutMs, generationTimeoutMs });
    this.fragments = []; this.summary = ''; this.sequence = 0; this.pending = new Map();
  }
  get text() { return this.fragments.join('\n'); }
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
  receive(port, text) {
    if (this.disposed || this.stopping) return;
    try {
      if (!this.started || port !== 'text' || typeof text !== 'string') throw new TypeError('Meeting summary requires committed text: TEXT after Start.');
      if (!text.trim()) return;
      if (this.text.length + text.length + (this.text ? 1 : 0) + (this.activeChars || 0) > MAX_PENDING_CHARS) {
        // Reject the overflowing fragment explicitly, but drain all previously
        // accepted evidence. Never coalesce away unseen committed speech.
        this.stopping = true;
        this.overflow = 'Meeting summary backlog exceeded 32,768 characters. The overflowing fragment was rejected; only previously accepted text is being summarized. Other paths continue. Start a new session after reducing input rate.';
        this.event({ type: 'error', message: this.overflow });
        this.flush(); return;
      }
      this.fragments.push(text);
      if (this.text.length >= BATCH_CHARS) this.flush();
      else if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, BATCH_WAIT_MS);
    } catch (error) { this.failure(error); }
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    this.due = true;
    if (this.working || this.disposed) return this.working;
    this.working = this.run().catch(error => { if (!this.disposed) this.failure(error); }).finally(() => {
      this.working = null;
      if (!this.disposed && this.text && (this.stopping || this.due || this.text.length >= BATCH_CHARS)) this.flush();
    });
    return this.working;
  }
  async run() {
    await this.ready;
    while (!this.disposed && this.text && (this.stopping || this.due || this.text.length >= BATCH_CHARS)) {
      clearTimeout(this.timer); this.timer = null; this.due = false;
      // The character target must never separate a qualifier from its claim.
      // Keep even an oversized fragment whole; the Worker splits at sentence
      // boundaries and enforces its token budget without truncating evidence.
      let count = 1, chars = this.fragments[0].length;
      while (count < this.fragments.length && chars + 1 + this.fragments[count].length <= BATCH_CHARS) {
        chars += 1 + this.fragments[count++].length;
      }
      const text = this.fragments.splice(0, count).join('\n'); this.activeChars = text.length;
      this.event({ type: 'generating', message: `${this.model.label}: updating summary…` });
      const result = await this.request('summarize', 'result', { previous: this.summary, text, language: this.language });
      if (this.disposed || this.context.signal.aborted) return;
      const summary = summaryText(result.summary);
      this.activeChars = 0;
      if (summary !== this.summary) { this.summary = summary; this.context.emit('summary', summary); }
      const compression = result.metrics?.compressedRecords ? ` · ${result.metrics.compressedRecords} older note items omitted to keep history bounded` : '';
      this.event({ type: 'updated', message: `${this.model.label}: AI draft updated · verify facts, decisions and owners against the transcript${compression}`, metrics: result.metrics });
    }
    if (!this.disposed && this.overflow && !this.text) {
      this.event({ type: 'error', message: this.overflow });
      this.dispose();
    }
    if (!this.disposed && this.text && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, BATCH_WAIT_MS);
  }
  async stop() {
    this.stopping = true;
    await this.flush();
    // A timer/receive can have requested a successor while generation finished.
    while (!this.disposed && (this.working || this.text)) await (this.working || this.flush());
    this.dispose();
  }
  failure(error) {
    if (this.disposed) return;
    this.event({ type: 'error', message: `${this.model.label} unavailable: ${error.message || error}. Last successful summary retained; pending work stopped. Save graph or retry preparation in Models, then Start again. No replacement summary was emitted.` });
    this.dispose(); this.context?.fail(error);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; clearTimeout(this.timer); this.timer = null;
    this.context?.signal.removeEventListener('abort', this.abort);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new DOMException('Meeting summary canceled.', 'AbortError')); }
    this.pending.clear(); this.fragments = []; this.summary = ''; this.activeChars = 0;
  }
}
