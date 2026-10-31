import { test, expect, chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { translationContextFixtures } from '../fixtures/translation-context.js';
import { TRANSLATE_GEMMA } from '../../web/translation-models.js';

for (const direction of ['en-ja', 'ja-en']) test(`real TranslateGemma ${direction}: official vs context, target-only output and reset`, async ({ page: fixturePage, browser }, info) => {
  test.skip(!process.env.TRANSLATEGEMMA_CONTEXT_SMOKE || info.project.name !== 'chromium', 'Opt in with TRANSLATEGEMMA_CONTEXT_SMOKE=1; pinned runtime, 3.112 GB weights and Worker WebGPU required.');
  test.setTimeout(900000);
  const probes = translationContextFixtures[direction], runs = [], networkErrors = [], requests = [];
  let capabilities, failure, persistent, page = fixturePage;
  if (process.env.TRANSLATEGEMMA_PROFILE_DIR) {
    persistent = await chromium.launchPersistentContext(process.env.TRANSLATEGEMMA_PROFILE_DIR, {
      channel: process.env.TRANSLATION_CHANNEL || 'chromium', headless: !process.env.TRANSLATION_HEADED,
    });
    page = await persistent.newPage();
  }
  page.on('console', message => { if (message.text().includes('assetLoaded')) console.log(message.text()); });
  page.on('requestfailed', r => networkErrors.push({ url: new URL(r.url()).origin + new URL(r.url()).pathname, error: r.failure()?.errorText }));
  page.on('request', r => requests.push({ url: new URL(r.url()).origin + new URL(r.url()).pathname,
    method: r.method(), hasBody: r.postData() !== null,
    containsData: probes.some(probe => [probe.text, probe.context].some(value => decodeURIComponent(r.url()).includes(value))) }));
  try {
    await page.goto('./nodes/translategemma/');
    capabilities = await page.evaluate(() => ({ gpu: !!navigator.gpu, secure: isSecureContext }));
    const result = await page.evaluate(async ({ direction, probes }) => {
      const worker = new Worker(new URL('../../translategemma-worker.js', location.href), { type: 'module' });
      let id = 0;
      const pending = new Map(), runs = [];
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          if (data.status === 'done') console.log(JSON.stringify({ direction, assetLoaded: data.file }));
          return;
        }
        const request = pending.get(data.id); if (!request) return;
        pending.delete(data.id);
        if (data.type === 'error') request.reject(Error(data.message)); else request.resolve(data);
      };
      worker.onerror = event => { for (const p of pending.values()) p.reject(Error(event.message)); pending.clear(); };
      const request = payload => new Promise((resolve, reject) => {
        const requestId = ++id; pending.set(requestId, { resolve, reject }); worker.postMessage({ id: requestId, ...payload });
      });
      try {
        await request({ type: 'load', direction });
        for (const probe of probes) {
          const run = { text: probe.text, context: probe.context };
          runs.push(run);
          for (const [mode, context] of [['official', undefined], ['contextual', probe.context], ['reset', '']]) {
            const start = performance.now();
            const reply = await request({ type: 'translate', text: probe.text, ...(context === undefined ? {} : { context }) });
            run[mode] = reply.texts; run[mode + 'Ms'] = performance.now() - start;
          }
        }
        return { runs };
      } catch (error) { return { runs, error: error.message }; }
      finally { worker.terminate(); }
    }, { direction, probes: probes.map(({ text, context }) => ({ text, context })) });
    runs.push(...result.runs);
    failure = result.error;
    console.log(JSON.stringify({ direction, browser: browser.version(), capabilities, ...result }));
    expect(result.error).toBeUndefined();
    expect(requests.every(r => r.method === 'GET' && !r.hasBody && !r.containsData)).toBe(true);
    expect(runs).toHaveLength(probes.length);
    for (const [i, run] of runs.entries()) {
      expect(run.contextual).toHaveLength(1); expect(run.contextual[0].trim()).not.toBe('');
      expect(run.reset).toEqual(run.official);
      for (const meaning of probes[i].meanings) expect(run.contextual[0]).toMatch(meaning);
      expect(run.contextual[0]).not.toMatch(probes[i].forbidden);
      expect(run.contextual[0]).not.toMatch(/```|"(?:context|text)"\s*:|^(?:translation|context|翻訳|訳文)\s*[:：]/i);
    }
  } finally {
    const file = info.outputPath('context-inference-evidence.json');
    await writeFile(file, JSON.stringify({ direction, model: TRANSLATE_GEMMA, time: new Date().toISOString(), browser: browser.version(), capabilities, failure, runs, networkErrors, requests }, null, 2) + '\n');
    await info.attach('context-inference-evidence', { path: file, contentType: 'application/json' });
    await persistent?.close();
  }
});
