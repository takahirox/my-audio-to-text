import { WHISPER_MODEL, whisperLanguage } from './whisper-config.js';
import { translationRuntime } from './translation-worker.js';

let recognizer, language, sequence = Promise.resolve();
self.onmessage = ({ data }) => {
  sequence = sequence.then(async () => {
    try {
      if (data.type === 'load') {
        language = whisperLanguage(data.language);
        const { pipeline, env } = await translationRuntime();
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.useBrowserCache = false;
        env.localModelPath = new URL('./vendor/whisper/', import.meta.url).href;
        recognizer = await pipeline('automatic-speech-recognition', WHISPER_MODEL.id, {
          dtype: WHISPER_MODEL.dtype, device: WHISPER_MODEL.device,
          progress_callback: event => self.postMessage({ type: 'progress', message: `Loading packaged Whisper: ${event.status}` }),
        });
        self.postMessage({ type: 'configuration', model: 'whisper-tiny', modelName: 'Whisper tiny (multilingual, q8)', numThreads: 1 });
        self.postMessage({ type: 'ready' });
      } else if (data.type === 'decode') {
        if (!recognizer || !data.final || !(data.audio instanceof Float32Array) || data.audio.length > 96000) throw new Error('Invalid Whisper segment; expected completed mono 16 kHz PCM up to 6 seconds.');
        const result = await recognizer(data.audio, { language, task: 'transcribe', do_sample: false });
        if (typeof result.text !== 'string') throw new Error('Whisper returned invalid text.');
        self.postMessage({ type: 'final', session: data.session, id: data.id, text: result.text.trim() });
        self.postMessage({ type: 'decoded', session: data.session });
      } else throw new Error(`Unknown Whisper request: ${data.type}`);
    } catch (error) {
      self.postMessage({ type: 'error', session: data.session,
        message: `Local Whisper failed: ${error.message}. Verify packaged models with npm run prepare:whisper-assets and rebuild the extension; retry with a fresh session.` });
    }
  });
};
