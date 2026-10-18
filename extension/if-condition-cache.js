import { IF_CONDITION_MODEL } from '../web/if-condition-model.js';
import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function ifConditionManifest() {
  const response = await fetch(new URL('./if-condition-assets.json', import.meta.url));
  if (!response.ok) throw new Error('Packaged IfCondition asset manifest unavailable. Rebuild the extension.');
  return defineAssetSet({ ...IF_CONDITION_MODEL, files: await response.json() });
}
export async function cacheOnlyIfConditionRuntime(env) {
  if (globalThis.location?.protocol !== 'chrome-extension:') throw new Error('IfCondition requires an extension-owned Worker.');
  const manifest = await ifConditionManifest(), assets = new ModelAssetCache(manifest);
  const view = await assets.inspect();
  if (view.state !== 'Ready') throw new Error(view.error || 'IfCondition model assets missing or evicted. Save graph or open Models and retry preparation.');
  const cache = await caches.open(MODEL_CACHE_NAME), allowed = new Set(manifest.files.map(file => file.url));
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.localModelPath = new URL('./missing-if-condition-models/', import.meta.url).href;
  env.useBrowserCache = false; env.useFSCache = false; env.useWasmCache = false; env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (!allowed.has(url)) return undefined; // Optional lookup gets a local 404; no network fallback.
      const response = await cache.match(url);
      if (!response) throw new Error('IfCondition cache evicted during load. Save graph and retry preparation.');
      return response;
    },
    async put() { /* Only verified Save-time preparation writes weights. */ },
  };
}
