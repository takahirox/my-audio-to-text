import { BrowserAudioSource } from '../web/audio.js';

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
}
