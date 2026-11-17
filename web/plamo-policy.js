// PFML3 policy for the one experimental 2B Node, shared by graph and Playground.
export const PLAMO_3_TRANSLATE_2B = Object.freeze({
  id: 'pfnet/plamo-3-translate-2b-GGUF',
  revision: '4f672106b847200bfdc0f6af6c321cd94eba1aed',
});
export const DEFAULT_PLAMO_LANGUAGES = Object.freeze({ source_lang: 'auto', target_lang: 'en' });
export function plamoLanguages(values = {}) {
  const source_lang = Object.hasOwn(values, 'source_lang') ? values.source_lang : 'auto';
  const target_lang = Object.hasOwn(values, 'target_lang') ? values.target_lang : 'en';
  if (!['auto', 'ja', 'en'].includes(source_lang)) throw Error('PLaMo source_lang must be ja, en or auto; blank values are invalid.');
  if (!['ja', 'en'].includes(target_lang)) throw Error('PLaMo target_lang must be en or ja; blank values are invalid.');
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
  return '<|plamo:tag|>dataset<|plamo:msg|>translation' +
    '<|plamo:tag|>input' + (source_lang === 'auto' ? '' : language(source_lang)) +
    '<|plamo:msg|>' + text + '<|plamo:tag|>output' + language(target_lang) + '<|plamo:msg|>';
}
