import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { observeModels } from './model-playground-fixture.js';

test.beforeEach(({}, info) => { test.skip(info.project.name !== 'chromium', 'PLaMo runtime targets desktop Chromium with JSPI.'); });

async function fixture(page, { corrupt = false, mode = 'success' } = {}) {
  const payload = Buffer.from('real-cache-protocol-test'); let downloads = 0;
  await page.context().route('**/vendor/model-cache/plamo-assets.json', route => route.fulfill({ json: [{
    path: 'fixture.gguf', bytes: payload.length, sha256Chunks: [createHash('sha256').update(payload).digest('hex')],
    sourceURL: new URL('/plamo-fixture.gguf', page.url()).href,
  }] }));
  await page.context().route('**/plamo-fixture.gguf', route => {
    downloads++;
    return route.fulfill({ body: corrupt ? Buffer.alloc(payload.length) : payload });
  });
  // Replace only inference. Production Worker, PFML3, cache hashes and Pipeline
  // all execute in native browser Workers without downloading real weights.
  await page.context().route('**/vendor/plamo/wllama.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export class Wllama {
      async loadModel(blobs, config) {
        if (config.n_gpu_layers !== 0 || config.n_threads !== 1 || config.n_ctx !== 2048) throw Error('Wrong runtime settings');
        if (await blobs[0].text() !== 'real-cache-protocol-test') throw Error('Unverified model bytes');
        if (${JSON.stringify(mode)} === 'loading') await new Promise(() => {});
      }
      async createCompletion(config) {
        if (!config.prompt.startsWith('<|plamo:tag|>dataset<|plamo:msg|>translation')) throw Error('Wrong PFML3 prefix');
        if (!config.prompt.endsWith('<|plamo:msg|>') || config.prompt.includes('>auto')) throw Error('Wrong PFML3 language');
        if (config.temperature !== 0 || config.max_tokens !== 256) throw Error('Wrong decoding');
        if (${JSON.stringify(mode)} === 'inference') await new Promise(() => {});
        const match = config.prompt.match(/output<\\|plamo:key\\|>lang<\\|plamo:val\\|>([a-z-]+)/);
        const target = match?.[1];
        if (!target && !config.prompt.includes('input<|plamo:key|>lang<|plamo:val|>ja/en')) throw Error('Missing native auto switch');
        const japanese = target === 'ja' || (!target && config.prompt.includes('Hello.'));
        return { choices: [{ text: japanese ? '日本語の翻訳' : target && target !== 'en' ? 'translation:' + target : 'English translation', finish_reason: 'stop' }] };
      }
    }` }));
  return () => downloads;
}

test('standalone PLaMo: no eager weights, typed language configuration, both directions and verified cache reuse', async ({ page }) => {
  await observeModels(page);
  await page.goto('./my-audio-to-text/nodes/plamo-3-translate-2b/');
  const downloads = await fixture(page);
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('#run')).toBeEnabled(); expect(downloads()).toBe(0);
  for (const [text, source, target, output] of [
    ['こんにちは。', '', '', 'English translation'], ['Hello.', '', '', '日本語の翻訳'],
    ['Hello.', 'auto', 'auto', '日本語の翻訳'], ['Hello.', 'en', 'ja', '日本語の翻訳'],
    ['Bonjour.', 'fr', 'ja', '日本語の翻訳'], ['안녕하세요.', 'ko', 'en', 'English translation'],
    ['你好。', 'zh-hans', 'ja', '日本語の翻訳'], ['你好。', 'zh-hant', 'fr', 'translation:fr'],
    ['Hello.', 'auto', 'zh-hant', 'translation:zh-hant'],
  ]) {
    await page.locator('#input').fill(text);
    await page.locator('#source-lang').fill(source); await page.locator('#target-lang').fill(target);
    await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
    await expect(page.locator('#output')).toHaveText(output);
    await expect(page.locator('#latency')).toContainText('ms');
  }
  expect(downloads()).toBe(1);
  expect((await page.evaluate(() => window.modelWorkers)).every(w => w.terminated === 1)).toBe(true);
  await page.locator('#target-lang').fill('xx'); await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Error'); await expect(page.locator('#errors')).toContainText('target_lang');
  await page.locator('#source-lang').fill('fr'); await page.locator('#target-lang').fill('');
  await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText('source_lang requires a concrete target_lang');
  await page.locator('#target-lang').fill('ja'); await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Complete');
});

for (const phase of ['loading', 'inference']) test(`PLaMo Cancel during ${phase}, pagehide, then retry using cached bytes`, async ({ page }) => {
  await observeModels(page);
  await page.goto('./nodes/plamo-3-translate-2b/');
  const downloads = await fixture(page, { mode: phase });
  await page.locator('#run').click();
  await expect(page.locator(phase === 'loading' ? '#source-lang' : '#input')).toBeDisabled();
  if (phase === 'inference') await expect(page.locator('#status')).toHaveText('Translating…');
  else await expect.poll(downloads).toBe(1);
  await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Canceled');
  await page.context().unrouteAll(); await fixture(page, { mode: 'loading' });
  await page.locator('#run').click(); await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('#status')).toHaveText('Canceled');
  expect((await page.evaluate(() => window.modelWorkers)).every(w => w.terminated === 1)).toBe(true);
  await page.context().unrouteAll(); await fixture(page);
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
});

test('PLaMo corrupt cache never loads; retry verifies replacement and cache-only mode never downloads', async ({ page }) => {
  await page.goto('./nodes/plamo-3-translate-2b/'); await fixture(page, { corrupt: true });
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText('Corrupt asset');
  await page.context().unrouteAll(); const downloads = await fixture(page);
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
  expect(downloads()).toBe(1);
  const error = await page.evaluate(async () => {
    const { plamoModelBlob, plamoManifest } = await import('../../vendor/model-cache/plamo-cache.js');
    const manifest = await plamoManifest(); await (await caches.open('transformers-cache')).delete(manifest.files[0].url);
    try { await plamoModelBlob({ cacheOnly: true }); } catch (error) { return error.message; }
  });
  expect(error).toContain('missing or evicted'); expect(downloads()).toBe(1);
});
