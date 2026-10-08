import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { REAZON_NUM_THREADS } from '../../web/reazon-config.js';

async function configuration(page, { requested, cores = 16, shared = true } = {}) {
  // Stub native initialization inside the actual worker, so both browsers run
  // its real load/configuration path without importScripts interception.
  const source = readFileSync(new URL('../../web/sherpa-worker.js', import.meta.url), 'utf8');
  await page.context().route('**/sherpa-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: source + `
      Object.defineProperty(self.navigator, 'hardwareConcurrency', {value:${cores}});
      self.importScripts = (...scripts) => {
        postMessage({type:'test-assets', scripts, wasm:self.Module.locateFile('sherpa-onnx-wasm-main-vad-asr.wasm'), data:self.Module.locateFile('sherpa-onnx-wasm-main-vad-asr.data')});
        self.OfflineRecognizer = class {
          constructor(config) { this.handle = 1; postMessage({type:'test-config', config}); }
        };
        self.createVad = () => ({handle:1});
        self.Module.HEAPU8 = new Uint8Array(new ${shared ? 'SharedArrayBuffer' : 'ArrayBuffer'}(8));
        postMessage({type:'test-environment', cores:self.navigator.hardwareConcurrency, isolated:self.crossOriginIsolated, shared:self.Module.HEAPU8.buffer instanceof SharedArrayBuffer});
        self.Module.onRuntimeInitialized();
      };`,
  }));
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
  return page.evaluate(async ({ requested }) => {
    const worker = new Worker('../../sherpa-worker.js'), events = [];
    try {
      await new Promise((resolve, reject) => {
        worker.onerror = event => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          events.push(data);
          if (['ready', 'error'].includes(data.type)) resolve();
        };
        worker.postMessage({ type: 'load', numThreads: requested });
      });
      return events;
    } finally { worker.terminate(); }
  }, { requested });
}

test('selected thread count and ja-en assets reach the baseline recognizer', async ({ page }) => {
  const events = await configuration(page);
  expect(events.some(e => e.type === 'ready'), JSON.stringify(events)).toBe(true);
  expect(events.find(e => e.type === 'test-config').config.modelConfig.numThreads).toBe(REAZON_NUM_THREADS);
  expect(events.find(e => e.type === 'configuration')).toMatchObject({ numThreads: REAZON_NUM_THREADS, model: 'ja-en', modelName: 'ReazonSpeech ja-en' });
  const assets = events.find(e => e.type === 'test-assets');
  for (const url of [...assets.scripts, assets.wasm, assets.data]) expect(new URL(url).pathname).toContain('/vendor/sherpa-ja-en/');
  expect(events.find(e => e.type === 'test-config').config.modelConfig.transducer).toEqual({
    encoder: './transducer-encoder.onnx', decoder: './transducer-decoder.onnx', joiner: './transducer-joiner.onnx',
  });
});
for (const requested of [1, 2, 4]) {
  test(`benchmark request for ${requested} thread(s) reaches recognizer`, async ({ page }) => {
    const events = await configuration(page, { requested });
    expect(events.some(e => e.type === 'ready'), JSON.stringify(events)).toBe(true);
    expect(events.find(e => e.type === 'test-config').config.modelConfig.numThreads).toBe(requested);
  });
}
for (const entry of [{ cores: 1 }, { shared: false }]) {
  test(`limited capability ${JSON.stringify(entry)} selects one and rejects unsupported requests`, async ({ page }) => {
    const events = await configuration(page, entry);
    expect(events.find(e => e.type === 'test-config').config.modelConfig.numThreads).toBe(1);
    const rejected = await configuration(page, { ...entry, requested: 4 });
    expect(rejected.some(e => e.type === 'test-config')).toBe(false);
    expect(rejected.find(e => e.type === 'error').message).toContain('Unsupported ReazonSpeech thread count');
  });
}
