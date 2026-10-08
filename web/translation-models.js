// Immutable browser-compatible conversions; see docs/translation-nodes.md.
export const OPUS_MT = Object.freeze({
  id: 'onnx-community/opus-mt-ja-en',
  revision: '05470cd69b62aa32e3ee64ccfd41279789ee4b1e',
  dtype: 'q8', device: 'wasm',
});
// OPUS Tatoeba English → Japanese, verified with this pinned WASM runtime.
export const OPUS_MT_EN_JA = Object.freeze({
  id: 'Kadonox/opus-tatoeba-en-ja-onnx',
  revision: '225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e',
  dtype: 'q8', device: 'wasm',
});
export const TRANSLATE_GEMMA = Object.freeze({
  id: 'onnx-community/translategemma-text-4b-it-ONNX',
  revision: 'f7874a1ac60758872a4f78aac0df95b17b776994',
  dtype: 'q4', device: 'webgpu',
});
