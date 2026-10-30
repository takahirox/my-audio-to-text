import { BrowserTab, Microphone } from './audio.js';
import { LocalAsrCore } from './local-asr-core.js';
import { Pipeline, portContract } from './pipeline.js';
import { TEXT, NUMBER } from './port-contracts.js';
import { ASR_CONFIG, maxDurationSamples } from './local-asr-config.js';
export { TEXT } from './port-contracts.js';

export const MONO_16KHZ_PCM = portContract('mono 16 kHz Float32Array PCM');

// Capture and diagnostics remain source policy, outside the generic runtime.
class BrowserAudioNode {
  inputs = {};
  outputs = { audio: MONO_16KHZ_PCM };
  constructor({ onEnded, onAudio = () => {}, sourceFactory }) {
    this.onEnded = onEnded; this.onAudio = onAudio; this.sourceFactory = sourceFactory;
  }
  start(context) {
    const ended = deferred();
    this.endCapture = () => {
      if (context.signal.aborted || this.ending || this.disposed || this.stopped) return;
      this.ending = true;
      // Sharing/hiding can end capture while permission or worklet setup is
      // pending. Close now and let startup finish so the graph can drain.
      this.stop().then(ended.resolve, ended.reject);
      this.onEnded?.();
    };
    this.source = this.sourceFactory(
      audio => {
        if (context.signal.aborted || this.disposed || this.stopped) return;
        try { this.onAudio(audio); context.emit('audio', audio); }
        catch (error) { context.fail(error); }
      },
      this.endCapture,
    );
    return Promise.race([
      Promise.resolve(this.source.start()).catch(error => {
        if (this.ending) return ended.promise;
        throw error;
      }),
      ended.promise,
    ]);
  }
  stop() {
    return this.stopping ??= Promise.resolve().then(() => this.source?.stop()).then(() => { this.stopped = true; });
  }
  dispose() {
    this.disposed = true;
    // A completed graceful stop has already released capture. Cancellation
    // during a pending flush must still interrupt it with stop(false).
    if (!this.stopped) return this.source?.stop(false);
  }
}

export class BrowserTabAudioNode extends BrowserAudioNode {
  constructor({ sourceFactory = (audio, ended) => new BrowserTab(audio, ended), ...options } = {}) {
    super({ ...options, sourceFactory });
  }
}

export class MicrophoneAudioNode extends BrowserAudioNode {
  constructor({ sourceFactory = (audio, ended) => new Microphone(audio, ended), ...options } = {}) {
    super({ ...options, sourceFactory });
  }
  start(context) {
    // Keep microphone stop-on-hide policy with the source, including while
    // permission is pending. Tab nodes deliberately have no visibility hook.
    if (typeof document !== 'undefined') {
      this.visibility = () => { if (document.hidden) this.endCapture(); };
      document.addEventListener('visibilitychange', this.visibility);
    }
    return super.start(context);
  }
  removeVisibility() {
    if (this.visibility) document.removeEventListener('visibilitychange', this.visibility);
    this.visibility = null;
  }
  stop() { this.removeVisibility(); return super.stop(); }
  dispose() { this.removeVisibility(); return super.dispose(); }
}

