import { Pipeline } from '../web/pipeline.js';
import { TEXT_RESULT } from '../web/port-contracts.js';
import { OpusMtTranslationNode, TEXT, TextOutputNode } from '../web/translation-nodes.js';

export { TEXT_RESULT } from '../web/port-contracts.js';

// Session-owned adapter, not a generic queue: one in flight, one replaceable
// provisional, and a FIFO of finals. receive() never waits for inference, so
// Pipeline's input serialization cannot accumulate obsolete provisional work.
export class TranslationSchedulerNode {
  inputs = { provisional: TEXT, text: TEXT };
  outputs = { provisional: TEXT, text: TEXT, provisionalResult: TEXT_RESULT, finalResult: TEXT_RESULT };
  constructor({ prepare, workerFactory, TranslationNode = OpusMtTranslationNode, onState = () => {} } = {}) {
    this.TranslationNode = TranslationNode; this.prepare = prepare; this.workerFactory = workerFactory; this.onState = onState;
    this.finals = []; this.version = 0; this.finalIndex = 0;
  }
  start(context) {
    this.context = context;
    this.onState('Loading local OPUS-MT…');
    this.ready = this.load().catch(error => { this.failure(error); });
  }
  async load() {
    await this.prepare?.(this.context.signal);
    this.context.signal.throwIfAborted();
    const source = { inputs: {}, outputs: { text: TEXT }, start: context => { this.send = text => context.emit('text', text); } };
    const translator = new this.TranslationNode({ workerFactory: this.workerFactory, loadOptions: { cacheOnly: true }, requireSingleOutput: true });
    const sink = new TextOutputNode(text => this.active?.resolve(text));
    this.translation = new Pipeline({ nodes: { source, translator, sink }, connections: [
      { from: ['source', 'text'], to: ['translator', 'text'] },
      { from: ['translator', 'text'], to: ['sink', 'text'] },
    ], onError: error => this.failure(error.cause || error) });
    await this.translation.start();
    this.context.signal.throwIfAborted();
    this.onState('Local OPUS-MT ready');
  }
  emit(job, status, text = '', error = '') {
    if (this.disposed || this.context.signal.aborted) return;
    if (job.port === 'provisional' && job.version !== this.version) return;
    this.context.emit(job.port === 'provisional' ? 'provisionalResult' : 'finalResult',
      { source: job.source, index: job.index, status, text, error });
    // Pending/error notifications never enter a reusable text-processing path.
    if (status === 'complete') this.context.emit(job.port, text);
  }
  receive(port, source) {
    if (!['provisional', 'text'].includes(port) || typeof source !== 'string') throw new TypeError('Expected TEXT on provisional or text.');
    if (this.disposed || (port === 'provisional' && this.stopping)) return;
    if (!source.trim()) {
      this.version++; this.provisional = null;
      if (port === 'provisional') this.emit({ port, source: '', version: this.version }, 'complete');
      return;
    }
    const job = { port, source, version: ++this.version };
    if (port === 'text') {
      job.index = this.finalIndex++;
      this.provisional = null; // invalidate queued and in-flight provisional
    }
    if (this.error) { this.emit(job, 'error', '', this.error); return; }
    this.emit(job, 'pending');
    if (port === 'text') this.finals.push(job);
    else this.provisional = job;
    this.pump();
  }
  pump() {
    if (this.working || this.disposed) return;
    this.working = this.run().finally(() => { this.working = null;
      if (!this.disposed && !this.error && (this.finals.length || this.provisional)) this.pump();
    });
  }
  async run() {
    await this.ready;
    while (!this.disposed && !this.error && (this.finals.length || this.provisional)) {
      const job = this.finals.shift() || this.provisional;
      if (job === this.provisional) this.provisional = null;
      if (job.source.length > 1000) {
        this.emit(job, 'error', '', 'OPUS-MT accepts at most 1,000 characters per utterance.'); continue;
      }
      try {
        const text = await new Promise((resolve, reject) => {
          this.active = { job, resolve, reject };
          this.send(job.source);
        });
        this.emit(job, 'complete', text);
      } catch (error) { if (!this.disposed) this.emit(job, 'error', '', error.message); }
      finally { this.active = null; }
    }
  }
  failure(error) {
    if (this.disposed || this.error) return;
    this.error = error.message || String(error);
    this.onState(`Translation unavailable: ${this.error}`);
    this.active?.reject(error);
    for (const job of this.finals.splice(0)) this.emit(job, 'error', '', this.error);
    if (this.provisional) this.emit(this.provisional, 'error', '', this.error);
    this.provisional = null;
    void this.translation?.dispose().catch(() => {});
  }
  discardProvisional() { this.stopping = true; this.version++; this.provisional = null; }
  async stop() {
    this.discardProvisional();
    await this.ready;
    await this.working;
    if (!this.error && !this.disposed) await this.translation?.stop();
  }
  dispose() {
    this.disposed = true; this.provisional = null; this.finals = [];
    this.active?.reject(new DOMException('Translation canceled.', 'AbortError'));
    return this.translation?.dispose();
  }
}
