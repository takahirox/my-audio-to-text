import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const payload = Buffer.from('verified local model fixture');
const files = [{ path: 'fixture.bin', bytes: payload.length,
  sha256Chunks: [createHash('sha256').update(payload).digest('hex')] }];
const prefix = !process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './';
async function assetsFixture(page, name, { array = false, corrupt = false } = {}) {
  let downloads = 0;
  await page.context().route('**/fixture-weights.bin', route => {
    downloads++;
    return route.fulfill({ contentType: 'application/octet-stream', body: corrupt ? Buffer.alloc(payload.length) : payload });
  });
  await page.context().route(`**/vendor/model-cache/${name}-assets.json`, route => {
    const fixture = files.map(file => ({ ...file, sourceURL: new URL('fixture-weights.bin', page.url()).href }));
    return route.fulfill({ json: array ? fixture : { id: `fixture/${name}`, revision: 'a'.repeat(40), files: fixture } });
  });
  return () => downloads;
}

for (const [name, manifest] of [['parakeet-v3', 'parakeetManifest'], ['moonshine-medium-en', 'moonshineManifest']]) {
  test(`${name}: web-origin loader downloads and validates pinned files without an extension`, async ({ page }) => {
    const downloads = await assetsFixture(page, name);
    await page.goto(prefix);
    const result = await page.evaluate(async manifest => {
      const assets = await import('./playground-model-assets.js'), progress = [];
      const files = await assets.optionalAsrFiles(await assets[manifest](), 'Fixture ASR', message => progress.push(message));
      return { text: new TextDecoder().decode(files.get('fixture.bin')), progress };
    }, manifest);
    expect(result.text).toBe(payload.toString()); expect(result.progress.length).toBeGreaterThan(0); expect(downloads()).toBe(1);
  });
}
for (const [name, type] of [['meeting-summary-lfm2', 'TextSummaryLfm2'], ['meeting-summary-qwen35', 'TextSummaryQwen35'], ['if-condition', null]]) {
  test(`${name}: browser-safe Transformer cache permits only verified assets and surfaces eviction`, async ({ page }) => {
    const downloads = await assetsFixture(page, name, { array: true }); await page.goto(prefix);
    const result = await page.evaluate(async type => {
      const assets = await import('./playground-model-assets.js'), env = {};
      if (type) await assets.cacheOnlyTextSummaryRuntime(env, type);
      else await assets.cacheOnlyIfConditionRuntime(env);
      const { textSummaryModel } = await import('./text-summary-models.js');
      const { IF_CONDITION_MODEL } = await import('./if-condition-model.js');
      const spec = type ? textSummaryModel(type) : IF_CONDITION_MODEL;
      const url = `https://huggingface.co/${spec.id}/resolve/${spec.revision}/fixture.bin`;
      const text = await (await env.customCache.match(url)).text();
      const unknown = await env.customCache.match('https://huggingface.co/unpinned/model/resolve/main/weights');
      await (await caches.open('transformers-cache')).delete(url);
      let eviction; try { await env.customCache.match(url); } catch (error) { eviction = error.message; }
      return { text, unknown: unknown === undefined, remote: env.allowRemoteModels, eviction };
    }, type);
    expect(result).toMatchObject({ text: payload.toString(), unknown: true, remote: false });
    expect(result.eviction).toContain('evicted'); expect(downloads()).toBe(1);
  });
}
for (const [name, read] of [['qwen3-tts', 'qwen3TtsAssets'], ['cosyvoice3', 'cosyVoice3Assets']]) {
  test(`${name}: prepares only its pinned model and returns the production verified reader`, async ({ page }) => {
    const downloads = await assetsFixture(page, name); await page.goto(prefix);
    const result = await page.evaluate(async read => {
      Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) }, configurable: true });
      const assets = await import('./playground-model-assets.js');
      const reader = await assets[read]();
      return new TextDecoder().decode(await reader('fixture.bin'));
    }, read);
    expect(result).toBe(payload.toString()); expect(downloads()).toBe(1);
  });
  test(`${name}: unavailable WebGPU fails before any weight downloads`, async ({ page }) => {
    const downloads = await assetsFixture(page, name); await page.goto(prefix);
    const message = await page.evaluate(async read => {
      Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
      try { await (await import('./playground-model-assets.js'))[read](); }
      catch (error) { return error.message; }
    }, read);
    expect(message).toContain('requires Worker WebGPU'); expect(downloads()).toBe(0);
  });
}
test('corrupt web-origin assets fail integrity verification without becoming Ready', async ({ page }) => {
  await assetsFixture(page, 'parakeet-v3', { corrupt: true }); await page.goto(prefix);
  const message = await page.evaluate(async () => {
    const assets = await import('./playground-model-assets.js');
    try { await assets.optionalAsrFiles(await assets.parakeetManifest(), 'Fixture ASR'); }
    catch (error) { return error.message; }
  });
  expect(message).toContain('Corrupt asset');
});
