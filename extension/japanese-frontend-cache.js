import { defineAssetSet } from './model-asset-cache.js';
import { optionalAsrFiles } from './optional-asr-cache.js';
export async function japaneseFrontendManifest() {
  const response = await fetch(new URL('kokoro-japanese-assets.json', import.meta.url));
  if (!response.ok) throw Error('Missing Kokoro Japanese frontend manifest. Rebuild the extension.');
  return defineAssetSet(await response.json());
}
export const japaneseFrontendFiles = async () => optionalAsrFiles(await japaneseFrontendManifest(), 'Kokoro Japanese frontend');
