import { OPUS_MT } from '../web/translation-models.js';
import { defineAssetSet } from './model-asset-cache.js';

// Generated from the immutable checkpoint by review-opus-mt-assets.py.
// JSON is fetched from the packaged extension, never from a remote script.
export async function opusMtManifest() {
  const response = await fetch(new URL('./opus-mt-assets.json', import.meta.url));
  if (!response.ok) throw new Error('Packaged OPUS-MT manifest unavailable.');
  return defineAssetSet({ ...OPUS_MT, files: await response.json() });
}
