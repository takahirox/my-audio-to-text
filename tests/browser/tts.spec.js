import { test, expect } from '@playwright/test';
import { ttsFixture, observeTts } from './tts-fixture.js';

for (const slug of ['supertonic3', 'kokoro']) {
  test(`${slug}: index/prefix, production Node-to-player graph, both languages, WAV and repeat`, async ({ page }) => {
    await ttsFixture(page, slug);
    const requests = [], errors = []; page.on('request', request => requests.push(request.url())); page.on('pageerror', error => errors.push(error.message));
    await page.goto(!process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './');
    await page.getByRole('link', { name: slug === 'kokoro' ? 'Kokoro 82M Text-to-Speech' : 'Supertonic 3 Text-to-Speech', exact: true }).click();
    await expect(page.locator('#run')).toBeEnabled();
    expect(requests.some(url => /tts-assets|huggingface\.co/.test(url))).toBe(false);
    await observeTts(page);
    for (const language of ['ja', 'en', 'en']) {
      if (slug === 'kokoro') await page.locator('#voice').selectOption(language === 'ja' ? 'jf_alpha' : 'af_heart');
      else await page.locator('#language').selectOption(language);
      await page.locator('#input').fill(language === 'ja' ? 'こんにちは。' : 'Hello world.');
      await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
      await expect(page.locator('#waveform')).toContainText(slug === 'kokoro' ? '24000 Hz' : '44100 Hz');
      await expect(page.locator('#load-time')).toContainText('ms'); await expect(page.locator('#latency')).toContainText('ms');
      await expect(page.locator('#download')).toBeVisible(); await expect(page.locator('#run')).toBeEnabled();
      const wav = await page.evaluate(async () => {
        const audio = document.getElementById('player'), response = await fetch(audio.src), view = new DataView(await response.arrayBuffer());
        return { rate: view.getUint32(24, true), channels: view.getUint16(22, true), bytes: view.byteLength };
      });
      expect(wav).toEqual({ rate: slug === 'kokoro' ? 24000 : 44100, channels: 1, bytes: 52 });
    }
    const graph = await page.evaluate(() => ({ types: [...window.ttsGraphs[0].entries.values()].map(e => e.node.constructor.name),
      states: window.ttsGraphs.map(g => g.state), workers: window.ttsWorkers, waveforms: window.ttsWaveforms }));
    expect(graph.types).toEqual(['TextInputNode', slug === 'kokoro' ? 'KokoroTextToSpeechNode' : 'Supertonic3TextToSpeechNode', 'AudioOutputNode']);
    expect(graph.states).toEqual(['disposed', 'disposed', 'disposed']); expect(graph.waveforms).toHaveLength(3);
    const workerURL = new URL(`../../${slug}-worker.js`, page.url()).href;
    const assetRoot = new URL('../../tts-assets/', page.url()).href;
    expect(graph.workers.every(w => w.terminated === 1 && w.url === workerURL)).toBe(true);
    expect(requests.filter(url => /tts-assets/.test(url)).every(url => url.startsWith(assetRoot))).toBe(true);
    expect(errors).toEqual([]);
    await page.getByRole('link', { name: 'Node Playground', exact: true }).click(); await expect(page).toHaveTitle('Node Playground');
  });
  for (const mode of ['load-error', 'network-error', 'inference-error', 'invalid-audio']) {
    test(`${slug}: ${mode} is visible, releases Worker and allows retry`, async ({ page }) => {
      await ttsFixture(page, slug, mode); await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled(); await observeTts(page);
      await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
      await expect(page.locator('#errors')).not.toBeEmpty(); await expect(page.locator('#download')).toBeHidden();
      expect(await page.evaluate(() => window.ttsWorkers[0].terminated)).toBe(1);
      await page.context().unrouteAll(); await ttsFixture(page, slug);
      await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
    });
  }
  for (const phase of ['loading', 'inference']) {
    test(`${slug}: Cancel during ${phase} releases resources, blocks late output and repeats`, async ({ page }) => {
      await ttsFixture(page, slug, phase === 'loading' ? 'loading' : 'success'); await page.goto(`./nodes/${slug}/`);
      await expect(page.locator('#run')).toBeEnabled(); await observeTts(page);
      if (slug === 'kokoro') await page.locator('#voice').selectOption('af_heart');
      await page.locator('#input').fill('slow'); await page.locator('#run').click();
      if (phase === 'inference') await expect(page.locator('#status')).toContainText('Generating');
      else await expect.poll(() => page.evaluate(() => window.ttsWorkers.length)).toBe(1);
      await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Canceled');
      await expect(page.locator('#player')).not.toHaveAttribute('src');
      await page.context().unrouteAll(); await ttsFixture(page, slug);
      await page.locator('#input').fill('fresh'); await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
      expect(await page.evaluate(() => window.ttsWorkers.map(w => w.terminated))).toEqual([1, 1]);
      expect(await page.evaluate(() => window.ttsWaveforms.length)).toBe(1);
    });
  }
  test(`${slug}: missing WASM fails before runtime/model downloads`, async ({ page }) => {
    await ttsFixture(page, slug, 'no-wasm'); const requests = [];
    page.on('request', request => { if (/tts-assets|huggingface\.co/.test(request.url())) requests.push(request.url()); });
    await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled(); await page.locator('#run').click();
    await expect(page.locator('#errors')).toContainText('requires WebAssembly'); expect(requests).toEqual([]);
  });
  test(`${slug}: missing SIMD fails before runtime/model downloads`, async ({ page }) => {
    await ttsFixture(page, slug, 'no-simd'); const requests = [];
    page.on('request', request => { if (/tts-assets|huggingface\.co/.test(request.url())) requests.push(request.url()); });
    await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled(); await page.locator('#run').click();
    await expect(page.locator('#errors')).toContainText('WebAssembly SIMD'); expect(requests).toEqual([]);
  });
}
test('Japanese Kokoro requires gzip support before downloads; unsupported voice and token overflow are visible', async ({ page }) => {
  await ttsFixture(page, 'kokoro', 'no-gzip'); await page.goto('./nodes/kokoro/'); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#run').click(); await expect(page.locator('#errors')).toContainText('DecompressionStream');
  await page.context().unrouteAll(); await ttsFixture(page, 'kokoro');
  await page.locator('#voice').selectOption('af_heart'); await page.locator('#input').fill('tokens'); await page.locator('#run').click();
  await expect(page.locator('#errors')).toContainText('512 phoneme tokens');
  await page.evaluate(() => document.getElementById('voice').add(new Option('Unsupported', 'fr')));
  await page.locator('#voice').selectOption('fr'); await page.locator('#run').click();
  await expect(page.locator('#errors')).toContainText('Choose Japanese'); await expect(page.locator('#run')).toBeEnabled();
});
