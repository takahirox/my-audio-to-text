import { modelDefinitions } from '../extension/model-definitions.js';
import { compareModelDefinitions } from '../extension/model-order.js';
import { ttsManifest } from '../extension/tts-cache.js';
import { ModelAssetCache } from '../extension/model-asset-cache.js';

export const desktopModels = [...modelDefinitions].sort(compareModelDefinitions).flatMap(definition =>
  definition.voices ? definition.voices.map(voice => ({
    ...definition, key: `${definition.id}:${voice}`, title: `${definition.title} · ${voice}`,
    manifest: () => ttsManifest(definition.type, { language: 'ja', voice }),
  })) : [{ ...definition, key: definition.id }]);

export function desktopAssetCache(manifest) {
  return new ModelAssetCache(manifest, {
    // The durable Electron profile owns storage. Only this route can fetch a
    // model file; inference Workers continue to use canonical cache keys.
    beforeDownload: () => {},
    fetchAsset: (url, options) => fetch(`/model-asset?source=${encodeURIComponent(url)}`, options),
  });
}