export class SpeechToTextNode {
  inputs = { audio: MONO_16KHZ_PCM, maxDuration: NUMBER };
  outputs = { provisional: TEXT, final: TEXT };
  configurationPort = 'maxDuration';
  constructor({ onEvent = () => {}, workerFactory, maxDuration = ASR_CONFIG.defaultMaxDurationSeconds, configurationConnected = false } = {}) {
    maxDurationSamples(maxDuration); this.maxDuration = maxDuration;
    this.onEvent = onEvent; this.configurationConnected = configurationConnected;
    // This node alone owns the existing isolated ASR and VAD workers.
    this.core = new LocalAsrCore(event => this.receiveEvent(event), { workerFactory });
  }
  receiveEvent(event) {
    if (this.disposed || this.stopped || !this.core) return;
    if (event.type === 'ready') this.loading?.resolve();
    else if (event.type === 'stopped') this.draining?.resolve();
    else if (event.type === 'error') {
      const error = new Error(event.message);
      this.loading?.reject(error); this.draining?.reject(error);
      this.context?.fail(error);
    } else if (event.type === 'partial' || event.type === 'final') {
      // Deduplicate worker finals here, before fan-out. Identical strings with
      // different utterance IDs remain distinct values; IDs stay core-local.
      if (Number.isSafeInteger(event.id) && event.id >= 0) {
        if (event.id <= (this.lastFinalId ?? -1)) return;
        if (event.type === 'final') this.lastFinalId = event.id;
      }
      // One atomic finalization: translators let final win over the
      // cleared preview, preserving causal identity and avoiding an empty preview
      // translation. Clear here, never on completion of delayed downstream work.
      if (event.type === 'final' && this.outputs.provisional) {
        this.context?.emitOutputs({ provisional: '', final: event.text });
      } else this.context?.emit(event.type === 'partial' ? 'provisional' : 'final', event.text);
    }
    this.onEvent(event);
  }
  // Optional preloading lets the UI load models before the capture gesture.
  load({ connectedInputs } = {}) {
    if (connectedInputs) {
      this.waitingConfiguration = this.configurationConnected || connectedInputs.includes(this.configurationPort);
    }
    if (this.disposed || !this.core) return Promise.reject(new DOMException('Node disposed or transferred.', 'AbortError'));
    if (this.waitingConfiguration) return Promise.resolve();
    if (!this.loading) {
      this.loading = deferred();
      try { this.core.load(); } catch (error) { this.loading.reject(error); }
    }
    return this.loading.promise;
  }
  start(context) {
    context.signal.throwIfAborted();
    this.context = context;
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    this.waitingConfiguration = this.configurationConnected || context.connectedInputs?.includes(this.configurationPort) === true;
    this.pendingAudio = []; this.pendingSamples = 0;
    if (this.waitingConfiguration) {
      this.onEvent({ type: 'progress', message: `Waiting for startup ${this.configurationPort}. Model has not started.` });
      return;
    }
    return this.begin();
  }
  begin() {
    this.waitingConfiguration = false;
    this.sessionMaxDuration = this.maxDuration;
    const context = this.context;
    return this.ready = this.load().then(() => {
      context.signal.throwIfAborted();
      this.core.start({ maxDuration: this.sessionMaxDuration });
      for (const audio of this.pendingAudio) this.core.push(audio);
      this.pendingAudio = []; this.pendingSamples = 0;
    });
  }
  receive(port, value) {
    if (port === 'maxDuration') {
      if (this.loading || (this.context && !this.waitingConfiguration)) throw new Error('SpeechToText.maxDuration must be configured before session startup and model loading.');
      maxDurationSamples(value); this.maxDuration = value;
      if (this.context) return this.begin();
    } else if (port === 'audio') {
      if (this.disposed) return;
      if (this.waitingConfiguration) {
        if (!(value instanceof Float32Array)) throw TypeError('ASR input must be mono 16 kHz Float32Array PCM.');
        if (!value.length) return;
        if (this.pendingSamples + value.length > 480000) throw Error(`Startup ${this.configurationPort} unavailable before 30 seconds of audio. Supply a value before model startup.`);
        this.pendingAudio.push(value.slice()); this.pendingSamples += value.length;
      } else this.core.push(value);
    } else throw new Error(`Unknown SpeechToText input: ${port}`);
  }
  stop() {
    if (this.waitingConfiguration) throw Error(`Startup ${this.configurationPort} unavailable; model never started.`);
    if (this.ready && this.core.state === 'loading') return this.ready.then(() => this.stop());
    if (!this.draining) {
      this.draining = deferred();
      this.core.stop();
    }
    return this.draining.promise.then(() => {
      this.stopped = true;
      if (this.outputs.provisional) this.context?.emit('provisional', '');
    });
  }
  cancel(context) {
    if (this.outputs.provisional) context.emit('provisional', '');
  }
  // A graph is single-use. After its graceful drain, move sole ownership of
  // the warm core to a fresh node without reloading models or sharing workers.
  nextSession({ onEvent = this.onEvent, maxDuration = this.maxDuration } = {}) {
    if (!this.stopped || this.disposed || this.context?.signal.aborted || this.core?.state !== 'ready') {
      throw new Error('A new speech session requires a successfully drained node.');
    }
    const next = new this.constructor({ onEvent, maxDuration });
    next.core = this.core; next.loading = deferred(); next.loading.resolve();
    next.core.onEvent = event => next.receiveEvent(event);
    this.core = null; this.context = null;
    return next;
  }
  dispose() {
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    this.context = null; this.pendingAudio = []; this.pendingSamples = 0;
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

export class TranscriptOutputNode {
  inputs = { provisional: TEXT, final: TEXT };
  outputs = {};
  constructor(onTranscript = () => {}) { this.onTranscript = onTranscript; }
  receive(port, value, context) { return this.onTranscript(port, value, context.signal); }
}

export function createTabTranscriptionPipeline({ onTranscript, onEvent, onError, workerFactory, sourceFactory } = {}) {
  const speech = new SpeechToTextNode({ onEvent, workerFactory });
  const transcript = new TranscriptOutputNode(onTranscript);
  let pipeline;
  const tab = new BrowserTabAudioNode({ sourceFactory, onEnded: () => {
    void pipeline.stop().catch(() => {}); // failures are also reported through onError
  } });
  pipeline = new Pipeline({ nodes: { tab, speech, transcript }, onError, connections: [
    { from: ['tab', 'audio'], to: ['speech', 'audio'] },
    { from: ['speech', 'provisional'], to: ['transcript', 'provisional'] },
    { from: ['speech', 'final'], to: ['transcript', 'final'] },
  ] });
  return { pipeline, tab, speech, transcript };
}
