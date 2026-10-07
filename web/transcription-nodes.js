import { BrowserTab } from './audio.js';
import { LocalAsrCore } from './local-asr-core.js';
import { Pipeline, portContract } from './pipeline.js';

export const MONO_16KHZ_PCM = portContract('mono 16 kHz Float32Array PCM');
export const TRANSCRIPT = portContract('transcript { text, id }');

export class BrowserTabAudioNode {
  inputs = {};
  outputs = { audio: MONO_16KHZ_PCM };
  constructor({ onEnded, sourceFactory = (audio, ended) => new BrowserTab(audio, ended) } = {}) {
    this.onEnded = onEnded; this.sourceFactory = sourceFactory;
  }
  start(context) {
    this.source = this.sourceFactory(
      audio => context.emit('audio', audio),
      () => { if (!context.signal.aborted) this.onEnded?.(); },
    );
    return this.source.start();
  }
  stop() { return this.source?.stop(); }
  dispose() { return this.source?.stop(false); }
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
    if (this.disposed) return Promise.reject(new DOMException('Node disposed.', 'AbortError'));
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
    return this.draining.promise;
  }
  dispose() {
    this.disposed = true; this.context = null;
    this.core.release();
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
