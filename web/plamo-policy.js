// PFML3 policy for the one experimental 2B Node, shared by graph and Playground.
export const PLAMO_3_TRANSLATE_2B = Object.freeze({
  id: 'pfnet/plamo-3-translate-2b-GGUF',
  revision: '4f672106b847200bfdc0f6af6c321cd94eba1aed',
});
// Official GGUF README at the pinned revision. Chinese scripts are distinct;
// region codes and aliases are not members of this 53-language contract.
export const PLAMO_LANGUAGE_CODES = Object.freeze([
  'ja', 'en', 'zh-hans', 'zh-hant', 'ko', 'ar', 'az', 'be', 'bg', 'bn',
  'ca', 'ceb', 'de', 'es', 'et', 'eu', 'fa', 'fr', 'gu', 'he', 'hi', 'hr',
  'hu', 'hy', 'id', 'it', 'jv', 'ka', 'kk', 'km', 'lt', 'lv', 'ml', 'mr',
  'ms', 'my', 'ne', 'nl', 'pa', 'pl', 'ru', 'si', 'sk', 'sl', 'sr', 'sw',
  'ta', 'te', 'th', 'tl', 'ur', 'uz', 'vi',
]);
export const DEFAULT_PLAMO_LANGUAGES = Object.freeze({ source_lang: 'auto', target_lang: 'auto' });
// A transport/memory bound only; the runtime checks the full tokenized prompt.
export const MAX_PLAMO_CONTEXT_CHARS = 8000;
export const PLAMO_CONTEXT_TOKENS = 2048;
export const PLAMO_OUTPUT_TOKENS = 256;
export const MAX_PLAMO_PROMPT_TOKENS = PLAMO_CONTEXT_TOKENS - PLAMO_OUTPUT_TOKENS;
export function validatePlamoContext(context) {
  if (typeof context !== 'string') throw TypeError('PLaMo context must be TEXT.');
  if (context.length > MAX_PLAMO_CONTEXT_CHARS) throw RangeError('PLaMo context accepts at most 8,000 characters; shorten the context.');
  if (/<\|(?:plamo:|endoftext\|)/.test(context)) throw Error('PLaMo context contains reserved model control tokens.');
}
export function plamoLanguages(values = {}) {
  const { source_lang, target_lang } = Object.fromEntries(Object.entries(DEFAULT_PLAMO_LANGUAGES).map(([port, fallback]) => {
    const value = Object.hasOwn(values, port) ? values[port] : fallback;
    // Match explicit GGUF template kwargs: lowercase codes, no trimming,
    // case folding, region guessing or silent fallback to another language.
    if (value !== 'auto' && !PLAMO_LANGUAGE_CODES.includes(value))
      throw Error(`PLaMo ${port} must be auto or one of the 53 supported lowercase language codes (e.g. ja, en, fr, ko, zh-hans, zh-hant); blank values are invalid.`);
    return [port, value];
  }));
  if (source_lang !== 'auto' && target_lang === 'auto')
    throw Error('PLaMo source_lang requires a concrete target_lang (not auto); omit source_lang or use auto for Japanese/English switching.');
  return Object.freeze({ source_lang, target_lang });
}
export function updatePlamoLanguages(current, values, groupInputs = []) {
  const next = { ...current };
  for (const port of ['source_lang', 'target_lang']) {
    if (Object.hasOwn(values, port)) next[port] = values[port];
    // Grouped delivery replaces the connected family, including omissions.
    else if (groupInputs.includes(port)) delete next[port];
  }
  return Object.freeze(next);
}
export function plamoPrompt(text, config = {}) {
  const { source_lang, target_lang } = plamoLanguages(config);
  const context = Object.hasOwn(config, 'context') ? config.context : '';
  validatePlamoContext(context);
  if (typeof text !== 'string' || text.length > 1000) throw Error('PLaMo accepts at most 1,000 characters of TEXT.');
  // Reject special-token injection rather than silently altering the source.
  if (/<\|(?:plamo:|endoftext\|)/.test(text)) throw Error('PLaMo input contains reserved model control tokens.');
  const language = code => `<|plamo:key|>lang<|plamo:val|>${code}`;
  // The official GGUF auto switch is a model instruction, not app-side
  // language detection. Merely dropping output lang would change the prompt.
  const inputLanguage = target_lang === 'auto' ? 'ja/en' : source_lang;
  return '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    (context ? '<|plamo:tag|>context<|plamo:msg|>' + context : '') +
    '<|plamo:tag|>input' + (inputLanguage === 'auto' ? '' : language(inputLanguage)) +
    '<|plamo:msg|>' + text + '<|plamo:tag|>output' + (target_lang === 'auto' ? '' : language(target_lang)) + '<|plamo:msg|>';
}

export async function plamoCompletion(model, text, config = {}) {
  const prompt = plamoPrompt(text, config);
  const settings = { prompt, temperature: 0, seed: 0, stream: false, cache_prompt: true };
  // Wllama 3.13 has no tokenize API. Its pinned llama.cpp accepts max_tokens=0:
  // evaluate/cache the entire prompt, generate nothing, and return usage including
  // BOS. Oversized prompts fail in the runtime before evaluation; ctx_shift is off.
  const evaluated = await model.createCompletion({ ...settings, max_tokens: 0 });
  const tokens = evaluated.usage?.prompt_tokens;
  if (!Number.isInteger(tokens) || tokens < 1) throw Error('PLaMo could not verify the prompt token budget.');
  if (tokens > MAX_PLAMO_PROMPT_TOKENS) throw RangeError('PLaMo context and text exceed the 1,792-token prompt budget (256 output tokens reserved); shorten the context or text.');
  const response = await model.createCompletion({ ...settings, max_tokens: PLAMO_OUTPUT_TOKENS });
  if (response.usage?.prompt_tokens !== tokens) throw Error('PLaMo prompt token count changed during translation.');
  const choice = response.choices?.[0];
  if (choice?.finish_reason === 'length') throw Error('PLaMo reached the 256-token output limit. Split the text and retry.');
  if (typeof choice?.text !== 'string' || !choice.text.trim()) throw Error('PLaMo returned no translation.');
  return [choice.text.trim()];
}
