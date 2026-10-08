import { OPUS_MT_EN_JA } from '../web/translation-models.js';
import { defineAssetSet } from './model-asset-cache.js';

// Reviewed from the immutable checkpoint; review-opus-mt-en-ja-assets.py verifies it.
// JSON is fetched from the packaged extension, never from a remote script.
export async function englishToJapaneseOpusMtManifest() {
  const response = await fetch(new URL('./opus-mt-en-ja-assets.json', import.meta.url));
  if (!response.ok) throw new Error('Packaged OPUS-MT manifest unavailable.');
  return defineAssetSet({ ...OPUS_MT_EN_JA, files: await response.json() });
}
