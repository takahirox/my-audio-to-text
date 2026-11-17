import { serveTranslationWorker } from './translation-worker.js';
import { plamoCompletion, PLAMO_CONTEXT_TOKENS } from './plamo-policy.js';

serveTranslationWorker(async (progress, { cacheOnly = false } = {}) => {
  if (!globalThis.isSecureContext || !globalThis.caches) throw Error('PLaMo requires desktop Chromium on HTTPS or localhost with browser storage.');
  if (typeof WebAssembly.Suspending !== 'function') throw Error('PLaMo requires a current desktop Chromium with WebAssembly JSPI support. Update Chrome before downloading.');
  const { plamoModelBlob } = await import(globalThis.location.protocol === 'chrome-extension:'
    ? '../extension/plamo-cache.js' : './vendor/model-cache/plamo-cache.js');
  const blob = await plamoModelBlob({ cacheOnly, progress: view => progress({
    status: 'progress', file: 'PLaMo 3 Translate 2B', progress: 100 * view.downloadedBytes / view.totalBytes,
  }) });
  const { Wllama } = await import('./vendor/plamo/wllama.js');
  const model = new Wllama({ default: new URL('./vendor/plamo/wllama.wasm', import.meta.url).href }, { suppressNativeLog: true });
  await model.loadModel([blob], { n_threads: 1, n_gpu_layers: 0, n_ctx: PLAMO_CONTEXT_TOKENS, n_parallel: 1, n_batch: 128, ctx_shift: false });
  return (text, config) => plamoCompletion(model, text, config);
});
