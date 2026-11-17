import { PLAMO_3_TRANSLATE_2B } from '../web/plamo-policy.js';
import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function plamoManifest() {
  const response = await fetch(new URL('./plamo-assets.json', import.meta.url));
  if (!response.ok) throw Error('Packaged PLaMo manifest unavailable. Rebuild assets.');
  return defineAssetSet({ ...PLAMO_3_TRANSLATE_2B, files: await response.json() });
}
export async function verifiedPlamoCache(signal) {
  const manifest = await plamoManifest();
  signal?.throwIfAborted();
  const view = await new ModelAssetCache(manifest).inspect({ signal, retain: true });
  signal?.throwIfAborted();
  if (view.state !== 'Ready') throw Error(view.error || 'PLaMo weights missing or evicted. Retry preparation in Models or Run again in Playground.');
  return manifest;
}
export async function plamoModelBlob({ cacheOnly = true, progress = () => {} } = {}) {
  const manifest = await plamoManifest();
  if (!cacheOnly) {
    const view = await new ModelAssetCache(manifest).prepare({ onChange: progress });
    if (view.state !== 'Ready') throw Error(view.error || 'PLaMo download failed. Free storage and retry.');
  }
  await verifiedPlamoCache();
  const response = await (await caches.open(MODEL_CACHE_NAME)).match(manifest.files[0].url);
  if (!response) throw Error('PLaMo cache evicted during load. Retry preparation.');
  // Blob keeps the 1.81 GB file out of a single JS ArrayBuffer; Wllama reads it
  // through its async file ABI. The manifest checks bytes before this handoff.
  return response.blob();
}
