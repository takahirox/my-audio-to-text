import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { ttsFixture, observeTts } from './tts-fixture.js';

test('Kokoro corresponding-source download resolves beside the engine under the Pages prefix', async ({ page }) => {
  const prefix = !process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './';
  await page.goto(prefix + 'nodes/kokoro/');
  const link = page.getByRole('link', { name: 'Download corresponding source, data and build scripts' });
  const href = await link.evaluate(element => element.href);
  expect(href).toBe(new URL('../../tts-assets/phonemizer-source.tar.gz', page.url()).href);
  const download = await page.request.get(href);
  expect(download.status()).toBe(200);
  const bytes = await download.body();
  // gzip archive, rather than a fallback HTML page or a mutable upstream link.
  expect([...bytes.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  expect(bytes.length).toBeGreaterThan(1000000);
  const tar = gunzipSync(bytes), members = new Map();
  for (let offset = 0; offset < tar.length && tar[offset] !== 0;) {
    const name = tar.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const size = parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    members.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect([...members.keys()].sort()).toEqual(['Dockerfile', 'ENGINE-SHA256.txt', 'README.md', 'build.sh', 'espeak-ng.tar.gz', 'phonemizer.js']);
  expect(createHash('sha256').update(members.get('espeak-ng.tar.gz')).digest('hex')).toBe('e6b84b52a87b3ad72885331bd942b2adecd70c384fa4ecfbe10aae7d9afd5e21');
  const engine = await page.request.get(new URL('phonemizer-engine.mjs', href).href);
  expect(engine.status()).toBe(200);
  expect(members.get('ENGINE-SHA256.txt').toString().split(' ')[0]).toBe(createHash('sha256').update(await engine.body()).digest('hex'));
});

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
