// A deliberately small, tested subset of multilingual Whisper's language codes.
// Default to English; never claim automatic detection or silently remap a code.
export const WHISPER_LANGUAGES = Object.freeze(['en', 'ja']);
export const WHISPER_MODEL = Object.freeze({
  id: 'tiny', source: 'onnx-community/whisper-tiny',
  revision: 'ff4177021cc41f7db950912b73ea4fdf7d01d8e7',
  dtype: 'q8', device: 'wasm',
});
export function whisperLanguage(value) {
  if (!WHISPER_LANGUAGES.includes(value)) {
    throw new RangeError('Whisper.language must be en or ja. Connect a Text Node containing exactly one supported code, or disconnect it to use English (en).');
  }
  return value;
}
