import { BrowserAudioSource } from '../web/audio.js';

export class ExtensionTab extends BrowserAudioSource {
  constructor(tabId, onAudio, onEnded) {
    super(onAudio, onEnded);
    this.tabId = tabId;
    this.workletURL = new URL('../web/capture-worklet.js', import.meta.url).href;
    this.noAudioMessage = 'No tab audio is available. Play audio in the selected tab and invoke the extension again.';
  }
  async getMedia() {
    if (!globalThis.chrome?.tabCapture?.getMediaStreamId) {
      throw new Error('Tab capture is unavailable. Load the unpacked extension in desktop Chrome 116 or later.');
    }
    const id = await chrome.tabCapture.getMediaStreamId({ targetTabId: this.tabId });
    this.checkCanceled();
    return navigator.mediaDevices.getUserMedia({ audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id },
    }, video: false });
  }
  async start() {
    await super.start();
    this.checkCanceled();
    // Chrome suppresses original playback. Restore it once, separately from the
    // muted capture processor; this branch never feeds another ASR input.
    this.source.connect(this.context.destination);
  }
}
