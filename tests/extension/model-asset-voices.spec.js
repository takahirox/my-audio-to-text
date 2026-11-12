import { test, expect } from './graph-fixture.js';

async function prepare(page, type, voice) {
  await page.evaluate(async ({ type, voice }) => {
    const { ttsManifest } = await import('./tts-cache.js');
    const { ModelAssetCache } = await import('./model-asset-cache.js');
    window.controller = new AbortController();
    window.view = null;
    window.assets = new ModelAssetCache(await ttsManifest(type, { language: 'en', voice }));
    window.preparation = assets.prepare({ signal: controller.signal, onChange: view => { window.view = view; } })
      .then(view => { window.view = view; return view; });
  }, { type, voice });
}

for (const [type, voices, manifest] of [
  ['Kokoro', ['jf_alpha', 'af_heart'], 'kokoro-assets.json'],
  ['Supertonic3', ['F1', 'M1'], 'supertonic3-assets.json'],
]) for (const action of ['cancel', 'close']) {
  test(`${type}: ${action} of one voice preserves the shared weight transfer for another voice`, async ({ graphExtension: f }) => {
    const pages = await Promise.all([f.context.newPage(), f.context.newPage()]);
    for (const page of pages) await page.goto(f.url.replace('recorder.html', 'model-cache.html'));
    const [first, second] = pages;
    f.mode('hold-weights');
    await prepare(first, type, voices[0]);
    await expect.poll(() => f.requests.some(url => url.endsWith('.onnx'))).toBe(true);
    const weight = f.requests.find(url => url.endsWith('.onnx'));
    const pending = () => second.evaluate(async () => (await navigator.locks.query()).pending
      .filter(lock => lock.name.includes(window.assets?.manifest.id)).length);
    // Compare all model locks until the second page has its manifest as well.
    const queued = await first.evaluate(async () => (await navigator.locks.query()).pending
      .filter(lock => lock.name.includes(assets.manifest.id)).length);
    await prepare(second, type, voices[1]);
    // A queued requirement proves the worker has registered the second voice
    // before cancellation, without depending on timing or a fixture-only API.
    await expect.poll(pending).toBeGreaterThan(queued);
    const subscribed = await pending();
    if (action === 'close') await first.close();
    else {
      await first.evaluate(() => controller.abort());
      await expect.poll(() => first.evaluate(() => window.view?.state)).toBe('Error');
    }
    // Wait for cancellation to remove the first voice's unused queued file.
    await expect.poll(pending).toBeLessThan(subscribed);
    f.release();
    await expect.poll(() => second.evaluate(() => window.view?.state)).toBe('Ready');
    expect(f.requests.filter(url => url === weight)).toHaveLength(1);
    expect(new Set(f.requests).size).toBe(f.requests.length);
    expect(f.requests.some(url => url.includes(`${manifest}/`) && url.includes(voices[0]))).toBe(false);
    expect(f.requests.some(url => url.includes(`${manifest}/`) && url.includes(voices[1]))).toBe(true);
    const count = f.requests.length;
    // Recovery downloads only the canceled voice; every common file is reused.
    await prepare(second, type, voices[0]);
    await expect.poll(() => second.evaluate(() => window.view?.state)).toBe('Ready');
    expect(f.requests).toHaveLength(count + 1);
    expect(f.requests.filter(url => url === weight)).toHaveLength(1);
  });
}
