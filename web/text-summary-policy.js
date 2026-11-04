export const MAX_PENDING_CHARS = 32768;
export const MAX_SUMMARY_CHARS = 6000;
export const MAX_INSTRUCTION_CHARS = 4096;
export const DEFAULT_SUMMARY_PROMPT = 'Summarize the input text.';
export const MAX_PROMPT_TOKENS = 8192;
export const MAX_NEW_TOKENS = 1024;

export function summaryLanguage(language = 'ja') {
  if (!['ja', 'en'].includes(language)) throw new TypeError('Summary language must be ja or en.');
  return language;
}
export function summaryPrompt(prompt = DEFAULT_SUMMARY_PROMPT) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_INSTRUCTION_CHARS) {
    throw new TypeError('Summary prompt must be nonempty text of at most 4,096 characters; no instruction was truncated.');
  }
  return prompt;
}
export function summaryText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SUMMARY_CHARS) {
    throw new Error('Model returned an empty or oversized summary; the last successful summary is retained.');
  }
  return value.trim();
}

// One complete input, one generation. History and format belong to the graph
// and its saved instruction, with no domain-specific validation or repair pass.
export async function summarizeText(generate, text, language = 'ja', prompt = DEFAULT_SUMMARY_PROMPT) {
  summaryLanguage(language);
  summaryPrompt(prompt);
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_PENDING_CHARS) throw new RangeError('Text summary input exceeds text bounds or is empty.');
  const instruction = `${prompt}\n\nUse ${language === 'ja' ? 'Japanese' : 'English'} unless the instruction above requests another language.`;
  const messages = [{ role: 'system', content: instruction }, { role: 'user', content: JSON.stringify(text).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e') }];
  return summaryText(await generate(messages));
}
