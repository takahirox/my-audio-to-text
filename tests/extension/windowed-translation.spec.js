import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { windowGraph, windowTranscript, closedWindows } from '../fixtures/windowed-translation.js';

test('palette exposes NUMBER threshold inputs, one TEXT output, no threshold Settings and reloads', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  for (const type of ['TextWindow', 'Number']) {
    await openPalette(editor); await editor.locator(`#graph-node-type [data-type="${type}"]`).click();
  }
  await editor.getByRole('button', { name: 'Select textwindow', exact: true }).click();
  for (const port of ['text', 'maxChars', 'maxWaitSeconds']) await expect(editor.getByRole('button', { name: `textwindow input ${port}`, exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'textwindow output text', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'textwindow output provisional', exact: true })).toHaveCount(0);
  for (const key of ['maxChars', 'maxWaitMs', 'sentenceBoundary']) await expect(editor.getByLabel(`textwindow ${key}`, { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Select number', exact: true }).click();
  await editor.getByLabel('number value', { exact: true }).fill('2000');
  await editor.getByRole('button', { name: 'number output value', exact: true }).click();
  await editor.getByRole('button', { name: 'textwindow input maxChars', exact: true }).click();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  expect(f.requests).toEqual([]);
  const graph = await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(graph.version).toBe(15); expect(graph.nodes.find(n => n.type === 'TextWindow').settings).toEqual({});
  expect(graph.edges).toContainEqual({ from: ['number', 'value'], to: ['textwindow', 'maxChars'] });
  await editor.reload(); expect(await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(graph);
});

for (const mode of ['baseline', 'window']) test(`packaged ${mode}: committed ASR TEXT routing, deterministic inference, deadline, Stop and repeat`, async ({ graphExtension: f }) => {
  // Only model inference is controlled. Real module Worker, production
  // scheduler, graph, grouping, timers, formatter/display and cleanup execute.
  await writeFile(path.join(f.root, 'web/opus-mt-en-ja-worker.js'), `
    self.onmessage = ({data}) => {
      if (data.type === 'load') postMessage({id:data.id,type:'ready'});
      if (data.type === 'drain') postMessage({id:data.id,type:'drained'});
      if (data.type === 'translate') setTimeout(()=>postMessage({id:data.id,type:'result',texts:['訳:'+data.text]}), 30);
    };`);
  const live = await openGraph(f);
  // Use the production ASR final emitter with fixture recognition/capture.
  // The translator remains a real owned module Worker with controlled results.
  const graph = windowGraph(mode, 'OpusMtEnJa');
  graph.nodes[0] = { ...graph.nodes[0], type: 'SpeechToTextReazonSpeech', settings: {} };
  graph.nodes.push({ id: 'audio', type: 'ChromeTabAudio', settings: {}, position: { x: 0, y: 0 } });
  graph.edges.forEach(e => { if (e.from[0] === 'input') e.from[1] = 'final'; });
  graph.edges.push({ from: ['audio', 'audio'], to: ['input', 'audio'] });
  const runs = await live.evaluate(async ({ graph, texts }) => {
    const { buildGraph } = await import('./graph-runtime.js');
    const { saveGraph, readGraph } = await import('./graph.js');
    saveGraph(localStorage, graph);
    const runs = [];
    for (let run = 0; run < 2; run++) {
      let display; const events = [];
      const built = buildGraph(readGraph(localStorage), { tabId: 42, prepareTranslation() {}, onDisplay: (_, s) => { display = s.textContent; events.push(s.textContent); } });
      try {
        await built.pipeline.start(); await built.translations[0].ready;
        for (const text of texts) built.speechNodes.get('input').receiveEvent({ type: 'final', text });
        await built.pipeline.stop();
        runs.push({ display, events, errors: built.pipeline.errors.map(e => e.message) });
      } finally { await built.pipeline.dispose(); }
    }
    return runs;
  }, { graph, texts: windowTranscript });
  const expected = mode === 'baseline' ? windowTranscript : closedWindows;
  for (const run of runs) {
    expect(run.errors).toEqual([]); expect(run.display).toEqual(expected.map(s => `訳:${s}`).join('\n'));
  }
  expect(await live.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});
