import { settleAutoSave } from '../extension/ui-controls.js';
import { expect } from '@playwright/test';
import { assertRoutingGeometry } from './graph-routing.js';

const asrTypes = ['SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn', 'SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'];
const translatorTypes = ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa'];
const keyedInputs = ['input1', 'id1', 'input2', 'id2'];
const translationOutputs = ['text', 'id', 'source', 'error', 'provisionalText', 'provisionalId', 'provisionalSource', 'provisionalError'];
const port = (page, id, side, name) => page.getByRole('button', { name: `${id} ${side} ${name}`, exact: true });

export async function loadPortOrderGraph(page) {
  const graph = await page.evaluate(async () => {
    const { defaultGraph, graphNode, edge, ASR_TYPES } = await import(new URL('./graph.js', location.href)); const { saveLiveGraphData } = await import(new URL('./graph-library.js', location.href));
    const graph = defaultGraph({ enabled: true });
    graph.nodes.find(n => n.id === 'audio').position.x = 0;
    graph.nodes.find(n => n.id === 'speech').position.x = 320;
    graph.nodes.find(n => n.id === 'translation').position.y = 650;
    graph.nodes.push(graphNode('KeyedTextPair', 'preview-pair', 960, 650));
    graph.edges.push(edge('translation', 'provisionalText', 'preview-pair', 'input1'), edge('translation', 'provisionalId', 'preview-pair', 'id1'),
      edge('speech', 'provisional', 'translation', 'provisional'), edge('speech', 'provisionalId', 'translation', 'provisionalId'));
    const types = [...ASR_TYPES, 'OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa', 'Display', 'TextFormatter'];
    graph.nodes.push(...types.map((type, i) => graphNode(type, `extra-${type}`, 30 + i % 4 * 360, 1450 + Math.floor(i / 4) * 950)));
    for (const node of graph.nodes) if (node.id.startsWith('extra-') && ['Display', 'TextFormatter'].includes(node.type)) node.settings.inputCount = 12;
    await saveLiveGraphData(localStorage, graph); return graph;
  });
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(graph.edges.length);
  return graph;
}

export async function checkPortOrderAndHelp(page, tabKey = 'Tab') {
  const graph = await loadPortOrderGraph(page);
  const expected = node => {
    if (asrTypes.includes(node.type)) return { output: ['final', 'finalId', ...(['SpeechToTextWhisper', 'SpeechToTextParakeetV3'].includes(node.type) ? [] : ['provisional', 'provisionalId'])] };
    if (translatorTypes.includes(node.type)) return { input: ['text', 'id', 'provisional', 'provisionalId', ...(node.type.startsWith('TranslateGemma') ? ['context'] : [])], output: translationOutputs };
    if (['KeyedTextCoalesce', 'KeyedTextPair'].includes(node.type)) return { input: keyedInputs, output: node.type === 'KeyedTextCoalesce' ? ['text', 'id'] : ['pair'] };
    if (['Display', 'TextFormatter'].includes(node.type)) return { input: Array.from({ length: node.settings.inputCount }, (_, i) => `input${i + 1}`) };
    return {};
  };
  for (const node of graph.nodes) {
    const card = page.locator(`[data-node="${node.id}"]`);
    for (const [side, names] of Object.entries(expected(node))) {
      const buttons = card.locator(`[data-side="${side}"]`);
      expect(await buttons.evaluateAll(els => els.map(el => el.dataset.port))).toEqual(names);
      const rows = await buttons.evaluateAll(els => els.map(el => el.getBoundingClientRect().top));
      expect(rows.every((y, i) => !i || y > rows[i - 1])).toBe(true);
      // Actual native tab navigation follows the rendered rows, including every
      // dynamic input beyond input9. No positive tabindex/CSS reordering.
      await buttons.first().focus();
      for (let i = 0; i < names.length; i++) {
        await expect(port(page, node.id, side, names[i])).toBeFocused();
        await expect(port(page, node.id, side, names[i])).toBeEnabled();
        if (i + 1 < names.length) await page.keyboard.press(tabKey);
      }
    }
    await page.getByRole('button', { name: `Select ${node.id}`, exact: true }).press('Enter');
    const help = page.locator('.graph-inspector details');
    await help.locator('summary').click();
    for (const [side, names] of Object.entries(expected(node))) {
      const prefix = side === 'input' ? 'Input' : 'Output';
      expect(await help.locator('p.muted').allTextContents().then(rows => rows.filter(row => row.startsWith(`${prefix} `)).map(row => row.split(':')[0].slice(prefix.length + 1)))).toEqual(names);
    }
  }
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(graph);
  await expect(page.locator('#graph-state')).toHaveText('Saved');
}

