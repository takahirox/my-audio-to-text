import { Pipeline } from '../web/pipeline.js';
import { OpusMtTranslationNode, TEXT, TextOutputNode } from '../web/translation-nodes.js';

export const TRANSLATION_OUTPUTS = Object.freeze({ source: TEXT, text: TEXT, error: TEXT });

// Session-owned FIFO of committed utterances. Ordering and request IDs stay internal.
export class TranslationSchedulerNode {
  inputs = { text: TEXT };
  outputs = TRANSLATION_OUTPUTS;
  constructor({ prepare, workerFactory, TranslationNode = OpusMtTranslationNode, modelName = 'OPUS-MT', onState = () => {} } = {}) {
    this.TranslationNode = TranslationNode; this.prepare = prepare; this.workerFactory = workerFactory; this.onState = onState;
    this.modelName = modelName;
    this.finals = [];
  }
  start(context) {
    this.context = context;
    this.onState(`Loading local ${this.modelName}…`);
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
    this.onState(`Local ${this.modelName} ready`);
  }
  emit(job, text, error = '') {
    if (this.disposed || this.context.signal.aborted) return;
    this.context.emitOutputs({ source: job.source, error, ...(error ? {} : { text }) });
  }
  receive(port, source) {
    if (port !== 'text' || typeof source !== 'string') throw new TypeError('Expected TEXT on text.');
    if (this.disposed) return;
    // Empty utterances still have a position in the FIFO; they need no inference.
    this.finals.push({ source });
    this.pump();
  }
  pump() {
    if (this.working || this.disposed) return;
    this.working = this.run().finally(() => { this.working = null;
      if (!this.disposed && this.finals.length) this.pump();
    });
  }
  async run() {
    await this.ready;
    while (!this.disposed && this.finals.length) {
      const job = this.finals.shift();
      if (!job.source.trim()) { this.emit(job, ''); continue; }
      if (this.error) { this.emit(job, undefined, this.error); continue; }
      if (job.source.length > 1000) {
        this.emit(job, undefined, `${this.modelName} accepts at most 1,000 characters per utterance.`); continue;
      }
      try {
        const text = await new Promise((resolve, reject) => {
          this.active = { job, resolve, reject };
          this.send(job.source);
        });
        this.emit(job, text);
      } catch (error) { if (!this.disposed) this.emit(job, undefined, error?.message || String(error)); }
      finally { this.active = null; }
    }
  }
  failure(error) {
    if (this.disposed || this.error) return;
    this.error = error?.message || String(error);
    this.onState(`Translation unavailable: ${this.error}`);
    this.active?.reject(error);
    void this.translation?.dispose().catch(() => {});
  }
  async stop() {
    await this.ready;
    await this.working;
    if (!this.error && !this.disposed) await this.translation?.stop();
  }
  dispose() {
    this.disposed = true; this.finals = [];
    this.active?.reject(new DOMException('Translation canceled.', 'AbortError'));
    return this.translation?.dispose();
  }
}
