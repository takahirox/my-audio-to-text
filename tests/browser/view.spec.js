import { settleAutoSave } from '../extension/ui-controls.js';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openPalette } from '../extension/ui-controls.js';

test('portable pair accumulator and ITEM sink palette, independent editor connections, Help, save/reload and executable output', async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))),
      contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/extension/graph-editor.html');
  await page.evaluate(async () => {
    const { graphNode, GRAPH_VERSION } = await import('/extension/graph.js'); const { saveLiveGraphData } = await import('/extension/graph-library.js');
    const nodes = [graphNode('Number', 'key'), graphNode('Text', 'left', 20, 300), graphNode('Text', 'right', 20, 600)];
    nodes[0].settings.value = -2.5; nodes[1].settings.value = '<img src=x onerror=alert(1)>'; nodes[2].settings.value = 'right';
    await saveLiveGraphData(localStorage, { version: GRAPH_VERSION, nodes, edges: [] });
    localStorage.setItem('processing-graph-before-v14', 'original recovery');
  });
  await page.reload();
  for (const [type, category] of [['KeyedTextPair', 'Processors'], ['KeyedPairedTextAccumulator', 'Processors'], ['Display', 'Outputs']]) {
    await openPalette(page); await page.getByLabel('Node category', { exact: true }).selectOption(category);
    await page.getByLabel('Search nodes').fill(type);
    await page.locator(`#graph-node-type [data-type="${type}"]`).click();
    if (type === 'Display') {
      await expect(page.getByLabel('display title', { exact: true })).toHaveValue('');
      await expect(page.getByLabel('display Add input', { exact: true })).toBeEnabled();
    } else {
      await expect(page.locator('.graph-inspector')).toContainText('This Node has no configurable settings.');
      await expect(page.locator('.graph-inspector input, .graph-inspector select, .graph-inspector textarea')).toHaveCount(0);
    }
  }
  const port = name => page.getByRole('button', { name, exact: true });
  for (const [source, output, target, input] of [
    ['key', 'value', 'keyedtextpair', 'id1'], ['key', 'value', 'keyedtextpair', 'id2'],
    ['left', 'value', 'keyedtextpair', 'input1'], ['right', 'value', 'keyedtextpair', 'input2'],
    ['keyedtextpair', 'pair', 'keyedpairedtextaccumulator', 'pair'],
    ['keyedpairedtextaccumulator', 'pairs', 'display', 'input1'],
  ]) {
    await port(`${source} output ${output}`).press('Enter');
    if (source === 'key') await expect(port('keyedtextpair input input1')).toBeDisabled();
    if (source === 'keyedpairedtextaccumulator') {
      await expect(port('keyedtextpair input input1')).toBeDisabled();
      await expect(port('keyedtextpair input id1')).toBeDisabled();
      await expect(port('display input input1')).toBeEnabled();
    }
    await port(`${target} input ${input}`).press('Enter');
  }
  await port('keyedtextpair output pair').press('Enter');
  await expect(port('display input input1')).toBeEnabled();
  await expect(port('keyedpairedtextaccumulator input pair')).toBeEnabled();
  await port('keyedtextpair output pair').press('Enter');
  await port('left output value').press('Enter');
  await expect(port('display input input1')).toBeEnabled();
  await expect(port('keyedpairedtextaccumulator input pair')).toBeDisabled();
  await port('left output value').press('Enter');
  await settleAutoSave(page);
  await expect(page.locator('#graph-errors')).toBeEmpty();
  const saved = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await page.reload();
  await expect(port('keyedtextpair input id2')).toBeAttached(); await expect(port('display input input1')).toBeAttached();
  await page.locator('#graph-help').click();
  await expect(page.getByRole('dialog', { name: 'Graph Editor help' })).toContainText('Each Display is one tabbed view: its input ports are switchable tabs');
  await page.keyboard.press('Escape');
  const result = await page.evaluate(async () => {
    const { graphNode, edge, GRAPH_VERSION } = await import('/extension/graph.js'); const { readLiveGraphData } = await import('/extension/graph-library.js');
    const { buildGraph } = await import('/extension/graph-runtime.js');
    const { renderTextRegions } = await import('/extension/live-text-regions.js');
    const graph = readLiveGraphData(localStorage), root = document.createElement('div'); document.body.append(root);
    const { pipeline } = buildGraph(graph, { onDisplay(id, dom) { renderTextRegions(root, graph, { [id]: dom }); } });
    await pipeline.start(); await pipeline.stop();
    const cells = [...root.querySelectorAll('td')].map(td => td.textContent);
    const safe = root.querySelector('img') === null, errors = pipeline.errors.map(e => e.message);
    const tds = [...root.querySelectorAll('td')], widths = tds.map(td => td.getBoundingClientRect().width);
    const legible = widths[0] > 100 && Math.abs(widths[0] - widths[1]) < 2 &&
      tds.every(td => getComputedStyle(td).whiteSpace === 'pre-wrap' && td.tabIndex === 0 && td.hasAttribute('aria-label')) &&
      root.querySelector('[aria-live="polite"]') !== null;
    await pipeline.dispose();
    const plainGraph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Display', 'plain')],
      edges: [edge('text', 'value', 'plain', 'input1')] };
    plainGraph.nodes[0].settings.value = '<b>plain</b>\nnext';
    const plain = buildGraph(plainGraph, { onDisplay(id, dom) { renderTextRegions(root, plainGraph, { [id]: dom }); } });
    await plain.pipeline.start(); await plain.pipeline.stop();
    const plainText = root.querySelector('.display-content').textContent;
    const plainSafe = root.querySelector('b, table') === null;
    await plain.pipeline.dispose(); return { cells, safe, errors, legible, plainText, plainSafe };
  });
  expect(result).toEqual({ cells: ['<img src=x onerror=alert(1)>', 'right'], safe: true, errors: [], legible: true, plainText: '<b>plain</b>\nnext', plainSafe: true });
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(saved);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-before-v14'))).toBe('original recovery');
});