// Count intersections of straight segments between measured row centers within
// each forward source/target corridor. Endpoint inversions force a crossing (or
// a router detour); this isolates the port-order cause from unrelated routes.
export async function measurePortCrossings(page) {
  return page.evaluate(async () => {
    const { nodeDefinition } = await import(new URL('./graph.js', location.href));
    const graph = (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })();
    const corridors = [['speech', 'coalesce'], ['coalesce', 'pair'], ['translation', 'pair'], ['translation', 'preview-pair']];
    return corridors.map(([source, target]) => {
      const routes = graph.edges.filter(e => e.from[0] === source && e.to[0] === target);
      const row = (id, side, name, legacy) => {
        const buttons = [...document.querySelectorAll(`[data-node="${id}"] [data-side="${side}"]`)];
        const definition = nodeDefinition(graph.nodes.find(n => n.id === id), graph);
        const index = legacy ? Object.keys(definition[`${side}s`]).indexOf(name) : buttons.findIndex(b => b.dataset.port === name);
        const r = buttons[index].getBoundingClientRect(); return r.top + r.height / 2;
      };
      const count = legacy => {
        let crossings = 0;
        for (let i = 0; i < routes.length; i++) for (let j = i + 1; j < routes.length; j++) {
          const a = routes[i], b = routes[j];
          if ((row(source, 'output', a.from[1], legacy) - row(source, 'output', b.from[1], legacy)) *
              (row(target, 'input', a.to[1], legacy) - row(target, 'input', b.to[1], legacy)) < 0) crossings++;
        }
        return crossings;
      };
      return { source, target, edges: routes.length, before: count(true), after: count(false) };
    });
  });
}

export async function checkPortGeometryAndInteractions(page) {
  const graph = await loadPortOrderGraph(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  const measurements = [];
  for (const zoom of ['0.25', '0.5', '1', '1.5']) {
    await page.locator('#graph-zoom').selectOption(zoom);
    await assertRoutingGeometry(page);
    const corridors = await measurePortCrossings(page);
    expect(corridors.map(c => [c.before, c.after])).toEqual([[6, 0], [0, 0], [1, 0], [1, 0]]);
    measurements.push({ zoom: Number(zoom), corridors });
    expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(graph);
  }
  await page.locator('#graph-zoom').selectOption('0.5');
  // Keyboard selection, output toggling and reconnection keep exact port names.
  await port(page, 'speech', 'output', 'final').press('Enter');
  await expect(port(page, 'speech', 'output', 'final')).toHaveAttribute('aria-pressed', 'true');
  await port(page, 'speech', 'output', 'final').press('Enter');
  await expect(port(page, 'speech', 'output', 'final')).toHaveAttribute('aria-pressed', 'false');
  await port(page, 'speech', 'output', 'provisional').press('Enter');
  await port(page, 'coalesce', 'input', 'input1').press('Enter');
  await expect(port(page, 'coalesce', 'input', 'input1')).toBeFocused();
  await assertRoutingGeometry(page);
  await port(page, 'speech', 'output', 'final').dragTo(port(page, 'coalesce', 'input', 'input1'));
  await expect(page.getByRole('button', { name: 'Select connection speech.final to coalesce.input1', exact: true })).toHaveCount(1);
  // Isolate native HTML DnD from the following pointer-capture gesture:
  // macOS WebKit can retain its native drag session after the synthetic drop.
  // The restored endpoints equal the saved fixture; reload also verifies that.
  await page.reload();
  await assertRoutingGeometry(page);
  // Move an occupied input to another row, then restore through native DnD.
  const input = port(page, 'pair', 'input', 'input1'), target = port(page, 'pair', 'input', 'input2');
  await input.dragTo(target);
  await expect(input).not.toHaveClass(/connected-input/); await expect(target).toHaveClass(/connected-input/);
  await assertRoutingGeometry(page);
  await port(page, 'coalesce', 'output', 'text').press('Enter'); await input.press('Enter');
  await port(page, 'translation', 'output', 'text').press('Enter'); await target.press('Enter');
  await expect(page.getByRole('button', { name: 'Select connection translation.text to pair.input2', exact: true })).toHaveCount(1);
  await assertRoutingGeometry(page);
  const wire = page.getByRole('button', { name: 'Select connection coalesce.id to pair.id1', exact: true });
  await wire.press('Enter'); await expect(wire).toBeFocused();
  await page.getByRole('button', { name: 'Disconnect coalesce.id to pair.id1', exact: true }).click();
  await port(page, 'coalesce', 'output', 'id').press('Enter'); await port(page, 'pair', 'input', 'id1').press('Enter');
  await assertRoutingGeometry(page);
  // Dynamic rows redraw and remeasure without losing earlier named endpoints.
  for (const type of ['Display', 'TextFormatter']) {
    const id = `extra-${type}`;
    await page.getByRole('button', { name: `Select ${id}`, exact: true }).press('Enter');
    await page.getByRole('button', { name: `${id} Add input`, exact: true }).click();
    await expect(port(page, id, 'input', 'input13')).toBeEnabled();
    await port(page, 'speech', 'output', 'final').press('Enter'); await port(page, id, 'input', 'input13').press('Enter');
    await expect(port(page, id, 'input', 'input13')).toBeFocused(); await assertRoutingGeometry(page);
    await expect(page.getByRole('button', { name: `Select ${id}`, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: `${id} Remove last input`, exact: true }).click();
    await expect(port(page, id, 'input', 'input13')).toHaveCount(0); await assertRoutingGeometry(page);
  }
  await settleAutoSave(page);
  const saved = await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
  // Gesture order can change the edge array, but never its named connections.
  expect(saved.nodes).toEqual(graph.nodes); expect(saved.version).toBe(graph.version);
  expect(saved.edges.map(e => JSON.stringify(e)).sort()).toEqual(graph.edges.map(e => JSON.stringify(e)).sort());
  await page.reload(); await assertRoutingGeometry(page);
  return measurements;
}
