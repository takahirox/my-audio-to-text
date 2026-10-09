import { defineAssetSet, ModelAssetCache, MODEL_CACHE_NAME } from './model-asset-cache.js';

// Two reviewed immutable checkpoints. Runtime/frontends are packaged separately.
export async function ttsManifest(type, settings) {
  let id, revision, file, voicePath;
  if (type === 'Supertonic3') {
    if (!['ja', 'en'].includes(settings.language) || !['F1', 'M1'].includes(settings.voice)) throw new Error('Invalid Supertonic settings.');
    id = 'supertone-oss-archive/supertonic-3'; revision = 'aafc6e32416a594460b32413efc49d7fe4ce6d46'; file = 'supertonic3-assets.json'; voicePath = `voice_styles/${settings.voice}.json`;
  } else if (type === 'Kokoro') {
    if (!['jf_alpha', 'af_heart'].includes(settings.voice)) throw new Error('Invalid Kokoro settings.');
    id = 'onnx-community/Kokoro-82M-v1.0-ONNX'; revision = '1939ad2a8e416c0acfeecc08a694d14ef25f2231'; file = 'kokoro-assets.json'; voicePath = `voices/${settings.voice}.bin`;
  } else throw new Error('Unsupported TTS type.');
  const response = await fetch(new URL(file, import.meta.url));
  if (!response.ok) throw new Error('Missing reviewed TTS asset manifest. Rebuild the extension.');
  const files = (await response.json()).filter(entry => !/^(voice_styles|voices)\//.test(entry.path) || entry.path === voicePath);
  return defineAssetSet({ id, revision, files });
}
export async function verifiedTtsCache(type, settings, signal) {
  const manifest = await ttsManifest(type, settings);
  const view = await new ModelAssetCache(manifest).inspect({ signal });
  signal?.throwIfAborted();
  if (view.state !== 'Ready') throw new Error(view.error || `${type} assets missing or evicted. Open Models and use Download / retry for this model and voice.`);
  return manifest;
}
export async function cacheOnlyKokoroRuntime(env, settings) {
  const manifest = await verifiedTtsCache('Kokoro', settings);
  const cache = await caches.open(MODEL_CACHE_NAME);
  const allowed = new Set(manifest.files.map(file => file.url));
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.localModelPath = new URL('./missing-models/', import.meta.url).href;
  env.useBrowserCache = false; env.useCustomCache = true;
  env.customCache = {
    async match(request) {
      const url = typeof request === 'string' ? request : request.url;
      if (!allowed.has(url)) return undefined;
      const response = await cache.match(url);
      if (!response) throw new Error('Kokoro cache evicted during load. Open Models and retry this voice.');
      return response;
    },
    async put() { /* Only explicit verified preparation writes model files. */ },
  };
}
