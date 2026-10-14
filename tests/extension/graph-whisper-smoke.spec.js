import { test, expect, openGraph, startGraph } from './graph-fixture.js';
import { selectWhisper } from './whisper-fixture.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

test('real packaged Whisper tiny: English/Japanese language selection, Silero, Stop and repeat', async ({ graphExtension: f }, info) => {
  test.skip(!process.env.WHISPER_SMOKE, 'Opt-in: prepare pinned models/fixtures, build, then npm run test:whisper-real.');
  test.setTimeout(600000);
  const page = await openGraph(f), runs = [], requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  f.context.on('request', request => { if (request.url().startsWith('http')) requests.push(request.url()); });
  await selectWhisper(page, 'en');
  const fixtures = JSON.parse(await readFile('scripts/reazon-ja-en-assets.json', 'utf8')).fixtures;
  const host = await page.evaluate(() => ({ browser: navigator.userAgent, isolated: crossOriginIsolated }));
  // Production source Node emits a normalized upstream fixture instead of asking
  // for tab capture. All segmentation, VAD, model runtime and inference are real.
  try {
    for (const language of ['en', 'ja', 'en']) {
      const wav = await readFile(`.cache/reazon-ja-en/test_wavs/test_${language}_1.wav`);
      expect(createHash('sha256').update(wav).digest('hex')).toBe(fixtures.find(f => f.path === `test_wavs/test_${language}_1.wav`).sha256);
      let sampleRate, channels, bits; const pcm = [];
      for (let offset = 12; offset + 8 <= wav.length;) {
        const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
        if (id === 'fmt ') { sampleRate = wav.readUInt32LE(offset + 12); channels = wav.readUInt16LE(offset + 10); bits = wav.readUInt16LE(offset + 22); }
        if (id === 'data') for (let i = offset + 8; i < offset + 8 + size; i += 2) pcm.push(wav.readInt16LE(i) / 32768);
        offset += 8 + size + size % 2;
      }
      expect([channels, bits]).toEqual([1, 16]);
      const normalized = await page.evaluate(async ({ pcm, rate }) => {
        const { Resampler, joinAudio } = await import('../web/audio.js');
        const resampler = new Resampler(rate);
        return Array.from(joinAudio([resampler.push(Float32Array.from(pcm)), resampler.flush()]));
      }, { pcm, rate: sampleRate });
      await page.editor.getByRole('button', { name: 'Select language', exact: true }).click();
      await page.editor.getByLabel('language value', { exact: true }).fill(language); await page.editor.locator('#graph-save').click();
      await expect(page.editor.locator('#graph-save')).toBeEnabled();
      await expect(page.editor.locator('#graph-errors')).toBeEmpty();
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.find(n => n.id === 'language').settings.value)).toBe(language);
      const start = Date.now(); await startGraph(page, 120000); const loaded = Date.now();
      expect(await page.evaluate(() => window.graphWorkers.filter(w => !w.released && w.url.endsWith('whisper-worker.js'))[0].messages.find(m => m.type === 'load').language)).toBe(language);
      await page.evaluate(async pcm => {
        for (let offset = 0; offset < pcm.length; offset += 2048) {
          window.capture.emit('audio', Float32Array.from(pcm.slice(offset, offset + 2048)));
          await new Promise(resolve => setTimeout(resolve, 8));
        }
      }, normalized);
      await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled({ timeout: 120000 });
      await expect(page.locator('#errors')).toBeEmpty(); await expect(page.locator('.display-preview')).toBeEmpty();
      const texts = await page.locator('.display-items li pre').allTextContents();
      expect(texts.join(' ')).toMatch(language === 'en' ? /transformer/i : /[\u3040-\u30ff\u4e00-\u9fff]/);
      expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
      runs.push({ language, audioSamples: normalized.length, fixtureSampleRate: sampleRate, texts, loadMs: loaded - start, totalMs: Date.now() - start });
      console.log(JSON.stringify(runs.at(-1)));
    }
    expect(requests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    const output = info.outputPath('whisper-evidence.json');
    await writeFile(output, JSON.stringify({ time: new Date().toISOString(), host, inference: 'Real packaged Whisper tiny q8 and Silero; normalized fixture audio replaces capture hardware', runs, requests, errors }, null, 2) + '\n');
    await info.attach('whisper-evidence', { path: output, contentType: 'application/json' });
  }
});
