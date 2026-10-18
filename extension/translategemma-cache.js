import { TRANSLATE_GEMMA } from '../web/translation-models.js';
import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

// Both concrete directions use the same immutable q4 checkpoint and cache keys.
export async function translateGemmaManifest() {
  const response = await fetch(new URL('./translategemma-assets.json', import.meta.url));
  if (!response.ok) throw new Error('Packaged TranslateGemma manifest unavailable. Rebuild the extension.');
  return defineAssetSet({ ...TRANSLATE_GEMMA, files: await response.json() });
}

export async function verifiedTranslateGemmaCache(signal) {
  const manifest = await translateGemmaManifest();
  signal?.throwIfAborted();
  const view = await new ModelAssetCache(manifest).inspect({ signal });
  signal?.throwIfAborted();
  if (view.state !== 'Ready') throw new Error(view.error || 'TranslateGemma weights missing or evicted. Save graph or open Models and use Download / retry for TranslateGemma 4B.');
  return manifest;
}

export async function cacheOnlyTranslateGemmaRuntime(env) {
  const manifest = await verifiedTranslateGemmaCache();
  const cache = await caches.open(MODEL_CACHE_NAME);
  const allowed = new Set(manifest.files.map(file => file.url));
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.localModelPath = new URL('./missing-models/', import.meta.url).href;
  env.useBrowserCache = false; env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (!allowed.has(url)) return undefined; // Optional lookups get a local 404.
      const response = await cache.match(url);
      if (!response) throw new Error('TranslateGemma cache evicted during load. Open Models and retry.');
      return response;
    },
    async put() { /* Only explicit verified preparation writes weights. */ },
  };
}
