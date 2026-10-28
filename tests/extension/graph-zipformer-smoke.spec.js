import { test, expect, openGraph, startGraph } from './graph-fixture.js';
import { selectZipformer } from './zipformer-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function pcm16(wav) {
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') expect([wav.readUInt16LE(offset + 8), wav.readUInt16LE(offset + 10), wav.readUInt32LE(offset + 12), wav.readUInt16LE(offset + 22)]).toEqual([1, 1, 16000, 16]);
    if (id === 'data') pcm = Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(offset + 8 + i * 2) / 32768);
    offset += 8 + size + size % 2;
  }
  return pcm;
}

test('real packaged English online Zipformer: incremental speech, cap, Stop tail, silence and repeat without network', async ({ graphExtension: f }, info) => {
  test.skip(!process.env.ZIPFORMER_SMOKE, 'Opt-in: npm run prepare:zipformer-assets, build, then npm run test:zipformer-real.');
  test.setTimeout(300000);
  const page = await openGraph(f), requests = [], errors = [], runs = [];
  f.context.on('request', r => { if (r.url().startsWith('http')) requests.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await selectZipformer(page);
  const spec = JSON.parse(await readFile('scripts/zipformer-assets.json', 'utf8'));
  const host = await page.evaluate(() => ({ browser: navigator.userAgent, isolated: crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency }));
  try {
    for (const name of ['0.wav', '1.wav', 'silence', 'empty', '0.wav']) {
      let pcm = [];
      if (name.endsWith('.wav')) {
        const wav = await readFile(`.cache/zipformer-en/test_wavs/${name}`);
        expect(createHash('sha256').update(wav).digest('hex')).toBe(spec.files.find(e => e.path === `test_wavs/${name}`).sha256);
        pcm = pcm16(wav);
      } else if (name === 'silence') pcm = new Array(16000 * 13).fill(0);
      await page.evaluate(() => { window.zipEvents = []; window.fedSamples = 0; });
      const start = Date.now(); await startGraph(page, 120000); const loaded = Date.now();
      await page.evaluate(async ({ pcm, paced }) => {
        window.zipFeedStart = performance.now();
        const sizes = paced ? [1600] : [13, 3201, 701, 1600];
        for (let offset = 0, n = 0; offset < pcm.length; n++) {
          const end = Math.min(pcm.length, offset + sizes[n % sizes.length]);
          window.capture.emit('audio', Float32Array.from(pcm.slice(offset, end))); window.fedSamples = end; offset = end;
          await new Promise(resolve => setTimeout(resolve, paced ? 100 : 5));
        }
      }, { pcm, paced: name === '0.wav' });
      const stopRequestMs = await page.evaluate(() => performance.now());
      const stopAt = Date.now(); await page.locator('#stop').click();
      await expect(page.locator('#start')).toBeEnabled({ timeout: 120000 });
      await expect(page.locator('#errors')).toBeEmpty();
      const events = await page.evaluate(() => window.zipEvents);
      const feedStartMs = await page.evaluate(() => window.zipFeedStart);
      const texts = (await page.locator('.display-content').textContent()).split('\n').filter(Boolean);
      const partial = events.find(e => e.type === 'partial' && e.text), final = events.find(e => e.type === 'final');
      if (name.endsWith('.wav')) {
        expect(partial).toBeTruthy(); expect(final).toBeTruthy();
        expect(events.indexOf(partial)).toBeLessThan(events.indexOf(final)); expect(partial.fed).toBeLessThan(pcm.length);
        expect(partial.text).not.toBe(final.text);
        expect(partial.id).toBe(0);
        expect(events.filter(e => e.type === 'partial' && e.text).length).toBeGreaterThan(1);
        expect(texts.join(' ')).toMatch(name === '0.wav' ? /yellow lamps.*light.*quarter/i : /direct consequence.*lovely child.*heaven/i);
        expect(texts).toHaveLength(name === '0.wav' ? 1 : 2);
        expect(new Set(events.filter(e => e.type === 'final').map(e => e.id)).size).toBe(texts.length);
        if (name === '1.wav') {
          const boundary = events.indexOf(final), next = events.slice(boundary + 1).find(e => e.type === 'partial' && e.text);
          expect(next?.id).toBe(1); expect(next.text).not.toContain(final.text);
        }
      } else { expect(texts).toEqual([]); expect(partial).toBeUndefined(); }
      expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
      runs.push({ name, feedStartMs, stopRequestMs, firstPartialMs: partial ? partial.ms - feedStartMs : null, firstPartialAtAudioSeconds: partial ? partial.fed / 16000 : null, lastFinalAfterStopMs: final ? events.filter(e => e.type === 'final').at(-1).ms - stopRequestMs : null, samples: pcm.length, pacing: name === '0.wav' ? '100ms blocks paced at real time' : 'irregular blocks accelerated at 5ms each', texts, loadMs: loaded - start, stopDrainMs: Date.now() - stopAt, totalMs: Date.now() - start, events });
      console.log(JSON.stringify({ ...runs.at(-1), events: events.length }));
    }
    expect(requests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    const output = info.outputPath('zipformer-evidence.json');
    await writeFile(output, JSON.stringify({ time: new Date().toISOString(), host, model: spec.source, revision: spec.revision, fixtures: spec.files.filter(entry => entry.path.startsWith('test_wavs/')), inference: 'Real packaged SIMD online WASM, production Node/Worker; pinned WAV replaces capture hardware', runs, requests, errors }, null, 2) + '\n');
    await info.attach('zipformer-evidence', { path: output, contentType: 'application/json' });
  }
});
