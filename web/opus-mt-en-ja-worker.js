import { OPUS_MT_EN_JA } from './translation-models.js';
import { serveTranslationWorker, translationRuntime, modelLoadError } from './translation-worker.js';

serveTranslationWorker(async (progress, { cacheOnly = false } = {}) => {
  let translate;
  try {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
      throw new Error('OPUS-MT requires WebAssembly support.');
    }
    const { pipeline, env } = await translationRuntime();
    if (cacheOnly) {
      if (self.location.protocol !== 'chrome-extension:') throw new Error('Extension cache requires an extension Worker.');
      const { cacheOnlyEnglishToJapaneseOpusRuntime } = await import('../extension/opus-mt-en-ja-cache.js');
      await cacheOnlyEnglishToJapaneseOpusRuntime(env);
    }
    translate = await pipeline('translation', OPUS_MT_EN_JA.id, {
      ...OPUS_MT_EN_JA, progress_callback: progress,
    });
  } catch (error) { throw modelLoadError(error); }
  return async text => {
    const tokens = translate.tokenizer(text).input_ids;
    if (tokens.dims.at(-1) > 512) throw new RangeError('OPUS-MT input exceeds 512 tokens; use a shorter snippet.');
    const result = await translate(text, { max_new_tokens: 256, do_sample: false });
    return result.map(value => value.translation_text);
  };
});
