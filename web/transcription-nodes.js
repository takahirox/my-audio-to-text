import { BrowserTab, Microphone } from './audio.js';
import { portContract } from './pipeline.js';
import { TEXT, NUMBER } from './port-contracts.js';
export { TEXT } from './port-contracts.js';

export const MONO_16KHZ_PCM = portContract('mono 16 kHz Float32Array PCM');

export const asrOutputs = () => ({ provisional: TEXT, provisionalId: NUMBER, final: TEXT, finalId: NUMBER });
export const ASR_OUTPUT_GROUPS = [['provisional', 'provisionalId'], ['final', 'finalId']];

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

export class TranscriptOutputNode {
  inputs = { provisional: TEXT, final: TEXT };
  outputs = {};
  constructor(onTranscript = () => {}) { this.onTranscript = onTranscript; }
  receive(port, value, context) { return this.onTranscript(port, value, context.signal); }
}


function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
