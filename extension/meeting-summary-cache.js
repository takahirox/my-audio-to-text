import { meetingSummaryModel } from '../web/meeting-summary-models.js';
import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function meetingSummaryManifest(type) {
  const model = meetingSummaryModel(type);
  const response = await fetch(new URL(`./${model.key}-assets.json`, import.meta.url));
  if (!response.ok) throw new Error('Packaged meeting summary manifest missing. Rebuild the extension.');
  return defineAssetSet({ ...model, files: await response.json() });
}
export async function cacheOnlyMeetingSummaryRuntime(env, type) {
  if (globalThis.location?.protocol !== 'chrome-extension:') throw new Error('Meeting summary requires an extension-owned Worker.');
  const manifest = await meetingSummaryManifest(type);
  const view = await new ModelAssetCache(manifest).inspect();
  if (view.state !== 'Ready') throw new Error(view.error || 'Meeting summary model assets missing or evicted. Save graph or retry in Models.');
  const cache = await caches.open(MODEL_CACHE_NAME), allowed = new Set(manifest.files.map(file => file.url));
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.localModelPath = new URL('./missing-meeting-summary-models/', import.meta.url).href;
  env.useBrowserCache = false; env.useFSCache = false; env.useWasmCache = false; env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (!allowed.has(url)) return undefined;
      const response = await cache.match(url);
      if (!response) throw new Error('Meeting summary cache evicted during load. Save graph and retry.');
      return response;
    },
    async put() { /* Only verified Save-time preparation writes weights. */ },
  };
}
