// Browser-origin preparation, called only by an explicitly started model Worker.
// Reuse the production manifests, integrity checks, leases and cache readers.
// Nothing here reads extension storage or changes the extension's cache policy.
import { defineAssetSet, ModelAssetCache } from './vendor/model-cache/model-asset-cache.js';
import { optionalAsrFiles as readAsrFiles } from './vendor/model-cache/optional-asr-cache.js';
import { cacheOnlyOpusRuntime } from './vendor/model-cache/opus-mt-cache.js';
import { textSummaryModel } from './text-summary-models.js';
import { IF_CONDITION_MODEL } from './if-condition-model.js';

const browserError = error => new Error(String(error.message || error)
  .replace(/Use Retry models in Live,.*$/, 'Run again online on this page.'));

async function manifest(name, model) {
  const response = await fetch(new URL(`./vendor/model-cache/${name}-assets.json`, import.meta.url));
  if (!response.ok) throw Error(`Missing ${name} web assets. Run npm run prepare:playground-assets and serve web/.`);
  const data = await response.json();
  return defineAssetSet(model ? { ...model, files: data } : data);
}
async function prepare(spec, progress = () => {}) {
  if (!globalThis.isSecureContext || !globalThis.caches) throw Error('Model caching requires HTTPS or localhost and browser storage.');
  const result = await new ModelAssetCache(spec).prepare({ onChange: view => {
    progress(`${view.state}: ${(view.downloadedBytes / 1e6).toFixed(1)} / ${(view.totalBytes / 1e6).toFixed(1)} MB`);
  } });
  if (result.state !== 'Ready') throw Error(`${result.error} Check network/CORS access, free storage and memory, then Run again.`);
  return spec;
}
export const parakeetManifest = () => manifest('parakeet-v3');
export const moonshineManifest = () => manifest('moonshine-medium-en');
export async function optionalAsrFiles(spec, label, progress) {
  try { return await readAsrFiles(await prepare(spec, progress), label); }
  catch (error) { throw browserError(error); }
}
async function transformerRuntime(env, spec, progress) {
  await prepare(spec, progress);
  try { await cacheOnlyOpusRuntime(env, () => spec, 'Playground model'); }
  catch (error) { throw browserError(error); }
  const match = env.customCache.match;
  env.customCache.match = async request => {
    try { return await match(request); } catch (error) { throw browserError(error); }
  };
  env.useFSCache = false; env.useWasmCache = false;
}
export async function cacheOnlyTextSummaryRuntime(env, type, progress) {
  const model = textSummaryModel(type);
  await transformerRuntime(env, await manifest(model.key, model), progress);
}
export async function cacheOnlyIfConditionRuntime(env, progress) {
  await transformerRuntime(env, await manifest('if-condition', IF_CONDITION_MODEL), progress);
}
export async function qwen3TtsAssets(progress) {
  // Check before multi-GB downloads, as well as in the production runtime.
  if (!await navigator.gpu?.requestAdapter()) throw Error('Qwen3-TTS requires Worker WebGPU. Enable hardware acceleration on a supported device.');
  const assets = await import('./vendor/model-cache/qwen3-tts-cache.js');
  await prepare(await assets.qwen3TtsManifest(), progress);
  return browserReader(() => assets.qwen3TtsAssets());
}
export async function cosyVoice3Assets(progress) {
  if (!await navigator.gpu?.requestAdapter()) throw Error('CosyVoice3 requires Worker WebGPU. Enable hardware acceleration on a supported device.');
  const assets = await import('./vendor/model-cache/cosyvoice3-cache.js');
  await prepare(await assets.cosyVoice3Manifest(), progress);
  return browserReader(() => assets.cosyVoice3Assets());
}
async function browserReader(load) {
  try {
    const read = await load();
    return async path => { try { return await read(path); } catch (error) { throw browserError(error); } };
  } catch (error) { throw browserError(error); }
}
