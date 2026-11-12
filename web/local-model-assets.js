// The Playground's explicit Load/Generate action prepares verified assets on its
// own origin. Extension sessions remain cache-only after Auto Save/Models.
export async function localModelAssets(kind, progress = () => {}) {
  const extension = globalThis.location.protocol === 'chrome-extension:';
  const module = await import(extension ? '../extension/local-asr-cache.js' : './vendor/model-cache/local-asr-cache.js');
  if (!extension) {
    const { ModelAssetCache } = await import('./vendor/model-cache/model-asset-cache.js');
    const manifest = await ({ reazon: module.reazonManifest, silero: module.sileroManifest,
      whisper: module.whisperManifest, zipformer: module.zipformerManifest, japanese: module.japaneseFrontendManifest })[kind]();
    const view = await new ModelAssetCache(manifest).prepare({ onChange: view => progress(`${view.state}: ${view.downloadedBytes} / ${view.totalBytes} bytes`) });
    if (view.state !== 'Ready') throw Error(view.error);
  }
  return module;
}
