import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';

async function add(editor, type) {
  await openPalette(editor); await editor.locator('#graph-node-type').selectOption(type); await editor.locator('#graph-add').click();
}
async function save(editor) {
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
}
const card = editor => editor.locator('#graph-models .model-card');

test('palette, Save and reload preserve current connected graph and parked directions; shared verified preparation and recovery', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  for (const type of ['Text', 'TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'TextToDOM', 'LiveTextDisplay']) await add(editor, type);
  await editor.locator('#graph-help').click();
  await editor.locator('#graph-asset-notice summary').click();
  await expect(editor.locator('#graph-asset-notice p')).toBeVisible();
  await expect(editor.locator('#graph-asset-notice')).toContainText('3.112 GB');
  await expect(editor.locator('#graph-asset-notice')).toContainText('Gemma Terms');
  await editor.keyboard.press('Escape');
  for (const type of ['translategemmaenja', 'translategemmajaen']) await expect(editor.getByRole('button', { name: `${type} input context`, exact: true })).toBeVisible();
  for (const [source, output, target, input] of [['text', 'value', 'translategemmaenja', 'text'], ['text', 'value', 'translategemmaenja', 'context'], ['translategemmaenja', 'text', 'texttodom', 'text'], ['texttodom','dom','livetextdisplay','dom']]) {
    await editor.getByRole('button', { name: `${source} output ${output}`, exact: true }).press('Enter');
    await editor.getByRole('button', { name: `${target} input ${input}`, exact: true }).press('Enter');
  }
  expect(f.requests).toEqual([]); await save(editor);
  await expect(card(editor)).toHaveCount(1); await expect(card(editor).locator('.model-status')).toContainText('Ready');
  expect(f.requests).toHaveLength(8); expect(f.requests.every(r => r.startsWith('/translategemma-assets.json/'))).toBe(true);
  const graph = await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(graph.version).toBe(15); expect(graph.nodes.some(n => n.type === 'TranslateGemmaJaEn')).toBe(true);
  expect(graph.edges).toContainEqual({ from: ['translategemmaenja', 'text'], to: ['texttodom', 'text'] });
  expect(graph.edges).toContainEqual({ from: ['text', 'value'], to: ['translategemmaenja', 'context'] });
  expect(await editor.evaluate(() => window.graphWorkers.length)).toBe(0);
  await save(editor); await expect(card(editor).locator('.model-status')).toContainText('Ready'); expect(f.requests).toHaveLength(8);
  await editor.reload(); expect(await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(graph);
  await editor.evaluate(async () => {
    const { translateGemmaManifest } = await import('./translategemma-cache.js');
    const manifest = await translateGemmaManifest(), cache = await caches.open('transformers-cache');
    await cache.put(manifest.files[0].url, new Response(new Uint8Array(manifest.files[0].bytes)));
  });
  const models = live.models.locator('#translategemma');
  await models.getByRole('button', { name: 'Check cache', exact: true }).click(); await expect(models.locator('.model-status')).toHaveText('Not downloaded');
  await models.getByRole('button', { name: 'Download / retry', exact: true }).click(); await expect(models.locator('.model-status')).toContainText('Ready');
  expect(f.requests).toHaveLength(9);
});

for (const mode of ['error', 'short', 'corrupt', 'hold']) test(`Gemma Save survives ${mode}; Cancel and retry recover the same saved graph`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor; f.mode(mode);
  await add(editor, 'TranslateGemmaEnJa'); await save(editor);
  if (mode === 'hold') {
    await expect(card(editor).locator('.model-status')).toHaveText('Downloading');
    await card(editor).getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(card(editor).locator('.model-status')).toHaveText('Canceled');
  } else await expect(card(editor).locator('.model-status')).toHaveText('Error');
  const before = await editor.evaluate(() => localStorage.getItem('processing-graph-v1'));
  expect(JSON.parse(before).nodes.some(n => n.type === 'TranslateGemmaEnJa')).toBe(true);
  f.mode('normal'); await card(editor).getByRole('button', { name: 'Retry preparation', exact: true }).click();
  await expect(card(editor).locator('.model-status')).toContainText('Ready');
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(before);
});

// These tests execute the production owned module Worker, graph builder,
// scheduler, verified cache and prompt. Only hardware/model inference are fixtures.
for (const mode of ['normal', 'missing-gpu', 'no-adapter', 'inference-error', 'cancel']) test(`packaged Gemma Worker/graph: ${mode}, repeat, grouped formatter and plain fan-out`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await add(editor, 'TranslateGemmaEnJa'); await save(editor);
  await expect(card(editor).locator('.model-status')).toContainText('Ready');
  const file = path.join(f.root, 'web/translategemma-worker.js');
  const original = await readFile(file, 'utf8');
  if (mode === 'missing-gpu' || mode === 'no-adapter') await writeFile(file, original.replace('value: { requestAdapter: async () => ({}) }', `value: ${mode === 'missing-gpu' ? 'undefined' : '{ requestAdapter: async () => null }'}`));
  const before = f.requests.length;
  await f.context.setOffline(true);
  const result = await live.evaluate(async mode => {
    const { graphNode, edge } = await import('./graph.js'); const { buildGraph } = await import('./graph-runtime.js');
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('TranslateGemmaEnJa', 'gemma'),
      graphNode('TextFormatter', 'format'), graphNode('LiveTextDisplay', 'paired'), graphNode('LiveTextDisplay', 'plain')], edges: [
      edge('input', 'value', 'gemma', 'text'), edge('gemma', 'source', 'format', 'input1'), edge('gemma', 'text', 'format', 'input2'), edge('gemma', 'error', 'format', 'input3'),
      edge('format', 'text', 'paired', 'content'), edge('gemma', 'text', 'plain', 'content'),
    ] };
    graph.nodes[0].settings.value = mode === 'inference-error' ? 'fail' : mode === 'cancel' ? 'slow' : 'Hello';
    graph.nodes[2].settings.template = '{1}|{2}|{3}';
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const displays = {}, states = [], built = buildGraph(window.addDOMFormatters(graph), { onDisplay: (id, state) => { displays[id] = state.textContent; }, onTranslationState: s => states.push(s) });
      await built.pipeline.start();
      if (mode === 'cancel') {
        await built.translations[0].ready; await new Promise(r => setTimeout(r, 30));
        await built.pipeline.dispose(); await new Promise(r => setTimeout(r, 50));
      } else { await built.pipeline.stop(); await built.pipeline.dispose(); }
      runs.push({ displays, states });
    }
    return runs;
  }, mode);
  expect(f.requests).toHaveLength(before);
  for (const run of result) {
    if (mode === 'normal') { expect(run.displays.plain).toBe('Japanese: Hello'); expect(run.displays.paired).toBe('Hello|Japanese: Hello|'); }
    else if (mode === 'cancel') { expect(run.displays.plain).toBe(''); expect(run.displays.paired).toBe(''); }
    else {
      expect(run.displays.plain).toBe('');
      expect(run.displays.paired).not.toBe('');
      expect(run.displays.paired).toMatch(mode === 'missing-gpu' ? /requires WebGPU/ : mode === 'no-adapter' ? /No WebGPU adapter/ : /GPU memory failure/);
    }
  }
  expect(await live.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn']) test(`${type}: explicit context graph runs the production prompt Worker and clears to the official path`, async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await add(editor, type); await save(editor);
  await expect(card(editor).locator('.model-status')).toContainText('Ready');
  const before = f.requests.length;
  await f.context.setOffline(true);
  const result = await live.evaluate(async type => {
    const { graphNode, edge } = await import('./graph.js'); const { buildGraph } = await import('./graph-runtime.js');
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('Text', 'context'), graphNode(type, 'gemma'), graphNode('TextToDOM', 'dom'), graphNode('LiveTextDisplay', 'out')],
      edges: [edge('input', 'value', 'gemma', 'text'), edge('context', 'value', 'gemma', 'context'), edge('gemma', 'text', 'dom', 'text'), edge('dom', 'dom', 'out', 'dom')] };
    const outputs = [], built = buildGraph(graph, { onDisplay: (_, dom) => outputs.push(dom.textContent) });
    try {
      await built.pipeline.start(); await built.translations[0].ready;
      const input = built.pipeline.entries.get('input').context, context = built.pipeline.entries.get('context').context;
      context.emit('value', 'private context only'); await built.pipeline.entries.get('gemma').queue;
      const worker = window.graphWorkers.at(-1);
      const before = worker.messages.filter(m => m.type === 'translate').length;
      context.emit('value', 'first context'); input.emit('value', 'First target');
      context.emit('value', 'second context'); input.emit('value', 'Second target');
      context.emit('value', ''); input.emit('value', 'Official target');
      await built.pipeline.stop();
      return { before, outputs: outputs.filter(Boolean), messages: worker.messages.filter(m => m.type === 'translate'), errors: built.pipeline.errors.map(e => e.message) };
    } finally { await built.pipeline.dispose(); }
  }, type);
  expect(result.before).toBe(0); expect(result.errors).toEqual([]);
  expect(result.messages.map(m => m.context)).toEqual(['first context', 'second context', undefined]);
  const target = type === 'TranslateGemmaEnJa' ? 'Japanese' : 'English';
  expect(result.outputs).toEqual(['First target', 'Second target', 'Official target'].map(text => `${target}: ${text}`));
  expect(f.requests).toHaveLength(before);
  expect(await live.evaluate(() => window.graphWorkers.length === 1 && window.graphWorkers[0].released)).toBe(true);
});
