import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { OPUS_MT, TRANSLATE_GEMMA } from '../../web/translation-models.js';

for (const [choice, slug] of [['opus', 'opus-mt'], ['gemma', 'translategemma']]) {
  test(`real ${choice}: Japanese → English initialization, inference and repeat`, async ({ page, browser }, testInfo) => {
    test.skip(process.env.TRANSLATION_SMOKE !== choice || testInfo.project.name !== 'chromium', 'Opt-in real translation inference; large downloads and suitable device required.');
    test.setTimeout(900000);
    const fixture = '今日は良い天気です。';
    const requests = [], errors = [];
    page.on('request', request => requests.push({ url: new URL(request.url()).origin + new URL(request.url()).pathname, method: request.method(), hasBody: request.postData() !== null, containsInput: request.url().includes(fixture) || request.url().includes(encodeURIComponent(fixture)) }));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`./nodes/${slug}/`);
    await expect(page.locator('#run')).toBeEnabled();
    const capabilities = await page.evaluate(async choice => {
      // Capability probing must not delay a WASM run or hang smoke setup.
      const adapter = choice === 'gemma' && navigator.gpu
        ? await Promise.race([navigator.gpu.requestAdapter(), new Promise(resolve => setTimeout(() => resolve(null), 5000))])
        : null;
      const info = adapter?.info;
      return { gpu: !!navigator.gpu, adapter: choice === 'gemma' ? !!adapter : null, gpuInfo: info ? { vendor: info.vendor, architecture: info.architecture, description: info.description } : null, userAgent: navigator.userAgent, secure: isSecureContext, isolated: crossOriginIsolated };
    }, choice);
    console.log(JSON.stringify({ choice, browser: browser.version(), capabilities }));
    const runs = [];
    try {
      for (let run = 0; run < 2; run++) {
        await page.locator('#input').fill(fixture); await page.locator('#run').click();
        await expect(page.locator('#status')).toHaveText(/^(Complete|Error)$/, { timeout: 840000 });
        const result = await page.evaluate(() => Object.fromEntries(['status', 'errors', 'output', 'load-time', 'latency'].map(id => [id, document.getElementById(id).textContent])));
        runs.push(result);
        console.log(JSON.stringify({ choice, browser: browser.version(), capabilities, run, fixture, ...result }));
        expect(result.errors).toBe(''); expect(result.status).toBe('Complete');
        expect(result.output.trim().length).toBeGreaterThan(0); expect(result.output).toMatch(/[A-Za-z]/);
        await expect(page.locator('#run')).toBeEnabled();
      }
      expect(errors).toEqual([]);
      for (const request of requests) {
        expect(request.method).toBe('GET'); expect(request.hasBody).toBe(false);
        expect(decodeURIComponent(request.url)).not.toContain(fixture);
        expect(request.containsInput).toBe(false);
        const url = new URL(request.url);
        if (url.origin !== new URL(page.url()).origin) {
          expect(['huggingface.co', 'hf.co'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))).toBe(true);
          if (url.hostname === 'huggingface.co') {
            const model = choice === 'opus' ? OPUS_MT : TRANSLATE_GEMMA;
            // Hugging Face redirects small assets to a pinned metadata-cache
            // GET endpoint. This is asset delivery, not inference.
            expect(url.pathname.startsWith(`/${model.id}/resolve/${model.revision}/`)
              || url.pathname.startsWith(`/api/resolve-cache/models/${model.id}/${model.revision}/`)).toBe(true);
          }
        }
      }
    } finally {
      const path = testInfo.outputPath('translation-evidence.json');
      await writeFile(path, JSON.stringify({ choice, browser: browser.version(), capabilities, fixture, runs, errors, requests }, null, 2) + '\n');
      await testInfo.attach('translation-evidence', { path, contentType: 'application/json' });
    }
  });
}
