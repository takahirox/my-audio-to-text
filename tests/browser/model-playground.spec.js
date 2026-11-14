import { test, expect } from '@playwright/test';
import { asrPages, textPages, streamPages, modelPages, wavFixture, modelWorkers, observeModels } from './model-playground-fixture.js';

const prefix = !process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './';

test('standalone index links every catalog model by task, with no eager model work', async ({ page }) => {
  const external = [], errors = [];
  page.on('request', request => { if (/huggingface|tts-assets|vendor|extension\//.test(request.url())) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(prefix);
  await expect(page.locator('section')).toHaveCount(4);
  for (const slug of modelPages) {
    const link = page.locator(`section a[href="./nodes/${slug}/"]`);
    await expect(link).toHaveCount(1); await link.click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Node Playground', exact: true }).click();
  }
  expect(external).toEqual([]); expect(errors).toEqual([]);
});

for (const slug of [...asrPages, ...textPages, ...streamPages]) {
  test(`${slug}: explicit run, correct worker, output, timings, release and repeat under Pages prefix`, async ({ page }) => {
    await modelWorkers(page, slug); await observeModels(page);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${prefix}nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
    expect(await page.evaluate(() => window.modelWorkers)).toEqual([]);
    if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture());
    for (let i = 0; i < 2; i++) {
      await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
      await expect(page.locator('#run')).toBeEnabled();
      await expect(page.locator('#load-time')).toContainText('ms'); await expect(page.locator('#latency')).toContainText('ms');
      if (asrPages.includes(slug)) await expect(page.locator('#output')).toContainText('Recognized speech');
      else if (streamPages.includes(slug)) {
        await expect(page.locator('#waveform')).toContainText('3 PCM chunks');
        await expect(page.locator('#download')).toBeVisible();
        expect(await page.evaluate(async () => { const response = await fetch(document.getElementById('player').src); return (await response.arrayBuffer()).byteLength; })).toBe(14444);
      } else await expect(page.locator('#output')).toHaveText(slug === 'if-condition' ? 'Yes' : 'A local summary.');
    }
    const records = await page.evaluate(() => window.modelWorkers);
    expect(records.every(worker => worker.terminated === 1)).toBe(true);
    expect(records.every(worker => worker.url.startsWith(new URL('../../', page.url()).href))).toBe(true);
    const selected = slug.startsWith('text-summary') ? 'text-summary' : slug;
    expect(records.some(worker => worker.url.endsWith(`/${selected}-worker.js`))).toBe(true);
    if (streamPages.includes(slug)) expect(await page.evaluate(() => window.playedChunks)).toHaveLength(6);
    expect(errors).toEqual([]);
  });

  for (const phase of ['loading', 'inference']) test(`${slug}: cancel during ${phase}, then retry with a fresh worker`, async ({ page }) => {
    await modelWorkers(page, slug, phase); await observeModels(page);
    await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
    if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture(3));
    await page.locator('#run').click();
    const expected = phase === 'loading' ? 'load' : asrPages.includes(slug) ? (slug === 'whisper' ? 'decode' : 'audio') : slug === 'if-condition' ? 'decide' : textPages.includes(slug) ? 'summarize' : 'generate';
    await expect.poll(() => page.evaluate(type => window.modelWorkers.some(w => w.messages.some(m => m.type === type)), expected)).toBe(true);
    await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Canceled');
    expect((await page.evaluate(() => window.modelWorkers)).every(worker => worker.terminated === 1)).toBe(true);
    await page.context().unrouteAll(); await modelWorkers(page, slug);
    if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture());
    await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
  });

  for (const phase of ['load-error', 'inference-error']) test(`${slug}: ${phase} releases the model and permits retry`, async ({ page }) => {
    await modelWorkers(page, slug, phase); await observeModels(page);
    await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
    if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture());
    await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
    await expect(page.locator('#errors')).not.toBeEmpty(); await expect(page.locator('#run')).toBeEnabled();
    expect((await page.evaluate(() => window.modelWorkers)).every(worker => worker.terminated === 1)).toBe(true);
    await page.context().unrouteAll(); await modelWorkers(page, slug);
    await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
  });
  test(`${slug}: pagehide releases a loading model and the compact page fits a narrow viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await modelWorkers(page, slug, 'loading'); await observeModels(page);
    await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
    if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture());
    await page.locator('#run').click();
    await expect.poll(() => page.evaluate(() => window.modelWorkers.length)).toBeGreaterThan(0);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect(page.locator('#status')).toHaveText('Canceled');
    expect((await page.evaluate(() => window.modelWorkers)).every(worker => worker.terminated === 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const slug of streamPages) test(`${slug}: plays a chunk before generation ends, Cancel releases audio and worker`, async ({ page }) => {
  await modelWorkers(page, slug, 'streaming'); await observeModels(page);
  await page.goto(`./nodes/${slug}/`); await page.locator('#run').click();
  await expect.poll(() => page.evaluate(() => window.playedChunks.length)).toBe(1);
  await expect(page.locator('#download')).toBeHidden(); // No completed WAV yet.
  await expect(page.locator('#status')).toHaveText('Generating speech…');
  await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Canceled');
  await expect(page.locator('#player')).not.toHaveAttribute('src');
  expect(await page.evaluate(() => window.modelWorkers[0].terminated)).toBe(1);
});

for (const slug of ['zipformer', 'moonshine-medium']) test(`${slug}: real provisional UI during replay; Stop finalizes the accepted prefix`, async ({ page }) => {
  await modelWorkers(page, slug); await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#file').setInputFiles(wavFixture(3)); await page.locator('#run').click();
  await expect(page.locator('#partial')).toHaveText('Streaming preview');
  await expect(page.locator('#output')).toBeEmpty(); await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('Complete'); await expect(page.locator('#output')).toContainText('Recognized speech');
});

test('invalid audio fails visibly before model download and can be replaced', async ({ page }) => {
  await observeModels(page); await page.goto('./nodes/whisper/'); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#file').setInputFiles({ name: 'bad.wav', mimeType: 'audio/wav', buffer: Buffer.from('invalid') });
  await page.locator('#run').click(); await expect(page.locator('#errors')).toContainText('Cannot decode');
  expect(await page.evaluate(() => window.modelWorkers)).toEqual([]); await expect(page.locator('#run')).toBeEnabled();
});

test('IfCondition shows both independent decisions', async ({ page }) => {
  await modelWorkers(page, 'if-condition'); await page.goto('./nodes/if-condition/');
  await page.locator('#input').fill('A statement.'); await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Complete'); await expect(page.locator('#output')).toHaveText('No');
});

for (const slug of ['whisper', 'text-summary-lfm2', 'text-summary-qwen35', ...streamPages]) test(`${slug}: supported language/voice/prompt settings reach only the selected model`, async ({ page }) => {
  await modelWorkers(page, slug); await observeModels(page);
  await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#language').selectOption(streamPages.includes(slug) ? 'japanese' : 'ja');
  if (slug === 'qwen3-tts') await page.locator('#voice').selectOption('ryan');
  if (textPages.includes(slug)) await page.locator('#prompt').fill('Give one concise sentence.');
  if (slug === 'whisper') await page.locator('#file').setInputFiles(wavFixture());
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Complete');
  const messages = await page.evaluate(() => window.modelWorkers.flatMap(worker => worker.messages));
  expect(messages.some(message => message.language === (streamPages.includes(slug) ? 'japanese' : 'ja'))).toBe(true);
  if (textPages.includes(slug)) {
    expect(messages.some(message => message.prompt === 'Give one concise sentence.')).toBe(true);
    expect(messages.some(message => message.processor === (slug === 'text-summary-lfm2' ? 'TextSummaryLfm2' : 'TextSummaryQwen35'))).toBe(true);
  }
  if (streamPages.includes(slug)) expect(messages.some(message => message.voice === (slug === 'qwen3-tts' ? 'ryan' : 'libritts-r-4446'))).toBe(true);
});

for (const slug of ['parakeet-v3', 'text-summary-lfm2', 'text-summary-qwen35', ...streamPages]) test(`${slug}: GPU preflight fails clearly before downloading weights`, async ({ page }) => {
  const worker = slug.startsWith('text-summary') ? 'text-summary' : slug, downloads = [];
  await page.context().route(`**/${worker}-worker.js`, async route => {
    const original = await route.fetch();
    // Let Playwright recalculate Content-Length after prefixing the script.
    await route.fulfill({ response: original, contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
      body: `Object.defineProperty(navigator, 'gpu', { value: undefined });\n${await original.text()}` });
  });
  page.on('request', request => { if (/huggingface.co|download.moonshine.ai/.test(request.url())) downloads.push(request.url()); });
  await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
  if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture());
  await page.locator('#run').click(); await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText(/WebGPU|shader-f16/);
  await expect(page.locator('#run')).toBeEnabled(); expect(downloads).toEqual([]);
});

for (const slug of ['parakeet-v3', 'text-summary-lfm2', 'qwen3-tts']) test(`${slug}: cancel pending browser GPU setup prevents a late model load`, async ({ page }) => {
  await modelWorkers(page, slug); await observeModels(page);
  await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
  if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(wavFixture());
  await page.evaluate(() => {
    navigator.gpu.requestAdapter = () => new Promise(resolve => {
      window.finishGpuSetup = () => resolve({ features: new Set(['shader-f16']), limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 } });
    });
  });
  await page.locator('#run').click();
  await expect.poll(() => page.evaluate(() => !!window.finishGpuSetup)).toBe(true);
  await page.locator('#cancel').click(); await expect(page.locator('#status')).toHaveText('Canceled');
  await page.evaluate(() => window.finishGpuSetup());
  await expect(page.locator('#run')).toBeEnabled();
  expect(await page.evaluate(() => window.modelWorkers)).toEqual([]);
  await expect(page.locator('#status')).toHaveText('Canceled');
});
