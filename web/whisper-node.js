import { SpeechToTextNode, MONO_16KHZ_PCM, TEXT } from './transcription-nodes.js';
import { LocalAsrCore } from './local-asr-core.js';
import { whisperLanguage } from './whisper-config.js';

// Reuses the bounded Silero segment queue and lifecycle; only completed speech
// goes to Whisper. It never performs or publishes provisional inference.
export class SpeechToTextWhisperNode extends SpeechToTextNode {
  inputs = { audio: MONO_16KHZ_PCM, language: TEXT };
  outputs = { final: TEXT };
  configurationPort = 'language';
  constructor({ language = 'en', workerFactory, ...options } = {}) {
    super({ ...options, maxDuration: 6 });
    this.language = whisperLanguage(language);
    this.core = new LocalAsrCore(event => this.receiveEvent(event), {
      whisper: true,
      workerFactory: workerFactory || (path => new Worker(new URL(path, import.meta.url),
        path.endsWith('whisper-worker.js') ? { type: 'module' } : {})),
    });
  }
  load(options) { if (this.core) this.core.language = this.language; return super.load(options); }
  receive(port, value) {
    if (port === 'language') {
      if (this.loading || (this.context && !this.waitingConfiguration)) throw new Error('Whisper.language must be configured before model loading and session startup.');
      this.language = whisperLanguage(value);
      if (this.context) return this.begin();
    } else if (port === 'audio') super.receive(port, value);
    else throw new Error(`Unknown Whisper input: ${port}`);
  }
  nextSession(options = {}) {
    const next = super.nextSession(options);
    next.language = this.language;
    return next;
  }
}
