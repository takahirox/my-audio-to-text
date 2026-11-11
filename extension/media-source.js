import { Microphone } from '../web/audio.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';

export const SELECTED_MEDIA_UNAVAILABLE = 'SelectedPageMediaAudio is temporarily unavailable: Live no longer selects page media. Choose ChromeTabAudio in Graph Editor for now.';

export function microphoneCaptureError(error) {
  const recovery = {
    NotAllowedError: 'Allow microphone access for the extension in Chrome and your OS privacy settings, then retry this session.',
    SecurityError: 'Allow microphone access for the extension in Chrome and your OS privacy settings, then retry this session.',
    NotFoundError: 'Connect or enable a microphone and check the default input device, then retry this session.',
    NotReadableError: 'Check the microphone connection and OS input settings; the device could not provide another audio stream. Retry this session when the device is available.',
    OverconstrainedError: 'Choose an available microphone in Chrome input settings, then retry this session.',
  }[error.name] || 'Check Chrome microphone permission, the input device and available system resources, then retry this session.';
  return Error(`Microphone capture unavailable: ${error.message || error}. ${recovery}`, { cause: error });
}

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
      if (options.microphoneSourceFactory) return options.microphoneSourceFactory(audio, ended);
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
