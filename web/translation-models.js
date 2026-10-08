// Immutable browser-compatible conversions; see docs/translation-nodes.md.
export const OPUS_MT = Object.freeze({
  id: 'onnx-community/opus-mt-ja-en',
  revision: '05470cd69b62aa32e3ee64ccfd41279789ee4b1e',
  dtype: 'q8', device: 'wasm',
});
// Upstream names Japanese `jap`; this is the verified en → ja conversion.
export const OPUS_MT_EN_JA = Object.freeze({
  id: 'Xenova/opus-mt-en-jap',
  revision: '9d418190be3aa945eae5bab1bd96bc5e349ad784',
  dtype: 'q8', device: 'wasm',
});
export const TRANSLATE_GEMMA = Object.freeze({
  id: 'onnx-community/translategemma-text-4b-it-ONNX',
  revision: 'f7874a1ac60758872a4f78aac0df95b17b776994',
  dtype: 'q4', device: 'webgpu',
});
