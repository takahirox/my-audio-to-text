import { ParakeetModel } from './vendor/optional-asr/parakeet/parakeet.js';
import * as ort from './vendor/optional-asr/ort/ort.webgpu.min.mjs';
import { parakeetManifest, optionalAsrFiles } from '../extension/optional-asr-cache.js';
import { ParakeetV3Segments } from './parakeet-v3-segments.js';

let model, segments, session, failed = false, chain = Promise.resolve();
const send = (type, values = {}) => postMessage({ type, ...(session === undefined ? {} : { session }), ...values });
self.onmessage = ({ data }) => {
  chain = chain.then(() => { if (!failed) return handle(data); }).catch(error => {
    failed = true; send('error', { message: `${error.message || error}. Check GPU support, free memory and retry Start.` });
  });
};
async function handle(data) {
  if (data.type === 'load') {
    send('progress', { message: 'Checking WebGPU and verified Parakeet v3 cache…' });
    if (!navigator.gpu) throw Error('WebGPU unavailable. Enable Chrome hardware acceleration on a supported GPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter || !adapter.features.has('shader-f16')) throw Error('A WebGPU adapter with shader-f16 is required for the pinned FP16 encoder');
    if (adapter.limits.maxStorageBufferBindingSize < 128 * 1024 * 1024) throw Error('GPU storage buffers below 128 MiB are unsupported');
    const files = await optionalAsrFiles(await parakeetManifest(), 'Parakeet v3');
    ort.env.wasm.wasmPaths = new URL('./vendor/optional-asr/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
    const urls = [...files].map(([name, bytes]) => [name, URL.createObjectURL(new Blob([bytes]))]);
    const byName = Object.fromEntries(urls);
    try {
      model = await ParakeetModel.fromUrls({ encoderUrl: byName['encoder-model.fp16.onnx'], decoderUrl: byName['decoder_joint-model.int8.onnx'], tokenizerUrl: byName['vocab.txt'], backend: 'webgpu-strict', cpuThreads: 1, preprocessorBackend: 'js', nMels: 128 });
    } finally { for (const [, url] of urls) URL.revokeObjectURL(url); files.clear(); }
    send('configuration', { model: 'nvidia/parakeet-tdt-0.6b-v3', encoder: 'WebGPU FP16', decoder: 'WASM int8', numThreads: 1 });
    send('ready');
  } else if (data.type === 'start') {
    session = data.session;
    segments = new ParakeetV3Segments(audio => model.transcribe(audio, 16000), event => send(event.type, event));
  } else if (data.session === session && data.type === 'audio') {
    await segments.push(data.audio); send('consumed', { sequence: data.sequence });
  } else if (data.session === session && data.type === 'stop') {
    await segments.finish(); segments = null; send('stopped');
  }
}
