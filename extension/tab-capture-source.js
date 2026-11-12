import { BrowserAudioSource, Resampler } from '../web/audio.js';

// Offscreen-only native owner. An authorized, equally isolated Live page mints
// the one-use ID; a nonisolated service worker cannot supply this renderer.
export class CapturedTabSource extends BrowserAudioSource {
  constructor(tabId, onAudio, onEnded, getStreamId) {
    super(onAudio, onEnded); this.captureTimestamps = true; this.tabId = tabId; this.getStreamId = getStreamId;
    this.workletURL = new URL('../web/capture-worklet.js', import.meta.url).href;
    this.noAudioMessage = 'No tab audio is available. Play audio in the source tab and Start again.';
  }
  async getMedia() {
    const id = await this.getStreamId(this.tabId).catch(error => { throw Error(`Chrome could not authorize tab audio: ${error.message}`); });
    this.checkCanceled();
    return navigator.mediaDevices.getUserMedia({ audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id },
    }, video: false }).catch(error => { throw Error(`Chrome could not open the tab audio device: ${error.message}`); });
  }
  async start() {
    await super.start(); this.checkCanceled();
    // One audible branch per native capture; the PCM processor stays muted.
    this.source.connect(this.context.destination);
  }
  async drain() {
    if (this.draining) return this.draining;
    this.checkCanceled();
    const operation = new Promise((resolve, reject) => {
      const port = this.node?.port;
      const snapshot = () => {
        // Flush a copy so a departing graph gets its final sample without
        // padding/resetting the live resampler used by the remaining graphs.
        const copy = new Resampler(this.context.sampleRate);
        copy.position = this.resampler.position; copy.tail = this.resampler.tail.slice();
        return { audio: copy.flush(), timing: { capturedAt: this.nextAudioTime } };
      };
      if (!port) { resolve(snapshot()); return; }
      const request = { type: 'drain', id: this.drainSequence = (this.drainSequence || 0) + 1 };
      const cleanup = () => {
        clearTimeout(timer); port.removeEventListener('message', drained); this.cancelDrain = null;
      };
      const drained = ({ data }) => {
        if (data?.type !== 'drained' || data.id !== request.id) return;
        cleanup(); resolve(snapshot());
      };
      this.cancelDrain = () => { cleanup(); reject(new DOMException('Capture canceled', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Tab audio flush timed out. Start this graph again.')); }, 500);
      port.addEventListener('message', drained);
      try { port.postMessage(request); } catch (error) { cleanup(); reject(error); }
    });
    this.draining = operation;
    try { return await operation; } finally { if (this.draining === operation) this.draining = null; }
  }
  stop(flush = true) {
    this.cancelDrain?.();
    return super.stop(flush);
  }
}
