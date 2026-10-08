import { OPUS_MT } from './translation-models.js';
import { serveTranslationWorker, translationRuntime, modelLoadError } from './translation-worker.js';

serveTranslationWorker(async progress => {
  let translate;
  try {
    const { pipeline } = await translationRuntime();
    translate = await pipeline('translation', OPUS_MT.id, {
      ...OPUS_MT, progress_callback: progress,
    });
  } catch (error) { throw modelLoadError(error); }
  return async text => {
    const tokens = translate.tokenizer(text).input_ids;
    if (tokens.dims.at(-1) > 512) throw new RangeError('OPUS-MT input exceeds 512 tokens; use a shorter snippet.');
    const result = await translate(text, { max_new_tokens: 256, do_sample: false });
    return result.map(value => value.translation_text);
  };
});
