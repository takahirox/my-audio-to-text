// Shared message plumbing, never a model manager. Called inside each owned Worker.
export function serveTranslationWorker(load) {
  let translator, queue = Promise.resolve();
  self.onmessage = ({ data }) => {
    queue = queue.then(async () => {
      const { type, id, text } = data;
      try {
        if (type === 'load') {
          if (translator) throw new Error('Worker already loaded.');
          translator = await load(event => self.postMessage({ type: 'progress', ...event }), data);
          self.postMessage({ type: 'ready', id });
        } else if (type === 'translate') {
          if (!translator) throw new Error('Translation model is not ready.');
          if (typeof text !== 'string' || text.length > 1000) throw new TypeError('Invalid translation text.');
          const texts = text.trim() ? await translator(text) : [];
          if (!Array.isArray(texts) || texts.some(value => typeof value !== 'string')) {
            throw new Error('Model returned invalid translated text.');
          }
          self.postMessage({ type: 'result', id, texts });
        } else if (type === 'drain') {
          self.postMessage({ type: 'drained', id });
        } else throw new Error(`Unknown translation request: ${type}`);
      } catch (error) {
        self.postMessage({ type: 'error', id, message: error.message || String(error) });
      }
    });
  };
}

export async function translationRuntime() {
  const runtime = await import('./vendor/translation/transformers.js');
  const { env } = runtime;
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = false;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL('./vendor/translation/ort-wasm-simd-threaded.asyncify.mjs', import.meta.url).href,
    wasm: new URL('./vendor/translation/ort-wasm-simd-threaded.asyncify.wasm', import.meta.url).href,
  };
  return runtime;
}

export function modelLoadError(error) {
  return new Error(`Model loading failed: ${error.message || error}. Check network access, cached assets/offline availability, and device memory. Retry with a fresh run.`);
}
