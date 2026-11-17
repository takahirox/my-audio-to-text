import { MONO_16KHZ_PCM, asrOutputs, ASR_OUTPUT_GROUPS } from './transcription-nodes.js';

// Shared Moonshine lifecycle and typed transcript delivery. Each concrete Node
// owns its Worker. A failed path reports unavailability without replacing models.
let utteranceSequence = 0;
export class OptionalAsrNode {
  inputs = { audio: MONO_16KHZ_PCM };
  outputs = asrOutputs();
  outputGroups = ASR_OUTPUT_GROUPS;
  provisionalOutputs = ['provisional', 'provisionalId'];
  constructor({ onEvent = () => {} } = {}) { this.onEvent = onEvent; }
  receiveEvent(event) {
    if (this.disposed || this.unavailable || this.stopped || this.context?.signal.aborted || !this.core) return;
    if (event.type === 'ready') this.loading?.resolve();
    else if (event.type === 'stopped') this.draining?.resolve();
    else if (event.type === 'error') {
      this.unavailable = true; this.core?.release();
      this.context?.emit('provisional', '');
      this.loading?.resolve(); this.draining?.resolve();
      this.onEvent({ ...event, branchUnavailable: true });
      return;
    } else if (event.type === 'partial' || event.type === 'final') {
      // Deduplicate worker finals here, before fan-out. Identical strings with
      // different utterance IDs remain distinct values; public IDs are allocated independently of core-local IDs.
      if (Number.isSafeInteger(event.id) && event.id >= 0) {
        if (event.id <= (this.lastFinalId ?? -1)) return;
        if (event.type === 'final') this.lastFinalId = event.id;
      }
      this.utteranceIds ??= new Map();
      if (!this.utteranceIds.has(event.id)) {
        if (!Number.isSafeInteger(++utteranceSequence)) throw RangeError('ASR utterance ID space exhausted.');
        this.utteranceIds.set(event.id, utteranceSequence);
      }
      const id = this.utteranceIds.get(event.id);
      if (event.type === 'final') {
        // Final and preview clear carry the same key in one delivery. The
        // preview output family remains provisional for downstream clear handling.
        this.context?.emitOutputs({ ...(this.outputs.provisional ? { provisional: '', provisionalId: id } : {}), final: event.text, finalId: id });
        this.utteranceIds.delete(event.id);
      } else this.context?.emitOutputs({ provisional: event.text, provisionalId: id }, { provisional: true });
    }
    this.onEvent(event);
  }
  load() {
    if (this.disposed || !this.core) return Promise.reject(new DOMException('Node disposed or transferred.', 'AbortError'));
    if (!this.loading) {
      this.loading = deferred();
      try { this.core.load(); } catch (error) { this.loading.reject(error); }
    }
    return this.loading.promise;
  }
  resetUtterances() { this.utteranceIds = new Map(); this.lastFinalId = undefined; }
  async start(context) {
    context.signal.throwIfAborted();
    this.resetUtterances(); this.context = context;
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    await this.load(); context.signal.throwIfAborted();
    if (!this.unavailable) try { this.core.start(); } catch (error) { this.receiveEvent({ type: 'error', message: error.message }); }
  }
  receive(port, value) {
    if (port !== 'audio') throw Error(`Unknown Moonshine input: ${port}`);
    this.core?.push(value);
  }
  stop() {
    if (this.unavailable) return Promise.resolve();
    if (!this.draining) { this.draining = deferred(); this.core.stop(); }
    return this.draining.promise.then(() => { this.stopped = true; this.context?.emit('provisional', ''); });
  }
  cancel(context) { context.emit('provisional', ''); }
  // A graph is single-use. After its graceful drain, move sole ownership of
  // the warm core to a fresh node without reloading models or sharing workers.
  nextSession({ onEvent = this.onEvent } = {}) {
    if (!this.stopped || this.disposed || this.context?.signal.aborted || this.core?.state !== 'ready') {
      throw new Error('A new speech session requires a successfully drained node.');
    }
    const next = new this.constructor({ onEvent });
    next.core = this.core; next.loading = deferred(); next.loading.resolve();
    next.core.onEvent = event => next.receiveEvent(event);
    this.core = null; this.context = null;
    return next;
  }
  dispose() {
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    this.context = null;
    this.core?.release();
    const error = new DOMException('Node disposed.', 'AbortError');
    this.loading?.reject(error); this.draining?.reject(error);
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
