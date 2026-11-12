import { settleAutoSave } from '../extension/ui-controls.js';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openPalette } from '../extension/ui-controls.js';

test('KeyedTextCoalesce palette, independent wiring, settings, save/reload and runtime fan-out', async ({ page }) => {
  // Exercise the real editor/runtime without capture APIs or model assets.
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))),
      contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/extension/graph-editor.html');
  await page.evaluate(async () => {
    const { graphNode, edge, GRAPH_VERSION } = await import('/extension/graph.js'); const { saveLiveGraphData } = await import('/extension/graph-library.js');
    const nodes = [graphNode('Number', 'key'), graphNode('Text', 'preferred', 20, 300), graphNode('Text', 'backup', 20, 600),
      graphNode('KeyedTextPair', 'pair', 650),
      graphNode('Display', 'paired-display', 980), graphNode('Display', 'plain-display', 980, 400)];
    nodes[0].settings.value = 10; nodes[1].settings.value = ''; nodes[2].settings.value = 'backup';
    await saveLiveGraphData(localStorage, { version: GRAPH_VERSION, nodes, edges: [edge('pair', 'pair', 'paired-display', 'input1')] });
    localStorage.setItem('processing-graph-before-v14', 'original backup');
  });
  await page.reload(); await openPalette(page);
  await page.getByLabel('Node category', { exact: true }).selectOption('Processors');
  await page.getByLabel('Search nodes').fill('KeyedTextCoalesce');
  await page.locator('#graph-node-type [data-type="KeyedTextCoalesce"]').click();
  await expect(page.locator('.graph-inspector').getByText('Node help and ports', { exact: true })).toHaveCount(0);
  await expect(page.locator('.graph-inspector input, .graph-inspector select, .graph-inspector textarea')).toHaveCount(0);
  const port = name => page.getByRole('button', { name, exact: true });
  await port('key output value').click();
  await expect(port('keyedtextcoalesce input input1')).toBeDisabled();
  await port('keyedtextcoalesce input id1').click();
  await port('key output value').click(); await port('keyedtextcoalesce input id2').click();
  await port('preferred output value').click();
  await expect(port('keyedtextcoalesce input id1')).toBeDisabled();
  await port('keyedtextcoalesce input input1').click();
  await port('backup output value').click(); await port('keyedtextcoalesce input input2').click();
  await port('keyedtextcoalesce output id').click(); await port('pair input id1').click();
  await port('keyedtextcoalesce output text').click(); await port('pair input input1').click();
  await port('keyedtextcoalesce output text').click(); await port('plain-display input input1').click();
  await settleAutoSave(page);
  await expect(page.locator('#graph-errors')).toBeEmpty();
  const saved = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await page.reload();
  for (const name of ['id1', 'input1', 'id2', 'input2']) await expect(port(`keyedtextcoalesce input ${name}`)).toBeAttached();
  await page.getByRole('button', { name: 'Select keyedtextcoalesce', exact: true }).press('Enter');
  await expect(page.locator('.graph-inspector details')).toHaveCount(0);
  const snapshots = await page.evaluate(async () => {
    const { readLiveGraphData } = await import('/extension/graph-library.js');
    const { buildGraph } = await import('/extension/graph-runtime.js');
    const out = { paired: [], plain: [] };
    const { pipeline } = buildGraph(readLiveGraphData(localStorage), { onDisplay(id, dom) {
      out[id === 'paired-display' ? 'paired' : 'plain'].push(dom.querySelector('td')?.textContent ?? dom.textContent);
    } });
    await pipeline.start(); await pipeline.stop(); await pipeline.dispose();
    if (pipeline.errors.length) throw pipeline.errors[0];
    return out;
  });
  // Both literal texts wait for the shared Number source's first ID delivery.
  expect(snapshots).toEqual({ paired: ['', 'backup'], plain: ['', 'backup'] });
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(saved);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-before-v14'))).toBe('original backup');
});
