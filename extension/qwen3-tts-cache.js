import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function qwen3TtsManifest() {
  const response = await fetch(new URL('./qwen3-tts-assets.json', import.meta.url));
  if (!response.ok) throw Error('Missing reviewed Qwen3-TTS asset manifest. Rebuild the extension.');
  return defineAssetSet(await response.json());
}

// Startup never repairs cache misses by fetching weights. The same verified set
// is used by Save, Models and the owned Worker, including the separate codec.
export async function qwen3TtsAssets() {
  const manifest = await qwen3TtsManifest();
  const view = await new ModelAssetCache(manifest).inspect();
  if (view.state !== 'Ready') throw Error(view.error || 'Qwen3-TTS assets missing or evicted. Open Models and use Download / retry, then Start again.');
  const cache = await caches.open(MODEL_CACHE_NAME);
  const allowed = new Map(manifest.files.map(file => [file.path, file.url]));
  return async path => {
    if (!allowed.has(path)) throw Error('Unreviewed Qwen3-TTS asset requested.');
    const response = await cache.match(allowed.get(path));
    if (!response) throw Error('Qwen3-TTS cache evicted during load. Open Models and retry preparation.');
    return new Uint8Array(await response.arrayBuffer());
  };
}
