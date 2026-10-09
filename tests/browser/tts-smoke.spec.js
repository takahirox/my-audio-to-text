import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, arch } from 'node:os';
import { observeTts } from './tts-fixture.js';

for (const slug of ['supertonic3', 'kokoro']) {
  test(`real ${slug}: Japanese and English waveform, playback, repeat and local-only requests`, async ({ page, browser }, info) => {
    test.skip(!['all', slug].includes(process.env.TTS_SMOKE) || info.project.name !== 'chromium', 'Opt-in real-model inference: TTS_SMOKE=all (or model slug).');
    test.setTimeout(900000);
    const requests = [], errors = [], runs = [];
    const texts = { ja: 'こんにちは。今日は良い天気です。', en: 'Hello. It is a beautiful day today.' };
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.protocol === 'blob:' || url.protocol === 'data:') return;
      requests.push({ origin: url.origin, path: url.pathname, method: request.method(), hasBody: !!request.postData(),
        containsText: Object.values(texts).some(text => request.url().includes(text) || request.url().includes(encodeURIComponent(text))) });
    });
    const prefix = !process.env.ASR_BASE_URL && !process.env.ASR_BENCHMARK ? './my-audio-to-text/' : './';
    await page.goto(prefix + 'nodes/' + slug + '/'); await expect(page.locator('#run')).toBeEnabled(); await observeTts(page);
    const device = await page.evaluate(() => ({ userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency,
      wasm: typeof WebAssembly === 'object', gzip: typeof DecompressionStream === 'function', isolated: crossOriginIsolated, secure: isSecureContext }));
    const host = { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model };
    try {
      for (const language of ['ja', 'en', 'en']) {
        if (slug === 'kokoro') await page.locator('#voice').selectOption(language === 'ja' ? 'jf_alpha' : 'af_heart');
        else await page.locator('#language').selectOption(language);
        await page.locator('#input').fill(texts[language]); await page.locator('#run').click();
        await expect(page.locator('#status')).toHaveText(/^(Complete|Error)$/, { timeout: 840000 });
        const result = await page.evaluate(() => ({ status: document.getElementById('status').textContent,
          error: document.getElementById('errors').textContent, load: document.getElementById('load-time').textContent,
          generation: document.getElementById('latency').textContent, waveform: window.ttsWaveforms.at(-1) }));
        runs.push({ language, ...result }); console.log(JSON.stringify({ slug, language, browser: browser.version(), device, host, ...result }));
        expect(result.error).toBe(''); expect(result.status).toBe('Complete');
        expect(result.waveform.sampleRate).toBe(slug === 'kokoro' ? 24000 : 44100); expect(result.waveform.channels).toBe(1);
        expect(result.waveform.finite).toBe(true); expect(result.waveform.samples).toBeGreaterThan(0);
        expect(result.waveform.duration).toBeGreaterThan(0.25); expect(result.waveform.duration).toBeLessThan(30);
        expect(result.waveform.rms).toBeGreaterThan(0.00001);
        // Native browser decoder/player consumes the WAV produced by the graph.
        await expect.poll(() => page.evaluate(() => document.getElementById('player').readyState)).toBeGreaterThanOrEqual(2);
        await page.evaluate(async () => { const player = document.getElementById('player'); await player.play(); });
        await expect.poll(() => page.evaluate(() => document.getElementById('player').currentTime)).toBeGreaterThan(0);
        await page.evaluate(() => document.getElementById('player').pause());
        await expect(page.locator('#run')).toBeEnabled();
      }
      expect(errors).toEqual([]);
      for (const request of requests) {
        expect(request.method).toBe('GET'); expect(request.hasBody).toBe(false); expect(request.containsText).toBe(false);
        if (request.origin !== new URL(page.url()).origin) {
          const host = new URL(request.origin).hostname;
          expect(host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co')).toBe(true);
          if (host === 'huggingface.co') {
            const model = slug === 'kokoro' ? 'onnx-community/Kokoro-82M-v1.0-ONNX' : 'supertone-oss-archive/supertonic-3';
            const revision = slug === 'kokoro' ? '1939ad2a8e416c0acfeecc08a694d14ef25f2231' : 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
            expect(request.path.startsWith(`/${model}/resolve/${revision}/`)
              || request.path.startsWith(`/api/resolve-cache/models/${model}/${revision}/`)).toBe(true);
          }
        }
      }
    } finally {
      const path = info.outputPath('tts-evidence.json');
      await writeFile(path, JSON.stringify({ slug, time: new Date().toISOString(), browser: browser.version(), device, host, runs, errors, requests }, null, 2) + '\n');
      await info.attach('tts-evidence', { path, contentType: 'application/json' });
    }
  });
}
