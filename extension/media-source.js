import { Microphone } from '../web/audio.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';

export const SELECTED_MEDIA_UNAVAILABLE = 'SelectedPageMediaAudio is temporarily unavailable: Live no longer selects page media. Choose ChromeTabAudio in Graph Editor for now.';

// Selection on the target page is deferred to a separate task. Fail this
// source explicitly; Pipeline keeps independent complete branches running.
export class SelectedPageMediaAudioNode extends ExtensionTabAudioNode {
  constructor(options = {}) { super(null, options); }
  start() {
    throw Error(SELECTED_MEDIA_UNAVAILABLE);
  }
}
export class ExtensionMicrophoneAudioNode extends ExtensionTabAudioNode {
  constructor(stream, options = {}) {
    super(null, { ...options, sourceFactory: (_tab, audio, ended) => {
      const source = new Microphone(audio, ended);
      source.getMedia = async () => {
        if (!this.stream) throw Error('Press Start in Live to permit microphone capture.');
        return this.stream;
      };
      return source;
    } });
    this.stream = stream;
  }
  dispose() { this.stream?.getTracks().forEach(track => track.stop()); return super.dispose(); }
}
