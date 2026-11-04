export const MAX_PENDING_CHARS = 32768;
export const MAX_SUMMARY_CHARS = 6000;
export const MAX_PROMPT_TOKENS = 8192;
export const MAX_NEW_TOKENS = 1024;
export const MAX_SUMMARY_PROMPT_CHARS = 4096;

export function summaryLanguage(language = 'ja') {
  if (!['ja', 'en'].includes(language)) throw new TypeError('Summary language must be ja or en.');
  return language;
}

export function summaryInstruction(prompt = '', language = 'ja') {
  summaryLanguage(language);
  if (typeof prompt !== 'string' || prompt.length > MAX_SUMMARY_PROMPT_CHARS)
    throw new TypeError(`Summary prompt must be text of at most ${MAX_SUMMARY_PROMPT_CHARS} characters.`);
  // An explicit prompt completely replaces the default. No meeting-specific
  // sections, factual-status rules, formatting instructions or output filters.
  return prompt.trim() || (language === 'ja'
    ? '次の文章を要約してください。'
    : 'Summarize the following text.');
}

export function summaryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SUMMARY_CHARS)
    throw new Error('Model returned an empty or oversized summary; the last successful summary is retained.');
  return value.trim();
}

// The user's complete formatted TEXT is passed without implicit splitting,
// reconciliation, content-specific rules or truncation. Prompt is fully editable.
export async function refreshedSummary(generate, text, language = 'ja', prompt = '') {
  const instruction = summaryInstruction(prompt, language);
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PENDING_CHARS)
    throw RangeError('Text summary input exceeds text bounds or is empty.');
  const messages = [
    { role: 'system', content: instruction },
    { role: 'user', content: JSON.stringify(text).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') },
  ];
  return summaryText(await generate(messages));
}
