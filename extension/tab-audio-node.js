import { BrowserTabAudioNode } from '../web/transcription-nodes.js';
import { ExtensionTab } from './tab-source.js';

// Reuse the shared capture lifecycle and normalized mono 16 kHz audio port.
export class ExtensionTabAudioNode extends BrowserTabAudioNode {
  constructor(tabId, { sourceFactory = (...args) => new ExtensionTab(...args), ...options } = {}) {
    super({ ...options, sourceFactory: (audio, ended) => sourceFactory(tabId, audio, ended) });
  }
  start(context) {
    // Stop can arrive before the pipeline has started this producer.
    if (this.endRequested) return this.stop();
    return super.start(context);
  }
  end() {
    this.endRequested = true;
    // Settle pending capture startup using the shared source's graceful flush;
    // a late media grant is cleaned up by BrowserAudioSource's cancellation.
    this.endCapture?.();
  }
}