test('browser portable ITEM transcript flow preserves rows across delayed reverse translation, clears, Cancel and restart', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js'), { NUMBER, TEXT } = await import('/port-contracts.js');
    const { KeyedTextCoalesceNode } = await import('/keyed-text-coalesce-node.js');
    const { KeyedTextPairNode } = await import('/keyed-text-pair-node.js');
    const { DisplayNode } = await import('/display-node.js');
    const { KeyedPairedTextAccumulatorNode } = await import('/keyed-paired-text-accumulator-node.js');
    let asr, translation;
    const snapshots = [], mount = document.createElement('section'); document.body.append(mount);
    const display = new DisplayNode(dom => {
      mount.replaceChildren(dom);
      snapshots.push([...mount.querySelectorAll('tr')].map(tr => [...tr.children].map(td => td.textContent)));
    });
    const edge = (a, b, c, d) => ({ from: [a, b], to: [c, d] });
    const pipeline = new Pipeline({ nodes: {
      asr: { outputs: { finalId: NUMBER, final: TEXT, provisionalId: NUMBER, provisional: TEXT }, start(c) { asr = c; } },
      translation: { outputs: { id: NUMBER, text: TEXT }, start(c) { translation = c; } },
      coalesce: new KeyedTextCoalesceNode(), pair: new KeyedTextPairNode(), history: new KeyedPairedTextAccumulatorNode(), display,
    }, connections: [edge('asr', 'finalId', 'coalesce', 'id1'), edge('asr', 'final', 'coalesce', 'input1'),
      edge('asr', 'provisionalId', 'coalesce', 'id2'), edge('asr', 'provisional', 'coalesce', 'input2'),
      edge('coalesce', 'id', 'pair', 'id1'), edge('coalesce', 'text', 'pair', 'input1'),
      edge('translation', 'id', 'pair', 'id2'), edge('translation', 'text', 'pair', 'input2'),
      edge('pair', 'pair', 'history', 'pair'), edge('history', 'pairs', 'display', 'input1')] });
    const tick = () => new Promise(r => setTimeout(r, 0));
    await pipeline.start();
    asr.emitOutputs({ provisionalId: 1, provisional: 'draft A' }); await tick();
    asr.emitOutputs({ finalId: 1, final: '<b>A</b>', provisionalId: 1, provisional: '' }); await tick();
    asr.emitOutputs({ provisionalId: 2, provisional: 'B' }); await tick();
    translation.emitOutputs({ id: 2, text: 'translated B' }); await tick();
    translation.emitOutputs({ id: 1, text: 'translated A' }); await tick();
    translation.emitOutputs({ id: 1, text: '' }); await tick();
    translation.emitOutputs({ id: 1, text: '' }); await tick();
    asr.emitOutputs({ finalId: 1, final: '', provisionalId: 1, provisional: '' }); await tick();
    const safe = mount.querySelector('b') === null;
    await pipeline.cancel(); const count = snapshots.length;
    translation.emitOutputs({ id: 1, text: 'late' }); await tick();
    const lateRejected = snapshots.length === count;
    display.start({ signal: new AbortController().signal, connectedInputs: ['id', 'input1', 'input2'] });
    await pipeline.dispose();
    return { snapshots, safe, lateRejected, errors: pipeline.errors.map(e => e.message) };
  });
  expect(result).toEqual({ snapshots: [[], [], [['draft A', '']], [['<b>A</b>', '']],
    [['<b>A</b>', ''], ['B', '']], [['<b>A</b>', ''], ['B', 'translated B']],
    [['<b>A</b>', 'translated A'], ['B', 'translated B']], [['<b>A</b>', ''], ['B', 'translated B']],
    [['<b>A</b>', ''], ['B', 'translated B']], [['', ''], ['B', 'translated B']], []],
    safe: true, lateRejected: true, errors: [] });
});
