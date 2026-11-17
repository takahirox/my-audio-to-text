import { test, expect, openGraph } from './graph-fixture.js';
import { expectGraphModelsReady, settleAutoSave, openPalette } from './ui-controls.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

test('one searchable PLaMo AI card, optional TEXT ports, no language Settings, saved reload and model terms', async ({ graphExtension: f }) => {
  const { editor, models } = await openGraph(f, { live: false });
  await openPalette(editor);
  await editor.getByLabel('Search nodes', { exact: true }).fill('PLaMo');
  const option = editor.locator('#graph-node-type [data-type="Plamo3Translate2B"]');
  await expect(editor.locator('#graph-node-type [role="option"]')).toHaveCount(1);
  await expect(option).toContainText('Translation · JA ↔ EN'); await expect(option).toContainText('PLaMo 3 Translate 2B');
  await option.click();
  const node = editor.locator('[data-node="plamo3translate2b"]');
  await expect(node.locator('.graph-ai-icon')).toHaveCount(1);
  for (const port of ['source_lang', 'target_lang']) await expect(editor.getByRole('button', { name: `plamo3translate2b input ${port}`, exact: true })).toBeVisible();
  await expect(editor.locator('.graph-inspector select')).toHaveCount(0);
  await settleAutoSave(editor); await expectGraphModelsReady(editor);
  const before = await editor.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await editor.reload(); await expect(node).toBeVisible();
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
  await models.evaluate(() => window.dispatchEvent(new Event('focus')));
  const card = models.locator('#plamo-3-translate-2b'); await expect(card).toHaveAttribute('data-state', 'Ready');
  await expect(card.locator(':scope > .model-license')).toContainText('prior PFN registration');
  await card.locator('summary').click();
  await expect(card.getByRole('link', { name: /PLaMo Community License/ })).toHaveAttribute('href', '../web/licenses/plamo-community-en.txt');
  await expect(card).toContainText('6 GB'); expect(f.requests).toHaveLength(1);
});

test('packaged PLaMo graph/Worker uses verified cache, both languages, source/error routing and Stop/Cancel', async ({ graphExtension: f }) => {
  const live = await openGraph(f, { live: false });
  const folder = path.join(f.root, 'web/vendor/plamo'); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'wllama.js'), `export class Wllama {
    async loadModel(blobs, options) { if (blobs[0].size !== 8192 || options.n_gpu_layers !== 0) throw Error('Wrong verified assets'); }
    async createCompletion({prompt}) {
      if (prompt.includes('fail')) throw Error('Controlled inference failure');
      return {choices:[{text:prompt.includes('output<|plamo:key|>lang<|plamo:val|>ja')?'日本語':'English',finish_reason:'stop'}]};
    }
  }`);
  const result = await live.evaluate(async () => {
    const { graphNode, edge } = await import('./graph.js'), { buildGraph } = await import('./graph-runtime.js');
    const { prepareGraphModelAssets } = await import('./graph-model-preparation.js');
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('Text', 'language'), graphNode('Plamo3Translate2B', 'plamo'),
      graphNode('Display', 'out'), graphNode('Display', 'error')], edges: [edge('input', 'value', 'plamo', 'text'),
      edge('language', 'value', 'plamo', 'target_lang'), edge('plamo', 'text', 'out', 'input1'), edge('plamo', 'error', 'error', 'input1')] };
    await prepareGraphModelAssets(graph);
    const display = {};
    const built = buildGraph(graph, { onDisplay: (id, fragment) => { display[id] = fragment.textContent; } }), scheduler = built.translations[0]; await built.pipeline.start(); await scheduler.ready;
    const input = built.pipeline.entries.get('input').context, language = built.pipeline.entries.get('language').context;
    const wait = () => new Promise(resolve => setTimeout(resolve, 50));
    language.emit('value', 'ja'); input.emit('value', 'Hello'); await wait(); await scheduler.working;
    const japanese = display.out;
    language.emit('value', 'en'); input.emit('value', 'こんにちは'); await wait(); await scheduler.working;
    const english = display.out;
    language.emit('value', 'xx'); input.emit('value', 'bad'); await wait(); await scheduler.working;
    const error = display.error;
    language.emit('value', 'en'); input.emit('value', 'fail'); await built.pipeline.stop();
    const inferenceError = display.error;
    await built.pipeline.dispose();
    return { japanese, english, error, inferenceError, disposed: scheduler.disposed };
  });
  expect(result).toEqual({ japanese: '日本語', english: 'English', error: expect.stringContaining('target_lang'),
    inferenceError: expect.stringContaining('Controlled inference failure'), disposed: true });
  expect(f.requests).toHaveLength(1);
});
