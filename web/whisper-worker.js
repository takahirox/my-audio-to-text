import { WHISPER_MODEL, whisperLanguage } from './whisper-config.js';
import { translationRuntime } from './translation-worker.js';

let recognizer, language, sequence = Promise.resolve();
self.onmessage = ({ data }) => {
  sequence = sequence.then(async () => {
    try {
      if (data.type === 'load') {
        language = whisperLanguage(data.language);
        const { pipeline, env } = await translationRuntime();
        const { localModelAssets } = await import('./local-model-assets.js');
        const { cacheOnlyWhisperRuntime } = await localModelAssets('whisper', message => self.postMessage({ type: 'progress', message }));
        await cacheOnlyWhisperRuntime(env);
        recognizer = await pipeline('automatic-speech-recognition', WHISPER_MODEL.source, {
          dtype: WHISPER_MODEL.dtype, device: WHISPER_MODEL.device, revision: WHISPER_MODEL.revision,
          progress_callback: event => self.postMessage({ type: 'progress', message: `Loading verified Whisper: ${event.status}` }),
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
        message: `Local Whisper failed: ${error.message}. Open Models or Graph Editor and retry preparation, then start a fresh session.` });
    }
  });
};
