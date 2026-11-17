import { expectGraphModelsReady } from './ui-controls.js';
import { test, expect, openGraph } from './graph-fixture.js';
import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';
import { openPalette, settleAutoSave } from './ui-controls.js';

async function openModelFreeGraph(f) {
  const seed = await f.context.newPage();
  await seed.goto(f.url.replace('recorder.html', 'model-cache.html'));
  await seed.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), {
    version: GRAPH_VERSION, nodes: [graphNode('Text', 'source'), graphNode('Display', 'display')],
    edges: [edge('source', 'value', 'display', 'input1')],
  });
  await seed.close();
  return openGraph(f);
}

async function trackPersistence(f) {
  const calls = [];
  await f.context.exposeBinding('recordPersistence', ({ page }, operation) => calls.push({ page: page.url(), operation }));
  await f.context.addInitScript(() => {
    navigator.storage.persisted = async () => { await window.recordPersistence('persisted'); return false; };
    navigator.storage.persist = async () => { await window.recordPersistence('persist'); return false; };
  });
  return calls;
}
const operations = calls => calls.map(call => call.operation);
const button = (page, id, name) => page.locator(`#${id}`).getByRole('button', { name, exact: true });

test('Models removes storage controls and keeps discoverable legal links; model-free editing and Live never request persistence', async ({ graphExtension: f }) => {
  const calls = await trackPersistence(f), live = await openModelFreeGraph(f), models = live.models;
  await expect(models.locator('.model-card')).toHaveCount(12);
  await expect(models.locator('#persist, #persistence, main > details')).toHaveCount(0);
  await expect(models.getByText('Storage and cache management', { exact: true })).toHaveCount(0);
  await expect(models.locator('footer')).toHaveCount(0);
  for (const id of ['supertonic3', 'kokoro', 'translategemma']) await models.locator(`#${id} summary`).click();
  for (const [id, name, href] of [
    ['supertonic3', 'License & source for Supertonic 3', '../web/licenses/tts-notices.txt'],
    ['kokoro', 'License & source for Kokoro 82M', '../web/licenses/tts-notices.txt'],
    ['kokoro', 'eSpeak NG source / build bundle (GPL-3.0-or-later)', '../web/tts-assets/phonemizer-source.tar.gz'],
    ['translategemma', 'License / terms for TranslateGemma 4B', '../web/licenses/gemma-notices.txt'],
  ]) {
    const link = models.locator(`#${id}`).getByRole('link', { name, exact: true });
    await expect(link).toBeVisible(); await expect(link).toHaveAttribute('href', href);
  }
  await models.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(models.locator('#plamo-3-translate-2b')).toHaveAttribute('data-state', 'Not downloaded');
  // Load an existing, genuinely model-free graph through the same saved library.
  await live.editor.evaluate(async () => {
    const { GRAPH_VERSION, graphNode, edge } = await import('./graph.js');
    const { saveLiveGraphData } = await import('./graph-library.js');
    await saveLiveGraphData(localStorage, { version: GRAPH_VERSION,
      nodes: [graphNode('Text', 'source', 20, 20), graphNode('Display', 'display', 420, 20)],
      edges: [edge('source', 'value', 'display', 'input1')] });
  });
  await live.editor.reload();
  await live.editor.getByRole('button', { name: 'Select source', exact: true }).click();
  await live.editor.getByLabel('source value', { exact: true }).fill('Model-free edit');
  await settleAutoSave(live.editor);
  await live.reload(); await expect(live.locator('#model-status')).toHaveText('Ready');
  expect(f.requests).toEqual([]); expect(calls).toEqual([]);
});

test('concurrent manual downloads on separate Models pages request once; denial survives retry and page recreation', async ({ graphExtension: f }) => {
  const calls = await trackPersistence(f), live = await openModelFreeGraph(f), first = live.models;
  const second = await f.context.newPage(); await second.goto(first.url());
  await Promise.all([
    button(first, 'plamo-3-translate-2b', 'Download').click(),
    button(second, 'translategemma', 'Download').click(),
  ]);
  await expect(first.locator('#plamo-3-translate-2b')).toHaveAttribute('data-state', 'Ready');
  await expect(second.locator('#translategemma')).toHaveAttribute('data-state', 'Ready');
  expect(operations(calls)).toEqual(['persisted', 'persist']);
  expect(f.requests).toHaveLength(9);
  await first.close(); await second.reload();
  await button(second, 'translategemma', 'Delete cached assets').click();
  await expect(second.locator('#translategemma')).toHaveAttribute('data-state', 'Not downloaded');
  await button(second, 'translategemma', 'Download').click();
  await expect(second.locator('#translategemma')).toHaveAttribute('data-state', 'Ready');
  expect(f.requests).toHaveLength(17);
  expect(operations(calls)).toEqual(['persisted', 'persist']);
});

test('Auto Save requests persistence only after saving a model-bearing graph; a later manual download shares the attempt', async ({ graphExtension: f }) => {
  const calls = await trackPersistence(f), live = await openModelFreeGraph(f), editor = live.editor;
  await settleAutoSave(editor); expect(calls).toEqual([]);
  await editor.evaluate(() => {
    const persist = navigator.storage.persist;
    navigator.storage.persist = async () => {
      const library = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
      window.savedBeforePersistence = library.graphs.some(entry => entry.graph.nodes.some(node => node.type === 'TranslateGemma4B'));
      return persist();
    };
  });
  await openPalette(editor); await editor.locator('#graph-node-type [data-type="TranslateGemma4B"]').click();
  await settleAutoSave(editor);
  await expectGraphModelsReady(editor);
  expect(await editor.evaluate(() => window.savedBeforePersistence)).toBe(true);
  expect(operations(calls)).toEqual(['persisted', 'persist']);
  expect(calls.every(call => call.page.includes('graph-editor.html'))).toBe(true);
  await button(live.models, 'plamo-3-translate-2b', 'Download').click();
  await expect(live.models.locator('#plamo-3-translate-2b')).toHaveAttribute('data-state', 'Ready');
  expect(operations(calls)).toEqual(['persisted', 'persist']);
  expect(f.requests).toHaveLength(9);
});
