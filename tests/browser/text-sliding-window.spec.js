import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openPalette } from '../extension/ui-controls.js';

test.beforeEach(async ({ page }) => {
  // Run actual editor/runtime modules in both engines without capture or models.
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/extension/graph-editor.html');
});

test('processor palette connects TEXT/NUMBER, saves, reloads and runs the rolling window without Settings', async ({ page }) => {
  await page.evaluate(async () => {
    const { graphNode, saveGraph, GRAPH_VERSION } = await import('/extension/graph.js');
    const nodes = [graphNode('Text', 'source'), graphNode('Number', 'limit', 20, 300), graphNode('TextToDOM', 'format', 650), graphNode('LiveTextDisplay', 'display', 980)];
    nodes[0].settings.value = 'old newest'; nodes[1].settings.value = 6;
    saveGraph(localStorage, { version: GRAPH_VERSION, nodes, edges: [{ from: ['format', 'dom'], to: ['display', 'dom'] }] });
    localStorage.setItem('processing-graph-before-v14', 'original backup');
  });
  await page.reload(); await openPalette(page);
  await page.getByLabel('Node category', { exact: true }).selectOption('Processors');
  await page.locator('#graph-node-type').selectOption('TextSlidingWindow'); await page.locator('#graph-add').click();
  await page.locator('#graph-palette-toggle').click();
  const port = name => page.getByRole('button', { name, exact: true });
  await expect(port('textslidingwindow input maxChars')).toBeAttached();
  await expect(page.locator('.graph-inspector')).toContainText('This Node has no configurable settings.');
  await expect(page.locator('.graph-inspector input, .graph-inspector select, .graph-inspector textarea')).toHaveCount(0);
  await port('limit output value').click();
  await expect(port('textslidingwindow input text')).toBeDisabled();
  await port('textslidingwindow input maxChars').click();
  await port('source output value').click();
  await expect(port('textslidingwindow input maxChars')).toBeDisabled();
  await port('textslidingwindow input text').click();
  await port('textslidingwindow output text').click(); await port('format input text').click();
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  await expect(page.locator('#graph-errors')).toBeEmpty();
  const saved = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  await page.reload();
  await expect(port('textslidingwindow input maxChars')).toBeAttached();
  const snapshots = await page.evaluate(async () => {
    const { readGraph } = await import('/extension/graph.js');
    const { buildGraph } = await import('/extension/graph-runtime.js');
    const results = [];
    for (let i = 0; i < 2; i++) {
      const { pipeline } = buildGraph(readGraph(localStorage), { onDisplay: (_, dom) => results.push(dom.textContent) });
      await pipeline.start(); await pipeline.stop(); await pipeline.dispose();
      if (pipeline.errors.length) throw pipeline.errors[0];
    }
    return results;
  });
  expect(snapshots).toEqual(['', 'newest', '', 'newest']);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(saved);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-before-v14'))).toBe('original backup');
});

test('native sentence/word segmentation retains recent English/Japanese text without timed or lifecycle emissions', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { TextSlidingWindowNode } = await import('/web/text-sliding-window-node.js');
    const runs = [];
    for (const [limit, fragments] of [[20, ['Old sentence. ', 'New sentence. ', 'Tail']], [7, ['古い文。', '新しい文。', '末尾']], [5, ['これはテストです']], [10, ['alpha bravo charlie']]]) {
      const node = new TextSlidingWindowNode(), controller = new AbortController(), snapshots = [];
      node.start({ signal: controller.signal, emit: (_, text) => snapshots.push(text) });
      node.receive('maxChars', limit);
      for (const text of fragments) node.receive('text', text);
      await new Promise(resolve => setTimeout(resolve, 50));
      node.stop(); node.receive('text', 'late'); controller.abort();
      runs.push(snapshots);
    }
    return runs;
  });
  expect(result).toEqual([['Old sentence. ', 'New sentence. ', 'New sentence. Tail'], ['古い文。', '新しい文。', '新しい文。末尾'], ['テストです'], ['charlie']]);
});
