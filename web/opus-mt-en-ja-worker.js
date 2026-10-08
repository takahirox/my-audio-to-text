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
    // ReazonSpeech emits uppercase English. This case-sensitive Marian
    // tokenizer/model loses ordinary words in that form. Normalize only fully
    // uppercase Latin input for inference; the source transcript stays intact.
    const input = /[A-Z]/.test(text) && !/[a-z]/.test(text)
      ? text.toLowerCase()
        .replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase())
        .replace(/\b(?:i|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g,
          word => word[0].toUpperCase() + word.slice(1))
      : text;
    const tokens = translate.tokenizer(input).input_ids;
    if (tokens.dims.at(-1) > 512) throw new RangeError('OPUS-MT input exceeds 512 tokens; use a shorter snippet.');
    const result = await translate(input, { max_new_tokens: 256, do_sample: false });
    return result.map(value => value.translation_text);
  };
});
