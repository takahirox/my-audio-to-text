import { ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';
import { opusMtManifest } from './opus-mt-manifest.js';

export async function verifiedOpusCache(signal, loadManifest = opusMtManifest) {
  const manifest = await loadManifest();
  signal?.throwIfAborted();
  const assets = new ModelAssetCache(manifest);
  const view = await assets.inspect({ signal });
  signal?.throwIfAborted();
  if (view.state !== 'Ready') throw new Error(view.error || 'OPUS-MT assets missing or evicted. Use Download / retry OPUS-MT.');
  return manifest;
}

// Cache API belongs to the extension origin, even though its keys are pinned
// HTTPS asset URLs. Runtime code and WASM remain packaged extension resources.
// Transformers' optional lookups receive a local 404; no remote fallback.
export async function cacheOnlyOpusRuntime(env, loadManifest = opusMtManifest) {
  const manifest = await verifiedOpusCache(undefined, loadManifest);
  const cache = await caches.open(MODEL_CACHE_NAME);
  const allowed = new Set(manifest.files.map(file => file.url));
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.localModelPath = new URL('./missing-models/', import.meta.url).href;
  env.useBrowserCache = false; env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (allowed.has(url)) {
        const response = await cache.match(url);
        if (!response) throw new Error('OPUS-MT cache evicted during load. Download / retry OPUS-MT.');
        return response;
      }
      return undefined; // Optional lookups use local 404, with remote models disabled.
    },
    async put() { /* validated preparation is the only cache writer */ },
  };
}
