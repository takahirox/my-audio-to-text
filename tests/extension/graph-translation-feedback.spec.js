import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Source-only MV3 package: production Pipeline/scheduler/summary nodes, native
// module Workers and CSP; deterministic replies, no model assets or inference.
for (const type of ['EnglishToJapaneseTranslateGemmaTranslationNode', 'EnglishToJapaneseOpusMtTranslationNode']) {
  test(`MV3 ${type}: independent feedback, FIFO translation, Stop and Cancel/restart`, async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'translation-feedback-'));
    let browser;
    try {
      const root = path.join(temporary, 'extension');
      await cp('extension', path.join(root, 'extension'), { recursive: true });
      await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !source.includes('/vendor') && !source.includes('/tts-assets') });
      await cp('extension/manifest.json', path.join(root, 'manifest.json'));
      await mkdir(path.join(root, 'tests/fixtures'), { recursive: true });
      await cp('tests/fixtures/translation-feedback.js', path.join(root, 'tests/fixtures/translation-feedback.js'));
      const worker = `
        let count = 0; const pending = [];
        self.onmessage = ({ data }) => {
          if (data.type === 'load') postMessage({ type: 'ready', id: data.id });
          if (data.type === 'summarize') postMessage({ type: 'result', id: data.id, summary: 'S' + ++count });
          if (data.type === 'translate') pending.push(data.id);
          if (data.type === 'complete' && pending.shift() === data.result.id) postMessage(data.result);
          if (data.type === 'drain') postMessage({ type: 'drained', id: data.id });
        };
      `;
      for (const name of ['text-summary-worker.js', 'translategemma-worker.js', 'opus-mt-en-ja-worker.js']) {
        await writeFile(path.join(root, 'web', name), worker);
      }
      browser = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
        ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
      const cdp = await browser.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
      const page = await browser.newPage(); const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(`chrome-extension://${id}/extension/recorder.html`);
      await page.evaluate(async type => {
        const { translationFeedback } = await import('../tests/fixtures/translation-feedback.js');
        const { [type]: TranslationNode } = await import('../web/translation-nodes.js');
        window.violations = [];
        addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
        window.fresh = async options => {
          window.f = await translationFeedback({ ...options, TranslationNode, workerFactory: url => {
            const worker = new Worker(url, { type: 'module' });
            const terminate = worker.terminate.bind(worker);
            worker.terminate = () => { worker.released = true; terminate(); }; return worker;
          } });
        };
        await fresh();
        for (const text of ['A', 'B', 'C']) await f.send(text);
      }, type);
      await expect.poll(() => page.evaluate(() => f.hold.value)).toBe('S3');
      expect(await page.evaluate(() => f.summaries)).toEqual(['/A', 'S1/B', 'S2/C']);
      await expect.poll(() => page.evaluate(() => f.requests.length)).toBe(1);
      expect(await page.evaluate(() => f.outputs)).toEqual([]);
      await page.evaluate(() => { window.stopped = false; window.stopping = f.pipeline.stop().then(() => { stopped = true; }); });
      expect(await page.evaluate(() => stopped)).toBe(false);
      for (let i = 0; i < 3; i++) {
        await expect.poll(() => page.evaluate(() => f.requests.length)).toBe(i + 1);
        await page.evaluate(i => f.complete(i), i);
      }
      await page.evaluate(() => stopping);
      expect(await page.evaluate(() => f.outputs.map(o => o.values))).toEqual([1, 2, 3].map(i => ({ source: 'S' + i, text: 'T' + i, error: '' })));
      expect(await page.evaluate(() => f.outputs.every((o, i) => o.values.source === f.accepted[i]))).toBe(true);
      expect(await page.evaluate(() => f.pipeline.errors.map(e => e.message))).toEqual([]);
      await page.evaluate(async () => { await f.pipeline.dispose(); await fresh(); await f.send('cancel'); await f.send('queued'); });
      await expect.poll(() => page.evaluate(() => f.hold.value)).toBe('S2');
      await expect.poll(() => page.evaluate(() => f.requests.length)).toBe(1);
      await page.evaluate(async () => { window.old = f; await f.pipeline.cancel(); old.complete(0, 'late'); await fresh(); await f.send('fresh'); });
      await expect.poll(() => page.evaluate(() => f.requests.length)).toBe(1);
      expect(await page.evaluate(() => old.outputs)).toEqual([]);
      expect(await page.evaluate(() => old.workers.every(w => w.released))).toBe(true);
      expect(await page.evaluate(() => f.summaries)).toEqual(['/fresh']);
      await page.evaluate(() => f.complete(0, 'fresh output')); await page.evaluate(() => f.pipeline.stop());
      expect(await page.evaluate(() => f.outputs.map(o => o.values.text))).toEqual(['fresh output']);
      await page.evaluate(async () => { await f.pipeline.dispose(); await fresh({ failTranslate: true }); await f.send('failure'); await f.send('next'); });
      await expect.poll(() => page.evaluate(() => f.hold.value)).toBe('S2');
      await expect.poll(() => page.evaluate(() => f.requests.length)).toBe(1);
      await page.evaluate(() => f.complete(0)); await page.evaluate(() => f.pipeline.stop());
      expect(await page.evaluate(() => f.outputs.map(o => o.values))).toEqual([
        { source: 'S1', error: 'inference failed' }, { source: 'S2', error: 'inference failed' },
      ]);
      expect(await page.evaluate(() => f.pipeline.errors.map(e => e.message))).toEqual([]);
      await page.evaluate(() => f.pipeline.dispose());
      expect(await page.evaluate(() => f.workers.every(w => w.released))).toBe(true);
      expect(await page.evaluate(() => violations)).toEqual([]); expect(pageErrors).toEqual([]);
    } finally { await browser?.close(); await rm(temporary, { recursive: true, force: true }); }
  });
}
