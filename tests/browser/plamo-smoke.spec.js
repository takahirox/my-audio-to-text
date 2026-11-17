import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { PLAMO_3_TRANSLATE_2B } from '../../web/plamo-policy.js';

test('real PLaMo 3 Translate 2B: both directions, auto source, cache reuse and cancellation', async ({}, testInfo) => {
  test.skip(process.env.PLAMO_SMOKE !== '1' || testInfo.project.name !== 'chromium', 'Opt-in real 1.81 GB model; desktop Chrome and sufficient memory required.');
  test.setTimeout(900000);
  // A dedicated disk-backed profile avoids incognito's reduced storage quota.
  // It never opens or modifies a user's normal Chrome profile.
  const context = await chromium.launchPersistentContext(path.resolve('.cache/plamo-review/browser-profile'), {
    channel: process.env.TRANSLATION_CHANNEL || 'chrome', headless: !process.env.TRANSLATION_HEADED,
  });
  const page = await context.newPage(), browser = context.browser();
  const requests = [], errors = [], runs = [];
  context.on('request', request => requests.push({ url: new URL(request.url()).origin + new URL(request.url()).pathname,
    method: request.method(), hasBody: request.postData() !== null }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('./nodes/plamo-3-translate-2b/');
  await expect(page.locator('#run')).toBeEnabled();
  const capabilities = await page.evaluate(async () => ({ userAgent: navigator.userAgent, isolated: crossOriginIsolated,
    secure: isSecureContext, jspi: typeof WebAssembly.Suspending === 'function', storage: await navigator.storage.estimate() }));
  console.log(JSON.stringify({ capabilities }));
  const reportProgress = setInterval(async () => {
    console.log('PLaMo:', await page.locator('#status').textContent().catch(() => 'closed'));
  }, 30000);
  try {
    for (const sample of [
      { text: '会議は来週の月曜日に変更されました。', source: '', target: '', expected: /meeting.*(?:next Monday|Monday next week)/i },
      { text: 'The weather is nice today.', source: 'en', target: 'ja', expected: /今日.*(?:天気|晴)/ },
      { text: 'Please open the project dashboard.', source: 'auto', target: 'ja', expected: /(?:ダッシュボード|管理画面)/ },
    ]) {
      await page.locator('#input').fill(sample.text);
      await page.locator('#source-lang').fill(sample.source);
      await page.locator('#target-lang').fill(sample.target);
      const before = requests.length;
      await page.locator('#run').click();
      await expect(page.locator('#status')).toHaveText(/^(Complete|Error)$/, { timeout: 840000 });
      const result = await page.evaluate(() => Object.fromEntries(['status', 'errors', 'output', 'load-time', 'latency'].map(id => [id, document.getElementById(id).textContent])));
      runs.push({ ...sample, expected: String(sample.expected), ...result, requests: requests.length - before });
      console.log(JSON.stringify(runs.at(-1)));
      expect(result.errors).toBe(''); expect(result.status).toBe('Complete');
      expect(result.output).toMatch(sample.expected);
      if (runs.length > 1) expect(requests.slice(before).filter(request => new URL(request.url).origin !== new URL(page.url()).origin)).toEqual([]);
    }
    await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveText('Translating…', { timeout: 120000 });
    await page.locator('#cancel').click();
    await expect(page.locator('#status')).toHaveText('Canceled');
    await expect(page.locator('#run')).toBeEnabled();
    const cdp = await browser.newBrowserCDPSession();
    await expect.poll(async () => (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker').length).toBe(0);
    await cdp.detach();
    // Fresh Worker retries against the already verified browser cache.
    await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveText('Complete', { timeout: 120000 });
    await expect(page.locator('#output')).toContainText('ダッシュボード');
    expect(errors).toEqual([]);
    for (const request of requests) {
      expect(request.method).toBe('GET'); expect(request.hasBody).toBe(false);
      for (const run of runs) expect(decodeURIComponent(request.url)).not.toContain(run.text);
      const url = new URL(request.url);
      if (url.origin !== new URL(page.url()).origin && url.hostname === 'huggingface.co')
        expect(url.pathname).toContain(`/${PLAMO_3_TRANSLATE_2B.id}/resolve/${PLAMO_3_TRANSLATE_2B.revision}/`);
    }
  } finally {
    clearInterval(reportProgress);
    const path = testInfo.outputPath('plamo-evidence.json');
    const evidence = JSON.stringify({ browser: browser.version(), capabilities, model: PLAMO_3_TRANSLATE_2B,
      runs, errors, requests }, null, 2) + '\n';
    await writeFile(path, evidence);
    await writeFile('.cache/plamo-review/browser-evidence.json', evidence);
    await testInfo.attach('plamo-evidence', { path, contentType: 'application/json' });
    await context.close();
  }
});
