import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
    const body = ['/extension/recorder.js', '/extension/navigation.js'].includes(pathname) ? '' : await readFile(path.resolve(pathname.slice(1)));
    await route.fulfill({ body, contentType });
  });
  await page.goto('/extension/recorder.html');
});

for (const ending of ['stop', 'cancel']) test(`paired history: interleaved ASR, delayed translation, safe/empty/repeated text, ${ending} and restart`, async ({ page }) => {
  await page.evaluate(async () => {
    const { defaultGraph } = await import('/extension/graph.js');
    const { buildGraph } = await import('/extension/graph-runtime.js');
    const { renderTextRegions } = await import('/extension/live-text-regions.js');
    const graph = defaultGraph({ enabled: true, direction: 'en-ja' }), displays = {};
    window.pending = []; window.events = []; window.workers = [];
    const factory = () => {
      const worker = { postMessage(data) {
        if (data.type === 'translate') { pending.push(() => worker.onmessage?.({ data: { type: 'result', id: data.id, texts: ['translated:' + data.text] } })); return; }
        const type = { load: 'ready', 'vad-stop': 'vad-stopped', drain: 'drained' }[data.type];
        if (type) queueMicrotask(() => worker.onmessage?.({ data: { type, id: data.id, session: data.session } }));
      }, terminate() { this.released = true; } }; workers.push(worker); return worker;
    };
    window.begin = async () => {
    window.pending.length = 0;
    window.built = buildGraph(graph, { tabId: 42, sourceFactory: () => ({ start() {}, stop() {} }),
      workerFactory: factory, translationWorkerFactory: factory, prepareTranslation: async () => {},
      onDisplay(id, dom) {
        displays[id] = dom; renderTextRegions(document.querySelector('#live-displays'), graph, displays);
        events.push([...dom.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent)));
      } });
    await built.pipeline.start();
    window.speech = built.speechNodes.get('speech');
    window.send = (type, id, text) => speech.receiveEvent({ type, id, text });
    }; await begin();
  });
  const rows = page.locator('.display-content tr'), cells = page.locator('.display-content td');
  await page.evaluate(() => send('partial', 0, '<img src=x>\nA')); await expect(cells).toHaveText(['<img src=x>\nA', '']);
  await page.evaluate(() => send('final', 0, 'same')); await expect(cells).toHaveText(['same', '']);
  // Every observed final replacement stays nonblank, including queued renders.
  expect(await page.evaluate(() => events.slice(events.findIndex(rows => rows[0]?.[0] === '<img src=x>\nA') + 1).every(rows => rows[0]?.[0] === 'same'))).toBe(true);
  await page.evaluate(() => send('partial', 1, 'B')); await expect(cells).toHaveText(['same', '', 'B', '']);
  await expect.poll(() => page.evaluate(() => pending.length)).toBe(1);
  await page.evaluate(() => pending.shift()()); await expect(cells).toHaveText(['same', 'translated:same', 'B', '']);
  await page.evaluate(() => { send('final', 1, 'same'); send('final', 2, ''); });
  await expect(rows).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => pending.length)).toBe(1);
  await page.evaluate(() => pending.shift()()); await expect(cells).toHaveText(['same', 'translated:same', 'same', 'translated:same', '', '']);
  await page.evaluate(() => { send('final', 1, 'duplicate ignored'); send('partial', 0, 'late ignored'); });
  await expect(rows).toHaveCount(3); await expect(cells).toHaveText(['same', 'translated:same', 'same', 'translated:same', '', '']);
  await expect(page.locator('#live-displays img, #live-displays script')).toHaveCount(0);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await rows.first().locator('td').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
    expect(geometry[0]).toBeCloseTo(geometry[1], 0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  const retained = await cells.allTextContents();
  await page.evaluate(async ending => { await built.pipeline[ending](); await built.pipeline.dispose(); send('final', 3, 'stale'); }, ending);
  await expect(cells).toHaveText(retained); expect(await page.evaluate(() => workers.every(worker => worker.released))).toBe(true);
  expect(await page.evaluate(() => built.pipeline.errors)).toEqual([]);
  await page.evaluate(() => begin()); await expect(rows).toHaveCount(0);
  await page.evaluate(() => send('final', 0, 'new session')); await expect(cells).toHaveText(['new session', '']);
  await page.evaluate(async () => { await built.pipeline.cancel(); await built.pipeline.dispose(); pending.shift()?.(); });
  await expect(cells).toHaveText(['new session', '']);
});

test('Display accepts TEXT and pair snapshots literally and replaces complete histories without accumulating', async ({ page }) => {
  await page.evaluate(async () => {
    const { DisplayNode } = await import('/web/display-node.js');
    const { renderTextRegions } = await import('/extension/live-text-regions.js');
    const graph = { nodes: [{ id: 'text', type: 'Display', settings: {} }] }, root = document.querySelector('#live-displays');
    const context = { signal: new AbortController().signal };
    window.display = new DisplayNode(dom => renderTextRegions(root, graph, { text: dom })); display.start(context);
    window.renderItem = value => display.receive('input1', value, context);
  });
  const content = page.locator('.display-content');
  await page.evaluate(() => renderItem('<b>literal</b>\n日本語')); await expect(content).toHaveText('<b>literal</b>\n日本語');
  await expect(content.locator('b')).toHaveCount(0);
  await page.evaluate(() => renderItem([{ id: 2, first: 'A', second: '訳' }, { id: 1, first: 'B', second: '' }]));
  await expect(content.locator('td')).toHaveText(['A', '訳', 'B', '']);
  await page.evaluate(() => renderItem({ id: 1, first: 'only', second: '' })); await expect(content.locator('tr')).toHaveCount(1);
  await page.evaluate(() => renderItem('')); await expect(content).toBeEmpty();
  await page.evaluate(() => renderItem([])); await expect(content).toBeEmpty();
});
