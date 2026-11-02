import { NUMBER } from '../web/port-contracts.js';
import { finiteNumber } from '../web/number-node.js';
import { Pipeline } from '../web/pipeline.js';
import { OpusMtTranslationNode, TEXT, TextOutputNode } from '../web/translation-nodes.js';
import { validateTranslateGemmaContext } from '../web/translategemma-context.js';

export const TRANSLATION_OUTPUT_GROUPS = Object.freeze([
  Object.freeze(['source', 'text', 'error', 'id']),
  Object.freeze(['provisionalSource', 'provisionalText', 'provisionalError', 'provisionalId']),
]);
export const TRANSLATION_OUTPUTS = Object.freeze(Object.fromEntries(TRANSLATION_OUTPUT_GROUPS.flat().map(port => [port, port === 'id' || port === 'provisionalId' ? NUMBER : TEXT])));

// Session-owned FIFO of committed utterances. Ordering and request IDs stay internal.
export class TranslationSchedulerNode {
  inputs = { text: TEXT, provisional: TEXT, id: NUMBER, provisionalId: NUMBER };
  outputs = TRANSLATION_OUTPUTS;
  outputGroups = TRANSLATION_OUTPUT_GROUPS;
  constructor({ prepare, workerFactory, TranslationNode = OpusMtTranslationNode, modelName = 'OPUS-MT', onState = () => {} } = {}) {
    this.TranslationNode = TranslationNode; this.prepare = prepare; this.workerFactory = workerFactory; this.onState = onState;
    this.modelName = modelName;
    this.acceptsContext = TranslationNode.supportsContext === true;
    if (this.acceptsContext) this.inputs = { ...this.inputs, context: TEXT };
    this.translationContext = '';
    this.ids = {};
    this.finals = [];
    this.revision = 0; this.queuedChars = 0;
  }
  start(context) {
    this.context = context;
    this.abort = () => { void Promise.resolve(this.dispose()).catch(() => {}); };
    context.signal.addEventListener('abort', this.abort, { once: true });
    this.onState(`Loading local ${this.modelName}…`);
    this.ready = this.load().catch(error => { this.failure(error); });
  }
  async load() {
    await this.prepare?.(this.context.signal);
    this.context.signal.throwIfAborted();
    const source = { inputs: {}, outputs: { text: TEXT }, start: context => { this.send = text => context.emit('text', text); } };
    // Read the active job's accepted snapshot, never the mutable latest context.
    const translator = new this.TranslationNode({ workerFactory: this.workerFactory, loadOptions: { cacheOnly: true }, requireSingleOutput: true,
      getTranslationContext: () => this.active?.job.translationContext ?? '' });
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
    if (job.provisional && job.revision !== this.revision) return;
    // Per-utterance validation errors must reach diagnostics even when the
    // generic formatter (or any other consumer) leaves error disconnected.
    if (error && !this.error) this.onState(`Translation unavailable: ${error}`);
    const [sourcePort, textPort, errorPort, idPort] = this.outputGroups[job.provisional ? 1 : 0];
    (job.context || this.context).emitOutputs({ ...(job.id === undefined ? {} : { [idPort]: job.id }), [sourcePort]: job.source, [errorPort]: error, ...(error ? {} : { [textPort]: text }) }, { provisional: job.provisional === true });
  }
  clearPreview(context = this.context) {
    if (!this.hasPreview) return;
    this.hasPreview = false;
    // An ordinary TEXT route clears the preview as soon as a final is accepted,
    // even while an obsolete inference still owns the single Worker.
    this.emit({ source: '', id: this.previewId, provisional: true, revision: this.revision, context }, '');
    this.previewId = undefined;
  }
  receiveInputs(values, context = this.context) {
    if (this.disposed || context?.signal.aborted) return;
    for (const [port, value] of Object.entries(values)) {
      if (port === 'id' || port === 'provisionalId') { finiteNumber(value, port); continue; }
      if (!Object.hasOwn(this.inputs, port) || typeof value !== 'string') throw TypeError(this.acceptsContext
        ? 'Expected TEXT on text, provisional or context.' : 'Expected TEXT on text or provisional.');
    }
    // Apply metadata before accepting either target, irrespective of port order.
    if (Object.hasOwn(values, 'context')) {
      validateTranslateGemmaContext(values.context);
      this.translationContext = values.context;
    }
    for (const [id, text] of [['id', 'text'], ['provisionalId', 'provisional']]) {
      if (Object.hasOwn(values, id)) this.ids[id] = values[id];
      // An explicit snapshot without an ID cannot borrow a previous job's ID.
      else if (Object.hasOwn(values, text) && context.groupInputs?.includes(id)) delete this.ids[id];
    }
    // A combined committed/preview delivery accepts only the committed target.
    if (Object.hasOwn(values, 'text')) return this.accept('text', values.text, context, this.ids.id);
    if (Object.hasOwn(values, 'provisional')) return this.accept('provisional', values.provisional, context, this.ids.provisionalId);
  }
  receive(port, value, context = this.context) { return this.receiveInputs({ [port]: value }, context); }
  accept(port, source, context, id) {
    if (port === 'provisional' && source.length > 1000) throw Error('Provisional translation accepts at most 1,000 characters.');
    this.revision++;
    const snapshot = { ...(id === undefined ? {} : { id }), ...(this.acceptsContext ? { translationContext: this.translationContext } : {}) };
    // One replaceable pending preview, and at most one running inference.
    // Committed input invalidates every older preview regardless of producer.
    this.preview = port === 'provisional' ? { source, provisional: true, revision: this.revision, context, ...snapshot } : null;
    if (port === 'provisional') { this.previewId = id; this.hasPreview = true; this.pump(); return; }
    this.clearPreview(context);
    // Bound closed work too. Overflow is an explicit branch failure, never a
    // silently dropped utterance; the existing default FIFO remains unchanged.
    if (this.finals.length >= 32 || this.queuedChars + source.length > 32768) throw Error('Translation backlog limit exceeded (32 windows / 32,768 characters).');
    // Empty utterances still have a position in the FIFO; they need no inference.
    this.finals.push({ source, context, ...snapshot });
    this.queuedChars += source.length;
    this.pump();
  }
  pump() {
    if (this.working || this.disposed) return;
    this.working = this.run().finally(() => { this.working = null;
      if (!this.disposed && (this.finals.length || this.preview)) this.pump();
    });
  }
  async run() {
    await this.ready;
    while (!this.disposed && (this.finals.length || this.preview)) {
      const job = this.finals.length ? this.finals.shift() : this.preview;
      if (job.provisional) this.preview = null;
      else this.queuedChars -= job.source.length;
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
    this.preview = null; this.revision++;
    this.clearPreview();
    await this.ready;
    await this.working;
    if (!this.error && !this.disposed) await this.translation?.stop();
    this.translationContext = '';
  }
  cancel(context) {
    // Pipeline has already aborted inference. Publish only a cleanup snapshot
    // through the explicit preview family, using its live cleanup context.
    if (this.hasPreview) {
      this.hasPreview = false;
      context.emitOutputs({ ...(this.previewId === undefined ? {} : { provisionalId: this.previewId }), provisionalSource: '', provisionalText: '', provisionalError: '' }, { provisional: true });
    }
    return this.dispose();
  }
  dispose() {
    this.context?.signal.removeEventListener('abort', this.abort);
    this.disposed = true; this.finals = []; this.preview = null; this.queuedChars = 0;
    this.translationContext = '';
    this.active?.reject(new DOMException('Translation canceled.', 'AbortError'));
    return this.translation?.dispose();
  }
}
