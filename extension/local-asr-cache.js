import { defineAssetSet } from './model-asset-cache.js';
import { optionalAsrFiles } from './optional-asr-cache.js';
import { cacheOnlyOpusRuntime } from './opus-mt-cache.js';

async function readManifest(name) {
  const response = await fetch(new URL(`${name}-assets.json`, import.meta.url));
  if (!response.ok) throw Error('Missing pinned model manifest. Rebuild the extension.');
  return defineAssetSet(await response.json());
}
export const reazonManifest = () => readManifest('reazon');
export const sileroManifest = () => readManifest('silero');
export const whisperManifest = () => readManifest('whisper');
export const zipformerManifest = () => readManifest('zipformer');
export const japaneseFrontendManifest = () => readManifest('kokoro-japanese');
export const japaneseFrontendFiles = async () => optionalAsrFiles(await japaneseFrontendManifest(), 'Kokoro Japanese frontend');
export const cacheOnlyWhisperRuntime = env => cacheOnlyOpusRuntime(env, whisperManifest, 'Whisper');

// Load only the selected backend's files. Silero never loads ASR weights.
// Cache validation and worker leases precede MEMFS writes; no network fallback.
export async function sherpaModelFiles(kind) {
  const manifest = await ({ reazon: reazonManifest, silero: sileroManifest, zipformer: zipformerManifest })[kind]();
  const files = await optionalAsrFiles(manifest, kind);
  const paths = kind === 'reazon' ? {
    'encoder-epoch-35-avg-1.int8.onnx': '/transducer-encoder.onnx',
    'decoder-epoch-35-avg-1.onnx': '/transducer-decoder.onnx',
    'joiner-epoch-35-avg-1.int8.onnx': '/transducer-joiner.onnx',
  } : kind === 'zipformer' ? {
    'encoder-epoch-99-avg-1.int8.onnx': '/encoder.onnx',
    'decoder-epoch-99-avg-1.onnx': '/decoder.onnx',
    'joiner-epoch-99-avg-1.int8.onnx': '/joiner.onnx',
  } : {};
  return module => {
    for (const [path, bytes] of files) module.FS_createDataFile(paths[path] || `/${path}`, null, bytes, true, false, true);
    files.clear();
  };
}
