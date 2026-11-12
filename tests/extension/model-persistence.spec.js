import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette, settleAutoSave } from './ui-controls.js';

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
  const calls = await trackPersistence(f), live = await openGraph(f), models = live.models;
  await expect(models.locator('.model-card')).toHaveCount(12);
  await expect(models.locator('#persist, #persistence, main > details')).toHaveCount(0);
  await expect(models.getByText('Storage and cache management', { exact: true })).toHaveCount(0);
  for (const [name, href] of [
    ['TTS terms and notices', '../web/licenses/tts-notices.txt'],
    ['Matching eSpeak NG source / build bundle (GPL-3.0-or-later)', '../web/tts-assets/phonemizer-source.tar.gz'],
    ['Google Gemma Terms, Prohibited Use Policy and attribution', '../web/licenses/gemma-notices.txt'],
  ]) {
    const link = models.getByRole('link', { name, exact: true });
    await expect(link).toBeVisible(); await expect(link).toHaveAttribute('href', href);
  }
  await expect(models.locator('#supertonic3 .model-license')).toContainText('OpenRAIL-M');
  await expect(models.locator('#kokoro .model-license')).toContainText('Apache-2.0');
  await expect(models.locator('#opus-ja-en')).toHaveAttribute('data-state', 'Not downloaded');
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
  const calls = await trackPersistence(f), live = await openGraph(f), first = live.models;
  const second = await f.context.newPage(); await second.goto(first.url());
  await Promise.all([
    button(first, 'opus-ja-en', 'Download / retry').click(),
    button(second, 'opus-en-ja', 'Download / retry').click(),
  ]);
  await expect(first.locator('#opus-ja-en')).toHaveAttribute('data-state', 'Ready');
  await expect(second.locator('#opus-en-ja')).toHaveAttribute('data-state', 'Ready');
  expect(operations(calls)).toEqual(['persisted', 'persist']);
  expect(f.requests).toHaveLength(14);
  await first.close(); await second.reload();
  await button(second, 'opus-en-ja', 'Delete cached assets').click();
  await expect(second.locator('#opus-en-ja')).toHaveAttribute('data-state', 'Not downloaded');
  await button(second, 'opus-en-ja', 'Download / retry').click();
  await expect(second.locator('#opus-en-ja')).toHaveAttribute('data-state', 'Ready');
  expect(f.requests).toHaveLength(21);
  expect(operations(calls)).toEqual(['persisted', 'persist']);
});

test('Auto Save requests persistence only after saving a model-bearing graph; a later manual download shares the attempt', async ({ graphExtension: f }) => {
  const calls = await trackPersistence(f), live = await openGraph(f), editor = live.editor;
  await settleAutoSave(editor); expect(calls).toEqual([]);
  await editor.evaluate(() => {
    const persist = navigator.storage.persist;
    navigator.storage.persist = async () => {
      const library = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
      window.savedBeforePersistence = library.graphs.some(entry => entry.graph.nodes.some(node => node.type === 'OpusMtEnJa'));
      return persist();
    };
  });
  await openPalette(editor); await editor.locator('#graph-node-type [data-type="OpusMtEnJa"]').click();
  await settleAutoSave(editor);
  await expect(editor.locator('#graph-models .model-status')).toContainText('Ready');
  expect(await editor.evaluate(() => window.savedBeforePersistence)).toBe(true);
  expect(operations(calls)).toEqual(['persisted', 'persist']);
  expect(calls.every(call => call.page.includes('graph-editor.html'))).toBe(true);
  await button(live.models, 'opus-ja-en', 'Download / retry').click();
  await expect(live.models.locator('#opus-ja-en')).toHaveAttribute('data-state', 'Ready');
  expect(operations(calls)).toEqual(['persisted', 'persist']);
  expect(f.requests).toHaveLength(14);
});
