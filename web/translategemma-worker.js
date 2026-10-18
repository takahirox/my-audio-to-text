import { TRANSLATE_GEMMA } from './translation-models.js';
import { serveTranslationWorker, translationRuntime, modelLoadError } from './translation-worker.js';

serveTranslationWorker(async (progress, { cacheOnly = false, direction = 'ja-en' } = {}) => {
  if (!['ja-en', 'en-ja'].includes(direction)) throw new Error('Unsupported TranslateGemma direction.');
  const [source_lang_code, target_lang_code] = direction.split('-');
  // Extension Workers must never use the Playground's network model loader.
  if (self.location.protocol === 'chrome-extension:' && !cacheOnly) throw new Error('Prepare TranslateGemma weights with Save graph or Models before starting.');
  // Check in the processing Worker: window support alone is insufficient.
  if (!self.navigator.gpu) throw new Error('TranslateGemma requires WebGPU in a secure browser Worker. Use a supported browser/device on HTTPS or localhost.');
  if (!await self.navigator.gpu.requestAdapter()) throw new Error('No WebGPU adapter is available for TranslateGemma on this device.');
  let translate;
  try {
    const { pipeline, env } = await translationRuntime();
    if (cacheOnly) {
      if (self.location.protocol !== 'chrome-extension:') throw new Error('Extension cache requires an extension Worker.');
      const { cacheOnlyTranslateGemmaRuntime } = await import('../extension/translategemma-cache.js');
      await cacheOnlyTranslateGemmaRuntime(env);
    }
    translate = await pipeline('text-generation', TRANSLATE_GEMMA.id, {
      ...TRANSLATE_GEMMA, progress_callback: progress,
    });
  } catch (error) { throw modelLoadError(new Error(`TranslateGemma 4B needs several GB of free RAM/GPU memory and a compatible WebGPU adapter. ${error.message || error}`)); }
  return async text => {
    const messages = [{ role: 'user', content: [{
      type: 'text', source_lang_code, target_lang_code, text,
    }] }];
    let result;
    try { result = await translate(messages, { max_new_tokens: 256, do_sample: false }); }
    catch (error) { throw new Error(`TranslateGemma inference failed: ${error.message || error}. Check WebGPU device availability and free RAM/GPU memory; retry with a fresh run.`); }
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
