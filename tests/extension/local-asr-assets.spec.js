import { test, expect, chromium } from '@playwright/test';
import { settleAutoSave } from './ui-controls.js';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const kind of ['reazon', 'whisper', 'zipformer']) test(`verified ${kind} cache: real inference offline, missing/corrupt recovery and active deletion`, async ({}, info) => {
  test.skip(!process.env.LOCAL_ASR_SMOKE, 'Run review-local-asr-assets.py, prepare speech fixtures, build, and set LOCAL_ASR_SMOKE=1.');
  test.setTimeout(300000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'local-asr-assets-'));
  const root = path.join(temporary, 'extension'), assets = new Map(), requests = [], errors = [];
  let context, page;
  const server = createServer((request, response) => {
    requests.push(request.url);
    const file = assets.get(request.url);
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    createReadStream(file).pipe(response);
  });
  try {
    await cp('dist/chrome-extension', root, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const names = kind === 'zipformer' ? [kind] : [kind, 'silero'];
    for (const name of names) {
      const file = path.join(root, 'extension', `${name}-assets.json`);
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      const directory = name === 'whisper' ? `.cache/whisper/${manifest.revision}` : name === 'reazon' ? '.cache/reazon-ja-en' : name === 'silero' ? '.cache/silero' : '.cache/zipformer-en';
      for (const entry of manifest.files) {
        const route = `/${name}/${entry.path}`;
        assets.set(route, path.resolve(directory, entry.path));
        entry.sourceURL = `http://127.0.0.1:${server.address().port}${route}`;
      }
      await writeFile(file, JSON.stringify(manifest));
    }
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/extension/model-cache.html`);
    await expect(page.locator(`#${kind} .model-status`)).toContainText('Not downloaded');
    expect(requests).toEqual([]);
    expect(await page.locator('text=Bundled models').count()).toBe(0);
    await context.setOffline(true);
    const boot = async () => page.evaluate(async kind => {
      window.events = [];
      const { LocalAsrCore } = await import('../web/local-asr-core.js');
      const { ZipformerCore } = await import('../web/zipformer-core.js');
      window.core = kind === 'zipformer' ? new ZipformerCore(e => events.push(e)) : new LocalAsrCore(e => events.push(e), { whisper: kind === 'whisper', workerFactory: name => new Worker(new URL('../web/' + name, location.href), name.includes('whisper') ? { type: 'module' } : {}) });
      core.load();
    }, kind);
    await boot();
    await expect.poll(() => page.evaluate(() => events.find(e => e.type === 'error')?.message)).toMatch(/missing|evicted/);
    await page.evaluate(() => core.release());
    await context.setOffline(false);
    if (kind === 'reazon') {
      const editor = await context.newPage(), editorWorkers = [];
      editor.on('worker', worker => editorWorkers.push(worker.url()));
      await editor.goto(page.url().replace('model-cache.html', 'graph-editor.html'));
      await editor.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight');
      await settleAutoSave(editor);
      await expect(editor.locator('#graph-models .model-status')).toHaveText(Array(2).fill('Ready · Cached and verified'), { timeout: 120000 });
      expect(editorWorkers).toEqual([]); await editor.close();
    } else for (const name of names) {
      await page.locator(`#${name} button`, { hasText: 'Download / retry' }).click();
      await expect(page.locator(`#${name}`)).toHaveAttribute('data-state', 'Ready', { timeout: 120000 });
    }
    expect(requests).toHaveLength(assets.size);
    expect(new Set(requests).size).toBe(assets.size);
    // Corruption is caught on inspection; only that file is downloaded again.
    await page.evaluate(async kind => {
      const { MODEL_CACHE_NAME } = await import('./model-asset-cache.js');
      const { reazonManifest, whisperManifest, zipformerManifest } = await import('./local-asr-cache.js');
      const manifest = await ({ reazon: reazonManifest, whisper: whisperManifest, zipformer: zipformerManifest })[kind]();
      const file = manifest.files[0];
      await (await caches.open(MODEL_CACHE_NAME)).put(file.url, new Response(new Uint8Array(file.bytes)));
    }, kind);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator(`#${kind}`)).toHaveAttribute('data-state', 'Not downloaded');
    await page.locator(`#${kind} button`, { hasText: 'Download / retry' }).click();
    await expect(page.locator(`#${kind}`)).toHaveAttribute('data-state', 'Ready', { timeout: 120000 });
    expect(requests).toHaveLength(assets.size + 1);
    await context.setOffline(true);
    await boot();
    await expect.poll(() => page.evaluate(() => events.some(e => e.type === 'ready') || events.find(e => e.type === 'error')?.message), { timeout: 120000 }).toBe(true);
    // Another tab cannot delete either backend or shared VAD while a Worker owns it.
    const other = await context.newPage(); await other.goto(page.url());
    for (const name of names) {
      await expect(other.locator(`#${name}`)).toHaveAttribute('data-state', 'Ready');
      await other.locator(`#${name} button`, { hasText: 'Delete cached assets' }).click();
      await expect(other.locator(`#${name} .model-error`)).toContainText('in use');
    }
    const fixture = kind === 'zipformer' ? '.cache/reazon-ja-en/test_wavs/test_en_1.wav' : '.cache/reazon-ja-en/test_wavs/test_ja_1.wav';
    const wav = await readFile(fixture);
    let pcm, rate;
    for (let offset = 12; offset + 8 <= wav.length;) {
      const tag = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
      if (tag === 'fmt ') rate = wav.readUInt32LE(offset + 12);
      if (tag === 'data') pcm = Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(offset + 8 + i * 2) / 32768);
      offset += 8 + size + size % 2;
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      await page.evaluate(async ({ pcm, rate, kind }) => {
        const { Resampler, joinAudio } = await import('../web/audio.js');
        const resampler = new Resampler(rate), audio = joinAudio([resampler.push(Float32Array.from(pcm)), resampler.flush()]);
        events.length = 0; core.start();
        for (let offset = 0; offset < audio.length; offset += 2048) {
          core.push(audio.slice(offset, offset + 2048));
          await new Promise(resolve => setTimeout(resolve, kind === 'reazon' ? 64 : 4));
        }
        core.stop();
      }, { pcm, rate, kind });
      await expect.poll(() => page.evaluate(() => events.some(e => e.type === 'stopped') || events.find(e => e.type === 'error')?.message), { timeout: 120000 }).toBe(true);
      const result = await page.evaluate(() => events.filter(e => ['partial', 'final', 'error'].includes(e.type)));
      expect(result.some(e => e.type === 'final' && e.text.trim())).toBe(true);
      expect(result.filter(e => e.type === 'error')).toEqual([]);
      if (kind === 'reazon') expect(result.some(e => e.type === 'partial' && e.text.trim())).toBe(true);
      if (kind === 'whisper') expect(result.some(e => e.type === 'partial')).toBe(false);
      await info.attach(`${kind}-run-${repeat}.json`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    }
    expect(requests).toHaveLength(assets.size + 1);
    await page.evaluate(() => core.release());
    if (kind === 'reazon') {
      // Also exercise the unmodified graph/session preparation and warm Start path.
      const runtime = await page.evaluate(async () => {
        const { TabSession } = await import('./session.js');
        const session = new TabSession(() => {}, { sourceFactory: (tabId, audio) => ({
          start() { audio(new Float32Array(16037)); }, stop() {},
        }) });
        try {
          await session.prepareModels();
          if (session.view.modelState !== 'ready') throw Error(session.view.error);
          const warm = session.prepared.pipeline;
          await session.start(42);
          if (session.session.pipeline !== warm) throw Error('Start replaced the prepared graph');
          await session.stop();
          return { modelState: session.view.modelState, state: session.view.state, error: session.view.error };
        } finally { await session.close(); }
      });
      expect(runtime).toMatchObject({ modelState: 'ready', state: 'idle' }); expect(runtime.error || '').toBe('');
    }
    for (const name of names) {
      await other.locator(`#${name} button`, { hasText: 'Delete cached assets' }).click();
      await expect(other.locator(`#${name}`)).toHaveAttribute('data-state', 'Not downloaded');
    }
    expect(errors).toEqual([]);
  } finally {
    if (page) await info.attach('events.json', { body: JSON.stringify(await page.evaluate(() => window.events).catch(() => null)), contentType: 'application/json' });
    await context?.close(); await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Japanese Kokoro frontend loads its verified statistical voice offline and protects it during use', async ({}, info) => {
  test.skip(!process.env.LOCAL_ASR_SMOKE, 'Opt-in real weight-free frontend / cached voice validation.');
  test.setTimeout(120000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kokoro-frontend-')), root = path.join(temporary, 'extension');
  const body = await readFile('.cache/kokoro-japanese/openjtalk-voice.htsvoice');
  let context, requests = 0;
  const server = createServer((request, response) => {
    requests++; response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' }); response.end(body);
  });
  try {
    await cp('dist/chrome-extension', root, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const file = path.join(root, 'extension/kokoro-japanese-assets.json'), manifest = JSON.parse(await readFile(file));
    manifest.files[0].sourceURL = `http://127.0.0.1:${server.address().port}/voice`;
    await writeFile(file, JSON.stringify(manifest));
    await writeFile(path.join(root, 'extension/frontend-test-worker.js'), `
      import { createJapanesePhonemizer } from '../web/kokoro-japanese.js';
      try { const phonemize = await createJapanesePhonemizer(); postMessage({ phonemes: await phonemize('こんにちは。今日は良い天気です。') }); }
      catch (error) { postMessage({ error: error.message }); }
    `);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
    });
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const page = await context.newPage(); await page.goto(`chrome-extension://${id}/extension/model-cache.html`);
    const card = page.locator('#kokoro-japanese');
    await expect(card).toHaveAttribute('data-state', 'Not downloaded');
    expect(requests).toBe(0);
    await card.getByRole('button', { name: 'Download / retry' }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready'); expect(requests).toBe(1);
    await context.setOffline(true);
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      window.frontendWorker = new Worker('./frontend-test-worker.js', { type: 'module' });
      frontendWorker.onerror = event => reject(Error(event.message)); frontendWorker.onmessage = ({ data }) => resolve(data);
    }));
    expect(result.error).toBeUndefined(); expect(result.phonemes.length).toBeGreaterThan(10);
    await card.getByRole('button', { name: 'Delete cached assets' }).click();
    await expect(card.locator('.model-error')).toContainText('in use');
    await page.evaluate(() => frontendWorker.terminate());
    await card.getByRole('button', { name: 'Delete cached assets' }).click();
    await expect(card).toHaveAttribute('data-state', 'Not downloaded'); expect(requests).toBe(1);
    await info.attach('phonemes.json', { body: JSON.stringify(result), contentType: 'application/json' });
  } finally { await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true }); }
});
