import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function cosyVoice3Manifest() {
  const response = await fetch(new URL('./cosyvoice3-assets.json', import.meta.url));
  if (!response.ok) throw Error('Missing reviewed CosyVoice3 asset manifest. Rebuild the extension.');
  return defineAssetSet(await response.json());
}

// Startup never repairs cache misses by fetching weights. The same verified set
// is used by Save, Models and the owned Worker, including the reference voice and fixed flow noise.
export async function cosyVoice3Assets() {
  const manifest = await cosyVoice3Manifest();
  const view = await new ModelAssetCache(manifest).inspect();
  if (view.state !== 'Ready') throw Error(view.error || 'CosyVoice3 assets missing or evicted. Open Models and use Download / retry, then Start again.');
  const cache = await caches.open(MODEL_CACHE_NAME);
  const allowed = new Map(manifest.files.map(file => [file.path, file.url]));
  return async path => {
    if (!allowed.has(path)) throw Error('Unreviewed CosyVoice3 asset requested.');
    const response = await cache.match(allowed.get(path));
    if (!response) throw Error('CosyVoice3 cache evicted during load. Open Models and retry preparation.');
    return new Uint8Array(await response.arrayBuffer());
  };
}
