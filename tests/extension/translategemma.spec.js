import { expectGraphModelsReady, settleAutoSave } from './ui-controls.js';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';

async function add(editor, type) {
  await openPalette(editor); await editor.locator(`#graph-node-type [data-type="${type}"]`).click();
}
async function save(editor) {
  await settleAutoSave(editor);
}

test('layout Auto Saves preserve cached Gemma/Moonshine, Ready and running Live across storage events', async ({ graphExtension: f }) => {
  // Count real shared-cache hash scans as well as the Window-facing calls.
  // The fixture uses tiny verified bytes and controlled inference, never weights.
  await appendFile(path.join(f.root, 'extension/model-asset-worker.js'), `
    let fixtureScans = 0;
    const fixtureScan = ModelAssetCache.prototype.scan;
    ModelAssetCache.prototype.scan = function(...args) { fixtureScans++; return fixtureScan.apply(this, args); };
    self.addEventListener('connect', ({ ports: [port] }) => {
      port.addEventListener('message', ({ data }) => {
        if (data.type !== 'fixture-scans') return;
        port.postMessage({ scans: fixtureScans }); port.close();
      });
    });
  `);
  const host = await openGraph(f, { live: false }), editor = host.editor;
  await editor.evaluate(async () => {
    const { graphNode, edge, GRAPH_VERSION } = await import('./graph.js');
    const graph = { version: GRAPH_VERSION,
      nodes: [graphNode('ChromeTabAudio', 'audio', 20, 20), graphNode('SpeechToTextMoonshineMediumEn', 'speech', 320, 20),
        graphNode('TranslateGemma4B', 'translation', 620, 20), graphNode('Display', 'display', 920, 20)],
      edges: [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'final', 'translation', 'text'), edge('translation', 'text', 'display', 'input1')] };
    await (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph);
  });
  await editor.reload();
  await host.models.locator('#translategemma').getByRole('button', { name: /^(Download|Retry)$/, exact: true }).click();
  await host.models.locator('#moonshine-medium-en').getByRole('button', { name: /^(Download|Retry)$/, exact: true }).click();
  await expectGraphModelsReady(editor);
  const live = await f.context.newPage(); await live.goto(f.url + '?tab=42');
  await expect(live.locator('#model-status')).toHaveText('Ready');
  await live.evaluate(async () => {
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function() {};
    ExtensionTabAudioNode.prototype.stop = function() {};
    const { TabSession } = await import('./session.js');
    const setGraph = TabSession.prototype.setGraph;
    TabSession.prototype.setGraph = function(...args) {
      window.layoutSession = this;
      window.layoutOwner ||= this.prepared || this.session;
      return setGraph.apply(this, args);
    };
  });
  const viewer = await f.context.newPage(); await viewer.goto(editor.url());
  await expect(viewer.locator('#graph-state')).toHaveText('Read-only');
  await expectGraphModelsReady(viewer);
  for (const page of [editor, viewer, live]) await page.evaluate(async () => {
    window.layoutChecks = { inspect: 0, prepare: 0, replace: 0, prepareModels: 0 };
    const { ModelAssetCache } = await import('./model-asset-cache.js');
    const { GraphModelPreparation } = await import('./graph-model-preparation.js');
    const { TabSession } = await import('./session.js');
    for (const [prototype, methods] of [[ModelAssetCache.prototype, ['inspect', 'prepare']],
      [GraphModelPreparation.prototype, ['replace']], [TabSession.prototype, ['prepareModels']]]) {
      for (const name of methods) {
        const method = prototype[name];
        prototype[name] = function(...args) { layoutChecks[name]++; return method.apply(this, args); };
      }
    }
  });
  await live.evaluate(() => window.dispatchEvent(new Event('focus')));
  const scans = () => editor.evaluate(() => new Promise(resolve => {
    const worker = new SharedWorker(new URL('./model-asset-worker.js', location.href), { type: 'module', name: 'model-assets' });
    worker.port.onmessage = ({ data }) => { worker.port.close(); resolve(data.scans); };
    worker.port.postMessage({ type: 'fixture-scans' });
  }));
  const entry = () => editor.evaluate(() => {
    const library = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
    return library.graphs.find(entry => entry.id === library.assignments.live);
  });
  const baseline = await scans(), downloads = f.requests.length, original = await entry();
  const assertCheap = async () => {
    expect(await scans()).toBe(baseline); expect(f.requests).toHaveLength(downloads);
    for (const page of [editor, viewer, live]) expect(await page.evaluate(() => layoutChecks)).toEqual({ inspect: 0, prepare: 0, replace: 0, prepareModels: 0 });
    expect(await live.evaluate(() => graphWorkers.length === 2 && graphWorkers.every(worker => !worker.released))).toBe(true);
    expect(await live.evaluate(() => (layoutSession.prepared || layoutSession.session) === layoutOwner)).toBe(true);
    await expect(live.locator('#saved-state')).toBeEmpty();
    await expect(editor.locator('.graph-state-notice')).toBeHidden();
  };
  const savePosition = async action => {
    const previous = await entry(); await action(); await save(editor);
    await expect.poll(async () => (await entry()).revision).not.toBe(previous.revision);
    const saved = await entry();
    expect(saved.graph.edges).toEqual(original.graph.edges);
    expect(saved.graph.nodes.map(({ position, ...node }) => node)).toEqual(original.graph.nodes.map(({ position, ...node }) => node));
    await expect(viewer.locator('[data-node=audio]')).toHaveCSS('left', `${saved.graph.nodes[0].position.x}px`);
    await expect.poll(() => live.evaluate(() => layoutSession.graph.nodes[0].position)).toEqual(saved.graph.nodes[0].position);
    await assertCheap();
  };
  const heading = editor.getByRole('button', { name: 'Select audio', exact: true });
  await savePosition(async () => {
    const box = await heading.boundingBox();
    await editor.mouse.move(box.x + 15, box.y + 15); await editor.mouse.down();
    await editor.mouse.move(box.x + 65, box.y + 45, { steps: 8 }); await editor.mouse.up();
  });
  await expect(live.locator('#model-status')).toHaveText('Ready'); await expect(live.locator('#start')).toBeEnabled();
  await savePosition(() => heading.press('ArrowRight'));
  await savePosition(() => editor.locator('#graph-undo').click());
  await savePosition(() => editor.locator('#graph-redo').click());
  const savedRevision = (await entry()).revision;
  await heading.click(); await editor.locator('#graph-zoom-in').click();
  await editor.locator('.graph-scroll').evaluate(element => { element.scrollLeft += 20; });
  expect((await entry()).revision).toBe(savedRevision); await assertCheap();
  await live.locator('#start').click(); await expect(live.locator('#session-state')).toHaveText('Recording');
  await savePosition(() => heading.press('ArrowDown'));
  await expect(editor.locator('.graph-activity')).toBeVisible();
  await expect(live.locator('#session-state')).toHaveText('Recording');
  await live.evaluate(() => graphWorkers.find(worker => /moonshine-medium-worker/.test(worker.url)).postMessage({ type: 'fixture-final', id: 'first', text: 'Hello' }));
  await expect(live.locator('#live-displays')).toContainText('English: Hello');
  await assertCheap();
  // A real connection edit must still warn, while keeping the started snapshot.
  await editor.getByRole('button', { name: 'speech output provisional', exact: true }).press('Enter');
  await editor.getByRole('button', { name: 'translation input text', exact: true }).press('Enter');
  await save(editor);
  await expect(live.locator('#saved-state')).toContainText('changes apply on Start');
  await expect(editor.locator('.graph-state-notice')).toContainText('earlier graph');
  expect(await live.evaluate(() => layoutSession.session === layoutOwner)).toBe(true);
  expect(await editor.evaluate(() => layoutChecks.replace)).toBe(0);
  await live.locator('#stop').click(); await expect(live.locator('#model-status')).toHaveText('Ready');
  await live.locator('#start').click(); await expect(live.locator('#session-state')).toHaveText('Recording');
  await expect(live.locator('#saved-state')).toBeEmpty();
  await expect(editor.locator('.graph-state-notice')).toBeHidden();
  expect(await live.evaluate(() => layoutSession.session.description.edges.some(edge => edge.from[1] === 'provisional'))).toBe(true);
  expect((await entry()).graph.nodes[0].position).not.toEqual(original.graph.nodes[0].position);
});

