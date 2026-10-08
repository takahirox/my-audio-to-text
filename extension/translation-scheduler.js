import { Pipeline, portContract } from '../web/pipeline.js';
import { TRANSCRIPT } from '../web/transcription-nodes.js';
import { OpusMtTranslationNode, TEXT, TextOutputNode } from '../web/translation-nodes.js';

export const TRANSLATION = portContract('paired translation { source, text, status, index }');

// Session-owned adapter, not a generic queue: one in flight, one replaceable
// provisional, and a FIFO of finals. receive() never waits for inference, so
// Pipeline's input serialization cannot accumulate obsolete provisional work.
export class TranslationSchedulerNode {
  inputs = { provisional: TRANSCRIPT, final: TRANSCRIPT };
  outputs = { provisional: TRANSLATION, final: TRANSLATION };
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
    this.context.emit(job.port, { source: job.source, index: job.index, status, text, error });
  }
  receive(port, source) {
    if (this.disposed || (port === 'provisional' && this.stopping)) return;
    if (!source.text.trim()) {
      this.version++; this.provisional = null;
      return;
    }
    const job = { port, source: { ...source }, version: ++this.version };
    if (port === 'final') {
      job.index = this.finalIndex++;
      this.provisional = null; // invalidate queued and in-flight provisional
    }
    if (this.error) { this.emit(job, 'error', '', this.error); return; }
    this.emit(job, 'pending');
    if (port === 'final') this.finals.push(job);
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
      if (job.source.text.length > 1000) {
        this.emit(job, 'error', '', 'OPUS-MT accepts at most 1,000 characters per utterance.'); continue;
      }
      try {
        const text = await new Promise((resolve, reject) => {
          this.active = { job, resolve, reject };
          this.send(job.source.text);
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
