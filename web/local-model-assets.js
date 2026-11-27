import { packagedGraphHost } from './optional-model-assets.js';
// The Playground's explicit Load/Generate action prepares verified assets on its
// own origin. Extension workers use files prepared by Live, Auto Save or Models.
export async function localModelAssets(kind, progress = () => {}) {
  const extension = packagedGraphHost();
  const module = await import(extension ? '../extension/japanese-frontend-cache.js' : './vendor/model-cache/japanese-frontend-cache.js');
  if (!extension) {
    const { ModelAssetCache } = await import('./vendor/model-cache/model-asset-cache.js');
    const manifest = await module.japaneseFrontendManifest();
    const view = await new ModelAssetCache(manifest).prepare({ onChange: view => progress(`${view.state}: ${view.downloadedBytes} / ${view.totalBytes} bytes`) });
    if (view.state !== 'Ready') throw Error(view.error);
  }
  return module;
}
