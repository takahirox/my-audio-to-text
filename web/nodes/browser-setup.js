// Header-only service worker used by the existing speech playground too.
// No models, microphone permission or inference are started here.
export async function requireWebGpu({ f16 = false, minBufferBytes = 0 } = {}) {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw Error('This model requires WebGPU. Use a current desktop Chromium browser on HTTPS or localhost with hardware acceleration enabled.');
  if (f16 && !adapter.features?.has('shader-f16')) throw Error('This model requires WebGPU shader-f16 support. Use a compatible GPU and driver.');
  if (minBufferBytes && (adapter.limits?.maxStorageBufferBindingSize || 0) < minBufferBytes) throw Error('This model requires WebGPU storage buffers of at least 128 MiB.');
}

export function modelErrorMessage(error, gpu = false) {
  const message = error.message || String(error);
  return gpu && /Worker (?:crashed|failed|communication failed)/i.test(message)
    ? `${message} This model requires Worker WebGPU and compatible pinned runtimes. Use current desktop Chromium; check runtime assets, hardware acceleration and free memory.`
    : message;
}

export async function prepareAudioBrowser() {
  if (!isSecureContext || !globalThis.OfflineAudioContext) throw Error('Audio decoding requires a current browser on HTTPS or localhost.');
  if (typeof WebAssembly !== 'object') throw Error('This model requires browser WebAssembly support. Use a current browser.');
  if (crossOriginIsolated) {
    sessionStorage.removeItem(`asr-isolation:${location.pathname}`);
    return true;
  }
  if (!navigator.serviceWorker) throw Error('This WASM runtime needs cross-origin isolation. Serve with COOP/COEP headers or enable service workers.');
  await navigator.serviceWorker.register(new URL('../isolation-worker.js', import.meta.url));
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  const key = `asr-isolation:${location.pathname}`;
  if (sessionStorage.getItem(key)) throw Error('Browser isolation failed. Close other playground tabs and reload, or serve with COOP/COEP headers.');
  sessionStorage.setItem(key, '1'); location.reload();
  return false;
}
