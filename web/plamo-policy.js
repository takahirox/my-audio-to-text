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
  if (typeof text !== 'string' || text.length > 1000) throw Error('PLaMo accepts at most 1,000 characters of TEXT.');
  // Reject special-token injection rather than silently altering the source.
  if (/<\|(?:plamo:|endoftext\|)/.test(text)) throw Error('PLaMo input contains reserved model control tokens.');
  const language = code => `<|plamo:key|>lang<|plamo:val|>${code}`;
  // The official GGUF auto switch is a model instruction, not app-side
  // language detection. Merely dropping output lang would change the prompt.
  const inputLanguage = target_lang === 'auto' ? 'ja/en' : source_lang;
  return '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    '<|plamo:tag|>input' + (inputLanguage === 'auto' ? '' : language(inputLanguage)) +
    '<|plamo:msg|>' + text + '<|plamo:tag|>output' + (target_lang === 'auto' ? '' : language(target_lang)) + '<|plamo:msg|>';
}
