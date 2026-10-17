import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function parakeetManifest() { return readManifest('parakeet-v3-assets.json'); }
export async function moonshineManifest() { return readManifest('moonshine-medium-en-assets.json'); }
async function readManifest(file) {
  const response = await fetch(new URL(file, import.meta.url));
  if (!response.ok) throw Error('Missing optional ASR asset manifest. Rebuild the extension.');
  return defineAssetSet(await response.json());
}
// Recognition is cache-only, including startup: this never calls prepare/fetch.
export async function optionalAsrFiles(manifest, label) {
  const view = await new ModelAssetCache(manifest).inspect();
  if (view.state !== 'Ready') throw Error(`${label}: ${view.error || 'model assets missing or evicted'}. Save the Node in Graph Editor and Retry preparation before Start.`);
  const cache = await caches.open(MODEL_CACHE_NAME), files = new Map();
  for (const file of manifest.files) {
    const response = await cache.match(file.url);
    if (!response) throw Error(`${label} cache evicted during load. Retry preparation in Graph Editor.`);
    files.set(file.path, new Uint8Array(await response.arrayBuffer()));
  }
  return files;
}
