// Only two explicit directions. Preferences do not mutate a running graph.
const KEY = 'opus-mt-translation-preferences';
export const translationDirection = value => value === 'en-ja' ? 'en-ja' : 'ja-en';
export function translationLanguages(direction) {
  return direction === 'en-ja'
    ? { source: 'English', target: 'Japanese', sourceCode: 'en', targetCode: 'ja' }
    : { source: 'Japanese', target: 'English', sourceCode: 'ja', targetCode: 'en' };
}
export function readTranslationPreferences(storage) {
  try {
    const value = JSON.parse(storage.getItem(KEY));
    return { enabled: value?.enabled === true, direction: translationDirection(value?.direction) };
  } catch { return { enabled: false, direction: 'ja-en' }; }
}
export function writeTranslationPreferences(storage, { enabled, direction }) {
  try { storage.setItem(KEY, JSON.stringify({ enabled: !!enabled, direction: translationDirection(direction) })); }
  catch { /* Unavailable storage leaves this window's choices usable. */ }
}
