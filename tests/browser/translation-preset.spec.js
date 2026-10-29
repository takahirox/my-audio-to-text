import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Inspect the production graph, DOM processors and Live layout without capture
// or model downloads. Only recorder/navigation startup and model RPCs are stubbed.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
    const body = ['/extension/recorder.js', '/extension/navigation.js'].includes(pathname)
      ? '' : await readFile(path.resolve(pathname.slice(1)));
    await route.fulfill({ body, contentType });
  });
  await page.goto('/extension/recorder.html');
});

for (const direction of ['ja-en', 'en-ja']) {
  test(`${direction}: legacy import keeps original history and preview independently of the latest comparison`, async ({ page }, info) => {
    const pairs = direction === 'ja-en'
      ? [['最初の発話', 'First utterance'], ['次の発話', 'Second utterance']]
      : [['First utterance', '最初の発話'], ['Second utterance', '次の発話']];
    const history = pairs.map(([source]) => source).join('\n');
    await page.evaluate(async direction => {
      const { readGraph } = await import('/extension/graph.js');
      const { buildGraph } = await import('/extension/graph-runtime.js');
      const { renderTextRegions } = await import('/extension/live-text-regions.js');
      localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: true, direction }));
      const graph = readGraph(localStorage), displays = {};
      window.savedPreset = localStorage.getItem('processing-graph-v1');
      window.translationLoads = []; window.translationStates = [];
      window.pendingTranslations = [];
      const workerFactory = url => ({
        postMessage(data) {
          if (data.type === 'translate') {
            const translations = { '最初の発話': 'First utterance', '次の発話': 'Second utterance', 'First utterance': '最初の発話', 'Second utterance': '次の発話' };
            pendingTranslations.push(() => this.onmessage({ data: data.text === 'Failed original'
              ? { type: 'error', id: data.id, message: 'Fixture translation unavailable' }
              : { type: 'result', id: data.id, texts: [translations[data.text]] } }));
            return;
          }
          const reply = { load: 'ready', 'vad-stop': 'vad-stopped', drain: 'drained' }[data.type];
          if (reply) {
            if (data.type === 'load' && String(url).includes('opus-mt')) translationLoads.push(String(url).includes('en-ja') ? 'en-ja' : 'ja-en');
            queueMicrotask(() => this.onmessage({ data: { type: reply, id: data.id, session: data.session } }));
          }
        }, terminate() {},
      });
      const render = () => renderTextRegions(document.getElementById('live-displays'), graph, displays);
      window.built = buildGraph(graph, {
        onTranslationState: state => translationStates.push(state),
        tabId: 42, sourceFactory: () => ({ start() {}, stop() {} }),
        workerFactory, translationWorkerFactory: workerFactory, prepareTranslation: async () => {},
        onDisplay(id, dom) { displays[id] = dom; render(); },
      });
      render();
      await built.pipeline.start();
      window.emitSpeech = (type, text) => built.speechNodes.get('speech').receiveEvent({ type, text });
    }, direction);
    const original = page.getByRole('region', { name: 'Original', exact: true });
    const comparison = page.getByRole('region', { name: 'Translation', exact: true });
    const transcript = original.locator('.display-content');
    const rows = comparison.locator('tbody tr');
    await expect(page.locator('.live-text-region')).toHaveCount(2);
    await expect(original).toHaveAttribute('lang', direction === 'en-ja' ? 'en' : 'ja');
    await page.evaluate(() => emitSpeech('partial', 'Live preview'));
    await expect(transcript).toHaveText('Live preview');
    await expect(rows).toHaveCount(0);
    for (const [text, translation] of pairs) {
      await page.evaluate(text => emitSpeech('final', text), text);
      await expect.poll(() => page.evaluate(() => pendingTranslations.length)).toBe(1);
      await expect(transcript).toHaveText(text === pairs[0][0] ? text : history);
      // Originals remain readable while inference is pending.
      await page.evaluate(() => pendingTranslations.shift()());
      await expect(rows).toHaveCount(1);
      await expect(rows.locator('td')).toHaveText([text, translation]);
      await expect(rows.locator('td').nth(0)).toHaveAttribute('aria-label', 'First text: ' + text);
      await expect(rows.locator('td').nth(1)).toHaveAttribute('aria-label', 'Second text: ' + translation);
    }
    expect(await page.evaluate(() => translationLoads)).toEqual([direction]);
    await page.evaluate(() => emitSpeech('partial', 'Next live preview'));
    await expect(transcript).toHaveText(history + '\nNext live preview');
    await expect(rows).toHaveCount(1);
    await page.screenshot({ path: info.outputPath(`legacy-${direction}.png`), fullPage: true });
    await page.evaluate(() => emitSpeech('final', 'Failed original'));
    await expect.poll(() => page.evaluate(() => pendingTranslations.length)).toBe(1);
    await page.evaluate(() => pendingTranslations.shift()());
    await expect(rows.locator('td')).toHaveText(['Failed original', '']);
    expect(await page.evaluate(() => translationStates)).toContain('Translation unavailable: Fixture translation unavailable');
    await expect(transcript).toHaveText(history + '\nFailed original');
    await page.evaluate(() => emitSpeech('partial', 'Discard at Stop'));
    await expect(transcript).toHaveText(history + '\nFailed original\nDiscard at Stop');
    await page.evaluate(async () => { await built.pipeline.stop(); await built.pipeline.dispose(); });
    await expect(transcript).toHaveText(history + '\nFailed original');
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1') === savedPreset)).toBe(true);
    await page.reload();
    expect(await page.evaluate(async () => {
      const { readGraph, saveGraph } = await import('/extension/graph.js');
      const raw = localStorage.getItem('processing-graph-v1');
      saveGraph(localStorage, readGraph(localStorage));
      return localStorage.getItem('processing-graph-v1') === raw;
    })).toBe(true);
  });
}
