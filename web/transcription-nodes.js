import { BrowserTab, Microphone } from './audio.js';
import { LocalAsrCore } from './local-asr-core.js';
import { Pipeline, portContract } from './pipeline.js';
import { TRANSCRIPT } from './port-contracts.js';
export { TRANSCRIPT } from './port-contracts.js';

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
  inputs = { audio: MONO_16KHZ_PCM };
  outputs = { provisional: TRANSCRIPT, final: TRANSCRIPT };
  constructor({ onEvent = () => {}, workerFactory } = {}) {
    this.onEvent = onEvent;
    // This node alone owns the existing isolated ASR and VAD workers.
    this.core = new LocalAsrCore(event => this.receiveEvent(event), { workerFactory });
  }
  receiveEvent(event) {
    if (this.disposed || !this.core) return;
    if (event.type === 'ready') this.loading?.resolve();
    else if (event.type === 'stopped') this.draining?.resolve();
    else if (event.type === 'error') {
      const error = new Error(event.message);
      this.loading?.reject(error); this.draining?.reject(error);
      this.context?.fail(error);
    } else if (event.type === 'partial' || event.type === 'final') {
      this.context?.emit(event.type === 'partial' ? 'provisional' : 'final', {
        text: event.text, id: event.id,
      });
    }
    this.onEvent(event);
  }
  // Optional preloading lets the UI load models before the capture gesture.
  load() {
    if (this.disposed || !this.core) return Promise.reject(new DOMException('Node disposed or transferred.', 'AbortError'));
    if (!this.loading) {
      this.loading = deferred();
      try { this.core.load(); } catch (error) { this.loading.reject(error); }
    }
    return this.loading.promise;
  }
  async start(context) {
    this.context = context;
    await this.load();
    context.signal.throwIfAborted();
    this.core.start();
  }
  receive(port, audio) { this.core.push(audio); }
  stop() {
    if (!this.draining) {
      this.draining = deferred();
      this.core.stop();
    }
    return this.draining.promise.then(() => { this.stopped = true; });
  }
  // A graph is single-use. After its graceful drain, move sole ownership of
  // the warm core to a fresh node without reloading models or sharing workers.
  nextSession({ onEvent = this.onEvent } = {}) {
    if (!this.stopped || this.disposed || this.context?.signal.aborted || this.core?.state !== 'ready') {
      throw new Error('A new speech session requires a successfully drained node.');
    }
    const next = new SpeechToTextNode({ onEvent });
    next.core = this.core; next.loading = deferred(); next.loading.resolve();
    next.core.onEvent = event => next.receiveEvent(event);
    this.core = null; this.context = null;
    return next;
  }
  dispose() {
    this.disposed = true; this.context = null;
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
  inputs = { provisional: TRANSCRIPT, final: TRANSCRIPT };
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
