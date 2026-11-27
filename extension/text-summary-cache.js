import { packagedGraphHost } from '../web/optional-model-assets.js';
import { textProcessingModel } from '../web/text-summary-models.js';
import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

export async function textSummaryManifest(type) {
  const model = textProcessingModel(type);
  const response = await fetch(new URL(`./${model.key}-assets.json`, import.meta.url));
  if (!response.ok) throw new Error('Packaged text processing manifest missing. Rebuild the extension.');
  return defineAssetSet({ ...model, files: await response.json() });
}
export async function cacheOnlyTextSummaryRuntime(env, type) {
  if (!packagedGraphHost()) throw new Error('Text processing requires a packaged graph Worker.');
  const manifest = await textSummaryManifest(type);
  const view = await new ModelAssetCache(manifest).inspect({ retain: true });
  if (view.state !== 'Ready') throw new Error(view.error || 'Text processing model assets missing or evicted. Use Retry models in Live, or retry preparation in Models.');
  const cache = await caches.open(MODEL_CACHE_NAME), allowed = new Set(manifest.files.map(file => file.url));
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.localModelPath = new URL('./missing-text-summary-models/', import.meta.url).href;
  env.useBrowserCache = false; env.useFSCache = false; env.useWasmCache = false; env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (!allowed.has(url)) return undefined;
      const response = await cache.match(url);
      if (!response) throw new Error('Text processing cache evicted during load. Use Retry models in Live, or retry preparation in Models.');
      return response;
    },
    async put() { /* Only verified asset preparation writes weights. */ },
  };
}
