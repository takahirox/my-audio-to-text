import { test, expect, openGraph, startGraph, emitFinal, addAudioPath } from './graph-fixture.js';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';

for (const type of ['Supertonic3', 'Kokoro']) {
  test(`real MV3 ${type}: saved graph Japanese/English TTS, native playback and repeat`, async ({ graphExtension: f }, info) => {
    test.skip(!['all', type].includes(process.env.EXTENSION_TTS_SMOKE), 'Opt-in real TTS under extension CSP: EXTENSION_TTS_SMOKE=all. ASR/capture remain fixtures.');
    test.setTimeout(900000);
    const page = await openGraph(f), requests = [], runs = [], errors = [];
    const texts = { ja: 'こんにちは。今日は良い天気です。', en: 'Hello. It is a beautiful day today.' };
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (!request.url().startsWith('http')) return;
      const url = new URL(request.url());
      requests.push({ origin: url.origin, path: url.pathname, method: request.method(), hasBody: !!request.postData(), containsText: Object.values(texts).some(text => request.url().includes(text) || request.url().includes(encodeURIComponent(text))) });
    });
    const host = { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model };
    const device = await page.evaluate(() => ({ userAgent: navigator.userAgent, isolated: crossOriginIsolated, secure: isSecureContext, cores: navigator.hardwareConcurrency }));
    try {
      await addAudioPath(page, type);
      for (const language of ['ja', 'en', 'en']) {
        if (type === 'Supertonic3') await page.getByLabel('supertonic3 language', { exact: true }).selectOption(language);
        else await page.getByLabel('kokoro voice', { exact: true }).selectOption(language === 'ja' ? 'jf_alpha' : 'af_heart');
        await page.locator('#graph-save').click();
        await page.locator('#prepare-tts').click();
        await expect(page.locator('#tts-model-status')).toContainText('Ready', { timeout: 600000 });
        const begin = Date.now(), before = requests.length;
        await startGraph(page, 300000);
        await expect(page.locator('#tts-status')).toContainText('ready (local)', { timeout: 300000 });
        const loaded = Date.now(); await emitFinal(page, texts[language]);
        await expect(page.locator('#audio-outputs audio')).toHaveCount(1, { timeout: 300000 });
        const generated = Date.now();
        const waveform = await page.locator('#audio-outputs audio').evaluate(async player => {
          const bytes = await (await fetch(player.src)).arrayBuffer(); const context = new AudioContext();
          const sampleRate = new DataView(bytes).getUint32(24, true);
          const buffer = await context.decodeAudioData(bytes); const samples = buffer.getChannelData(0);
          // WAV's explicit native sample rate, independent of decoder resampling.
          const result = { sampleRate, channels: buffer.numberOfChannels, samples: samples.length, finite: samples.every(Number.isFinite), duration: buffer.duration,
            rms: Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length) };
          await context.close(); await player.play(); return result;
        });
        await expect.poll(() => page.locator('#audio-outputs audio').evaluate(player => player.currentTime)).toBeGreaterThan(0);
        await page.locator('#audio-outputs audio').evaluate(player => player.pause());
        expect(waveform.sampleRate).toBe(type === 'Supertonic3' ? 44100 : 24000); expect(waveform.channels).toBe(1);
        expect(waveform.finite).toBe(true); expect(waveform.rms).toBeGreaterThan(.00001); expect(waveform.duration).toBeGreaterThan(.25); expect(waveform.duration).toBeLessThan(30);
        expect(requests.slice(before)).toEqual([]);
        await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
        expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
        runs.push({ language, loadMs: loaded - begin, generationMs: generated - loaded, waveform });
        console.log(JSON.stringify({ type, language, ...runs.at(-1) }));
      }
      expect(errors).toEqual([]); expect(requests.every(r => r.method === 'GET' && !r.hasBody && !r.containsText)).toBe(true);
    } finally {
      const output = info.outputPath('extension-tts-evidence.json');
      await writeFile(output, JSON.stringify({ type, time: new Date().toISOString(), browser: device.userAgent, device, host, inference: 'Real packaged TTS; ASR and tab source fixtures', runs, errors, requests }, null, 2) + '\n');
      await info.attach('extension-tts-evidence', { path: output, contentType: 'application/json' });
    }
  });
}
