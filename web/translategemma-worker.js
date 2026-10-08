import { TRANSLATE_GEMMA } from './translation-models.js';
import { serveTranslationWorker, translationRuntime, modelLoadError } from './translation-worker.js';

serveTranslationWorker(async progress => {
  // Check in the processing Worker: window support alone is insufficient.
  if (!self.navigator.gpu) throw new Error('TranslateGemma requires WebGPU in a secure browser Worker. Use a supported browser/device on HTTPS or localhost.');
  if (!await self.navigator.gpu.requestAdapter()) throw new Error('No WebGPU adapter is available for TranslateGemma on this device.');
  let translate;
  try {
    const { pipeline } = await translationRuntime();
    translate = await pipeline('text-generation', TRANSLATE_GEMMA.id, {
      ...TRANSLATE_GEMMA, progress_callback: progress,
    });
  } catch (error) { throw modelLoadError(error); }
  return async text => {
    const messages = [{ role: 'user', content: [{
      type: 'text', source_lang_code: 'ja', target_lang_code: 'en', text,
    }] }];
    const result = await translate(messages, { max_new_tokens: 256, do_sample: false });
    return result.map(value => {
      const messages = value.generated_text;
      const assistant = Array.isArray(messages) ? messages.at(-1) : null;
      if (assistant?.role !== 'assistant' || typeof assistant.content !== 'string') {
        throw new Error('TranslateGemma returned an invalid assistant translation.');
      }
      return assistant.content.trim();
    });
  };
});