test('palette, Save and reload preserve current connected graph and optional language ports; shared verified preparation and recovery', async ({ graphExtension: f }) => {
  const live = await openGraph(f, { live: false }), editor = live.editor;
  for (const type of ['Text', 'TranslateGemma4B', 'Display']) await add(editor, type);
  const modelsLink = editor.getByRole('navigation').getByRole('link', { name: 'Models', exact: true });
  const opened = f.context.waitForEvent('page'); await modelsLink.click();
  const modelsPage = await opened;
  await expect(modelsPage.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  await expect(modelsPage.locator('#translategemma')).toContainText('3.112 GB');
  await modelsPage.locator('#translategemma summary').click();
  const terms = modelsPage.locator('#translategemma').getByRole('link', { name: 'License / terms for TranslateGemma 4B', exact: true });
  await expect(terms).toBeVisible();
  await expect(terms).toHaveAttribute('href', '../web/licenses/gemma-notices.txt');
  await terms.click(); await expect(modelsPage.locator('body')).toContainText('Gemma Terms of Use');
  await modelsPage.close();
  for (const type of ['translategemma4b']) await expect(editor.getByRole('button', { name: `${type} input context`, exact: true })).toBeVisible();
  for (const [source, output, target, input] of [['text', 'value', 'translategemma4b', 'text'], ['text', 'value', 'translategemma4b', 'context'], ['translategemma4b', 'text', 'display', 'input1']]) {
    await editor.getByRole('button', { name: `${source} output ${output}`, exact: true }).press('Enter');
    await editor.getByRole('button', { name: `${target} input ${input}`, exact: true }).press('Enter');
  }
  await save(editor);
  await expectGraphModelsReady(editor);
  expect(f.requests).toHaveLength(8); expect(f.requests.every(r => r.startsWith('/translategemma-assets.json/'))).toBe(true);
  const graph = await editor.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
  expect(graph.version).toBe(15); expect(graph.nodes.some(n => n.type === 'TranslateGemma4B')).toBe(true);
  expect(graph.edges).toContainEqual({ from: ['translategemma4b', 'text'], to: ['display', 'input1'] });
  expect(graph.edges).toContainEqual({ from: ['text', 'value'], to: ['translategemma4b', 'context'] });
  expect(await editor.evaluate(() => window.graphWorkers.length)).toBe(0);
  await save(editor); await expectGraphModelsReady(editor); expect(f.requests).toHaveLength(8);
  await editor.reload(); expect(await editor.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(graph);
  await editor.evaluate(async () => {
    const { translateGemmaManifest } = await import('./translategemma-cache.js');
    const manifest = await translateGemmaManifest(), cache = await caches.open('transformers-cache');
    await cache.put(manifest.files[0].url, new Response(new Uint8Array(manifest.files[0].bytes)));
  });
  const models = live.models.locator('#translategemma');
  await live.models.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(models.locator('.model-status')).toHaveText('Not downloaded');
  await models.getByRole('button', { name: /^(Download|Retry)$/, exact: true }).click(); await expect(models.locator('.model-status')).toContainText('Ready');
  expect(f.requests).toHaveLength(9);
});

for (const mode of ['error', 'short', 'corrupt', 'hold']) test(`Gemma Save survives ${mode}; Models recovers the same saved graph`, async ({ graphExtension: f }) => {
  const live = await openGraph(f, { live: false }), editor = live.editor; f.mode(mode);
  await add(editor, 'TranslateGemma4B'); await save(editor);
  if (mode === 'hold') {
    await expect.poll(() => f.requests.length).toBeGreaterThan(0);
    await editor.reload();
  } else await expect(editor.locator('#graph-model-warning')).toContainText('model preparation unavailable');
  const before = await editor.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  expect(JSON.parse(before).graphs.find(entry => entry.id === new URL(editor.url()).searchParams.get('id')).graph.nodes.some(n => n.type === 'TranslateGemma4B')).toBe(true);
  f.mode('normal');
  await expect(live.models.locator('#translategemma')).toHaveAttribute('data-state', 'Not downloaded');
  await live.models.locator('#translategemma').getByRole('button', { name: /^(Download|Retry)$/, exact: true }).click();
  await expectGraphModelsReady(editor);
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
});

// These tests execute the production owned module Worker, graph builder,
// scheduler, verified cache and prompt. Only hardware/model inference are fixtures.
for (const mode of ['normal', 'missing-gpu', 'no-adapter', 'inference-error', 'cancel']) test(`packaged Gemma Worker/graph: ${mode}, repeat, grouped formatter and plain fan-out`, async ({ graphExtension: f }) => {
  const live = await openGraph(f, { live: false }), editor = live.editor;
  await add(editor, 'TranslateGemma4B'); await save(editor);
  await expectGraphModelsReady(editor);
  const file = path.join(f.root, 'web/translategemma-worker.js');
  const original = await readFile(file, 'utf8');
  if (mode === 'missing-gpu' || mode === 'no-adapter') await writeFile(file, original.replace('value: { requestAdapter: async () => ({}) }', `value: ${mode === 'missing-gpu' ? 'undefined' : '{ requestAdapter: async () => null }'}`));
  const before = f.requests.length;
  await f.context.setOffline(true);
  const result = await live.evaluate(async mode => {
    const { graphNode, edge } = await import('./graph.js'); const { buildGraph } = await import('./graph-runtime.js');
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('TranslateGemma4B', 'gemma'),
      graphNode('TextFormatter', 'format'), graphNode('Display', 'paired'), graphNode('Display', 'plain')], edges: [
      edge('input', 'value', 'gemma', 'text'), edge('gemma', 'source', 'format', 'input1'), edge('gemma', 'text', 'format', 'input2'), edge('gemma', 'error', 'format', 'input3'),
      edge('format', 'text', 'paired', 'input1'), edge('gemma', 'text', 'plain', 'input1'),
    ] };
    graph.nodes[0].settings.value = mode === 'inference-error' ? 'fail' : mode === 'cancel' ? 'slow' : 'Hello';
    graph.nodes[2].settings.template = '{1}|{2}|{3}';
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const displays = {}, states = [], built = buildGraph((graph), { onDisplay: (id, state) => { displays[id] = state.textContent; }, onTranslationState: s => states.push(s) });
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
    if (mode === 'normal') { expect(run.displays.plain).toBe('English: Hello'); expect(run.displays.paired).toBe('Hello|English: Hello|'); }
    else if (mode === 'cancel') { expect(run.displays.plain).toBe(''); expect(run.displays.paired).toBe(''); }
    else {
      expect(run.displays.plain).toBe('');
      expect(run.displays.paired).not.toBe('');
      expect(run.displays.paired).toMatch(mode === 'missing-gpu' ? /requires WebGPU/ : mode === 'no-adapter' ? /No WebGPU adapter/ : /GPU memory failure/);
    }
  }
  expect(await live.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

for (const type of ['TranslateGemma4B']) test(`${type}: explicit context graph runs the production prompt Worker and clears to the official path`, async ({ graphExtension: f }) => {
  const live = await openGraph(f, { live: false }), editor = live.editor;
  await add(editor, type); await save(editor);
  await expectGraphModelsReady(editor);
  const before = f.requests.length;
  await f.context.setOffline(true);
  const result = await live.evaluate(async type => {
    const { graphNode, edge } = await import('./graph.js'); const { buildGraph } = await import('./graph-runtime.js');
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('Text', 'context'), graphNode(type, 'gemma'), graphNode('Display', 'out')],
      edges: [edge('input', 'value', 'gemma', 'text'), edge('context', 'value', 'gemma', 'context'), edge('gemma', 'text', 'out', 'input1')] };
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
  const target = 'English';
  expect(result.outputs).toEqual(['First target', 'Second target', 'Official target'].map(text => `${target}: ${text}`));
  expect(f.requests).toHaveLength(before);
  expect(await live.evaluate(() => window.graphWorkers.length === 1 && window.graphWorkers[0].released)).toBe(true);
});

test('one cached Worker switches ja/en/fr/de while jobs keep their accepted context and language snapshots', async ({ graphExtension: f }) => {
  const live = await openGraph(f, { live: false }), editor = live.editor;
  await add(editor, 'TranslateGemma4B'); await save(editor); await expectGraphModelsReady(editor);
  const before = f.requests.length;
  await f.context.setOffline(true);
  const result = await live.evaluate(async () => {
    const { graphNode, edge } = await import('./graph.js'); const { buildGraph } = await import('./graph-runtime.js');
    const graph = { version: 15, nodes: ['input','context','source','target'].map(id => graphNode('Text', id)), edges: [] };
    graph.nodes[2].settings.value = 'ja'; graph.nodes[3].settings.value = 'en';
    graph.nodes.push(graphNode('TranslateGemma4B', 'gemma'), graphNode('Display', 'out'));
    for (const [id, port] of [['input','text'], ['context','context'], ['source','source_lang'], ['target','target_lang']]) graph.edges.push(edge(id,'value','gemma',port));
    graph.edges.push(edge('gemma','text','out','input1'));
    const outputs = [], built = buildGraph(graph, { onDisplay: (_, dom) => { if (dom.textContent) outputs.push(dom.textContent); } });
    try {
      await built.pipeline.start(); await built.translations[0].ready;
      const send = (id,value) => built.pipeline.entries.get(id).context.emit('value',value);
      send('source','en'); send('target','ja'); send('context','English reference');
      await built.pipeline.entries.get('gemma').queue;
      const worker = window.graphWorkers.at(-1);
      const beforeText = worker.messages.filter(m => m.type === 'translate').length;
      send('input','Hello');
      send('source','ja'); send('target','en'); send('context','Japanese reference'); send('input','こんにちは');
      send('source','fr'); send('target','de'); send('context',''); send('input','Bonjour');
      send('target','en'); send('context','future reference');
      await built.pipeline.stop();
      return { beforeText, outputs, messages: worker.messages, errors: built.pipeline.errors.map(e => e.message) };
    } finally { await built.pipeline.dispose(); }
  });
  expect(result.errors).toEqual([]); expect(result.beforeText).toBe(0);
  expect(result.outputs).toEqual(['Japanese: Hello','English: こんにちは','German: Bonjour']);
  expect(result.messages.filter(m => m.type === 'load')).toHaveLength(1);
  expect(result.messages.filter(m => m.type === 'translate').map(m => [m.source_lang,m.target_lang,m.context])).toEqual([
    ['en','ja','English reference'], ['ja','en','Japanese reference'], ['fr','de',undefined],
  ]);
  expect(f.requests).toHaveLength(before);
  expect(await live.evaluate(() => window.graphWorkers.length === 1 && window.graphWorkers[0].released)).toBe(true);
});
