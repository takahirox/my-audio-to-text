import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph, emitFinal } from './graph-fixture.js';
import { legacyGraph } from '../fixtures/legacy-graph.js';
const region = (page, id) => page.locator(`[data-display="${id}"]`);

async function fixtureTranslation(f, page) {
  for (const worker of ['opus-mt-worker.js', 'opus-mt-en-ja-worker.js']) await writeFile(path.join(f.root, 'web', worker), `self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready',id:data.id});
    if(data.type==='translate')setTimeout(()=>postMessage({type:'result',id:data.id,texts:['Translated '+data.text]}),250);
    if(data.type==='drain')postMessage({type:'drained',id:data.id});
  };`);
  await page.evaluate(async () => {
    const { TabSession } = await import('./session.js'), start = TabSession.prototype.start;
    TabSession.prototype.start = function(...args) { window.activeSession = this; this.prepareTranslation = async () => {}; return start.apply(this, args); };
  });
}

for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
  test(`MV3 v5 migration preserves display ID ${id} and renders before and during a session`, async ({ graphExtension: f }) => {
    let live = await openGraph(f);
    const legacy = legacyGraph({ enabled: false }, 5);
    legacy.nodes.find(node => node.id === 'transcript').id = id;
    for (const route of legacy.edges) if (route.to[0] === 'transcript') route.to[0] = id;
    await live.evaluate(graph => localStorage.setItem('processing-graph-v1', JSON.stringify(graph)), legacy);
    await live.close(); live = await openGraph({ ...f, url: `${f.url}?error=&tab=42` });
    const migrated = await live.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
    expect(migrated.version).toBe(6);
    expect(migrated.nodes.find(node => node.id === id).type).toBe('LiveTextDisplay');
    expect(migrated.edges.filter(route => route.to[0] === id)).toEqual([
      { from: ['speech', 'provisional'], to: [id, 'replace'] },
      { from: ['speech', 'final'], to: [id, 'append'] },
    ]);
    await expect(live.locator('.live-text-region')).toHaveCount(1);
    await expect(region(live, id).locator('h2')).toHaveText('Original');
    await expect(region(live, id).locator('.display-preview')).toBeEmpty();
    await expect(region(live, id).locator('li')).toHaveCount(0);
    await expect(live.locator('#errors')).toBeEmpty();
    await expect(live.locator('#start')).toBeEnabled();
    await live.locator('#start').click();
    await expect(live.locator('#status')).toHaveText('Transcription active');
    await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'pending' }));
    await expect(region(live, id).locator('.display-preview')).toHaveText('pending');
    await emitFinal(live, 'committed');
    await expect(region(live, id).locator('li pre')).toHaveText(['committed']);
    await expect(region(live, id).locator('.display-preview')).toBeEmpty();
    await live.locator('#stop').click();
    await expect(live.locator('#start')).toBeEnabled();
    await expect(live.locator('#errors')).toBeEmpty();
  });
}

test('MV3 generic regions show ASR, translation and formatter TEXT with custom labels, escaping and independent updates', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await fixtureTranslation(f, live);
  await live.evaluate(async () => {
    const { defaultGraph, graphNode, edge, saveGraph, GRAPH_KEY } = await import('./graph.js');
    const graph = defaultGraph({ enabled: true }); graph.nodes = graph.nodes.filter(n => n.id !== 'translated-format');
    graph.edges = graph.edges.filter(e => e.to[0] !== 'translated-format' && e.from[0] !== 'translated-format');
    graph.nodes.find(n => n.id === 'transcript').settings.label = 'Raw <img src=x onerror=alert(1)>';
    graph.nodes.find(n => n.id === 'translated').settings.label = 'Custom translation';
    const formatter = graphNode('TextFormatter', 'format'); formatter.settings.template = 'First: {1}\nSecond: {2}\nMissing: {4}\n{{literal}}';
    const formatted = graphNode('LiveTextDisplay', 'formatted'); formatted.settings.label = 'Corrected / formatted';
    const mirror = graphNode('LiveTextDisplay', 'mirror'); mirror.settings.label = 'Independent mirror';
    graph.nodes.push(formatter, formatted, mirror);
    graph.edges.push(edge('translation', 'provisional', 'translated', 'replace'), edge('translation', 'text', 'translated', 'append'), edge('speech', 'final', 'format', 'input1'), edge('translation', 'text', 'format', 'input2'), edge('format', 'text', 'formatted', 'append'), edge('speech', 'final', 'mirror', 'replace'));
    saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
  });
  await live.editor.reload(); await startGraph(live);
  await expect(live.locator('.display-label')).toHaveText(['Raw <img src=x onerror=alert(1)>', 'Custom translation', 'Corrected / formatted', 'Independent mirror']);
  await expect(live.locator('#live-displays img')).toHaveCount(0);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: '<b>preview</b>' }));
  await expect(region(live, 'transcript').locator('.display-preview')).toHaveText('<b>preview</b>'); await expect(live.locator('#live-displays b')).toHaveCount(0);
  await emitFinal(live, '<script>value</script>');
  await expect(region(live, 'formatted').locator('li pre').first()).toHaveText('First: <script>value</script>\nSecond: \nMissing: \n{literal}');
  await expect(region(live, 'translated').locator('li pre')).toHaveText(['Translated <script>value</script>']);
  await expect(region(live, 'formatted').locator('li pre')).toHaveText(['First: <script>value</script>\nSecond: \nMissing: \n{literal}', 'First: <script>value</script>\nSecond: Translated <script>value</script>\nMissing: \n{literal}']);
  await expect(live.locator('#live-displays script')).toHaveCount(0);
  await expect(region(live, 'transcript').locator('.display-preview')).toBeEmpty(); await expect(region(live, 'mirror').locator('.display-preview')).toHaveText('<script>value</script>');
  await emitFinal(live, '<script>value</script>'); await expect(region(live, 'transcript').locator('li')).toHaveCount(2); await expect(region(live, 'translated').locator('li')).toHaveCount(2);
  const workers = await live.evaluate(() => window.graphWorkers.length);
  await live.editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
  await live.editor.getByLabel('transcript label', { exact: true }).fill('New saved label'); await live.editor.getByLabel('transcript label', { exact: true }).blur();
  await live.editor.locator('#graph-save').click(); await expect(live.locator('#saved-state')).toContainText('keeps its active graph');
  await expect(region(live, 'transcript').locator('h2')).toHaveText('Raw <img src=x onerror=alert(1)>'); expect(await live.evaluate(() => window.graphWorkers.length)).toBe(workers);
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); await expect(region(live, 'transcript').locator('li')).toHaveCount(2);
  await startGraph(live); await expect(region(live, 'transcript').locator('h2')).toHaveText('New saved label'); await expect(live.locator('.display-items li')).toHaveCount(0);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'pending' })); await expect(region(live, 'transcript').locator('.display-preview')).toHaveText('pending');
  await live.locator('#cancel-session').click(); await expect(region(live, 'transcript').locator('.display-preview')).toBeEmpty();
  expect(await live.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

test('MV3 formatter directly grouped primitive inputs emit one snapshot; independent updates emit immediately', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await fixtureTranslation(f, live);
  await live.editor.locator('#translation-enabled').uncheck(); await live.editor.locator('#graph-save').click(); await startGraph(live);
  await live.evaluate(async () => {
    const { Pipeline } = await import('../web/pipeline.js'), { TEXT } = await import('../web/port-contracts.js');
    const { TextFormatterNode, LiveTextDisplayNode } = await import('../web/text-nodes.js');
    const { edge } = await import('./graph.js'); let grouped, separate;
    const pipeline = new Pipeline({ nodes: {
      producer: { outputs: { a: TEXT, b: TEXT }, start(c) { grouped = c.emitOutputs; } },
      other: { outputs: { text: TEXT }, start(c) { separate = c.emit; } },
      formatter: new TextFormatterNode({ template: '{1}|{2}|{3}' }),
      display: new LiveTextDisplayNode(state => { window.activeSession.update({ displays: { ...window.activeSession.view.displays, transcript: state } }); }),
    }, connections: [edge('producer', 'a', 'formatter', 'input1'), edge('producer', 'b', 'formatter', 'input2'), edge('other', 'text', 'formatter', 'input3'), edge('formatter', 'text', 'display', 'append')] });
    await pipeline.start(); grouped({ a: 'A', b: 'B' }); window.independentText = text => separate('text', text); window.textPipeline = pipeline;
  });
  await expect(region(live, 'transcript').locator('li pre')).toHaveText(['A|B|']);
  await live.evaluate(() => window.independentText('<em>C</em>')); await expect(region(live, 'transcript').locator('li pre')).toHaveText(['A|B|', 'A|B|<em>C</em>']);
  await expect(live.locator('#live-displays em')).toHaveCount(0); await live.evaluate(async () => { await window.textPipeline.stop(); await window.textPipeline.dispose(); }); await live.locator('#cancel-session').click();
});

test('MV3 output-only TTS graph has no implicit Live text regions and drains its audio sink', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await live.evaluate(async () => {
    const { defaultGraph, graphNode, edge, saveGraph, GRAPH_KEY } = await import('./graph.js');
    const graph = defaultGraph({ enabled: false }); graph.nodes = graph.nodes.filter(n => n.id !== 'transcript'); graph.edges = graph.edges.filter(e => e.to[0] !== 'transcript');
    graph.nodes.push(graphNode('Kokoro', 'tts'), graphNode('AudioOutput', 'player'), graphNode('FocusedInputTextOutputNode', 'field'));
    graph.edges.push(edge('speech', 'final', 'tts', 'text'), edge('tts', 'audio', 'player', 'audio'), edge('speech', 'final', 'field', 'text'));
    saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
  });
  await live.editor.reload(); await expect(live.editor.locator('#graph-errors')).toBeEmpty();
  await live.models.locator('#kokoro button:has-text("Download / retry")').click(); await expect(live.models.locator('#kokoro .model-status')).toContainText('Ready');
  await startGraph(live); await expect(live.locator('.live-text-region')).toHaveCount(0);
  await expect(live.locator('#target-status')).toContainText('output skipped'); await expect(live.locator('#target-status')).not.toContainText('No text destination');
  await emitFinal(live, 'audio only'); await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(live.locator('#audio-outputs audio')).toHaveCount(1); await expect(live.locator('.live-text-region')).toHaveCount(0);
  await startGraph(live); await expect(live.locator('#audio-outputs audio')).toHaveCount(0); await live.locator('#cancel-session').click();
  expect(await live.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

test('MV3 append retains committed state, DOM selection and reader scroll through preview updates and new finals', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await live.setViewportSize({ width: 900, height: 650 });
  await startGraph(live);
  const values = ['  <img src=x onerror=alert(1)>\n& literal  ', 'same', 'same', '', ...Array.from({ length: 30 }, (_, i) => `item ${i}`)];
  for (const value of values) await emitFinal(live, value);
  const committed = region(live, 'transcript').locator('li pre');
  await expect(committed).toHaveCount(values.length);
  expect(await committed.allTextContents()).toEqual(values);
  await expect(live.locator('#live-displays img')).toHaveCount(0);
  await live.evaluate(() => {
    const region = document.querySelector('[data-display="transcript"]');
    window.committedElements = [...region.querySelectorAll('li')];
    const text = window.committedElements[10].querySelector('pre').firstChild;
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, text.length);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    window.readerSelection = getSelection().toString();
    window.scrollTo(0, window.committedElements[10].getBoundingClientRect().top + window.scrollY - 100);
    window.readerScroll = window.scrollY;
  });
  for (const text of ['preview one', 'preview two', '', '<script>preview</script>']) {
    await live.evaluate(text => window.speech.receiveEvent({ type: 'partial', text }), text);
    await expect(region(live, 'transcript').locator('.display-preview')).toHaveText(text);
    expect(await committed.allTextContents()).toEqual(values);
    expect(await live.evaluate(() => {
      const current = [...document.querySelector('[data-display="transcript"]').querySelectorAll('li')];
      return current.every((item, i) => item === window.committedElements[i]) &&
        getSelection().toString() === window.readerSelection && window.scrollY === window.readerScroll;
    })).toBe(true);
  }
  await emitFinal(live, 'new final'); values.push('new final');
  await expect(committed).toHaveCount(values.length); expect(await committed.allTextContents()).toEqual(values);
  await expect(region(live, 'transcript').locator('.display-preview')).toBeEmpty();
  expect(await live.evaluate(() => {
    const current = document.querySelector('[data-display="transcript"]').querySelectorAll('li');
    return window.committedElements.every((item, i) => item === current[i]) &&
      getSelection().toString() === window.readerSelection && window.scrollY === window.readerScroll;
  })).toBe(true);
  // A repeated worker final ID is suppressed upstream, not a replacement in the sink.
  await live.evaluate(() => {
    window.speech.receiveEvent({ type: 'final', text: 'identified', id: 7 });
    window.speech.receiveEvent({ type: 'final', text: 'suppressed by source', id: 7 });
  });
  values.push('identified'); await expect(committed).toHaveCount(values.length);
  expect(await committed.allTextContents()).toEqual(values);
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'uncommitted at Stop' }));
  await expect(region(live, 'transcript').locator('.display-preview')).toHaveText('uncommitted at Stop');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  expect(await committed.allTextContents()).toEqual(values); await expect(region(live, 'transcript').locator('.display-preview')).toBeEmpty();
  await startGraph(live); await expect(committed).toHaveCount(0);
  await emitFinal(live, 'new session'); await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'uncommitted at Cancel' }));
  await expect(region(live, 'transcript').locator('.display-preview')).toHaveText('uncommitted at Cancel');
  await live.locator('#cancel-session').click(); await expect(live.locator('#start')).toBeEnabled();
  expect(await committed.allTextContents()).toEqual(['new session']); await expect(region(live, 'transcript').locator('.display-preview')).toBeEmpty();
  await startGraph(live); await expect(committed).toHaveCount(0); await live.locator('#cancel-session').click();
});

test('MV3 renderer reconciles replaced/shortened histories, missing state and changed graph sinks without stale entries', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  const result = await live.evaluate(async () => {
    const { renderTextRegions } = await import('./live-text-regions.js');
    const { defaultGraph, graphNode } = await import('./graph.js');
    const root = document.createElement('div'), graph = defaultGraph(); document.body.append(root);
    const render = (items, preview = '') => renderTextRegions(root, graph, { transcript: { items, preview } });
    const texts = () => [...root.querySelectorAll('li pre')].map(node => node.textContent);
    render(['A', 'same', 'same', '']); const first = root.querySelector('li'), preview = root.querySelector('.display-preview');
    render(['A', 'changed', 'same']);
    const replacement = texts(), retained = first === root.querySelector('li');
    render(['A']); const shortened = texts();
    render([], ''); const reset = texts(); render(['<b>literal</b>', '', '']);
    const arbitrary = texts(), noHtml = !root.querySelector('b');
    render(['<b>literal</b>', '', '']); const previewRetained = preview === root.querySelector('.display-preview');
    const oldRegion = root.firstElementChild;
    graph.nodes.push(graphNode('LiveTextDisplay', 'other')); graph.nodes.reverse();
    renderTextRegions(root, graph, { transcript: { items: ['history'], preview: 'current' }, other: { items: ['other'], preview: '' } });
    const reordered = [...root.children].map(node => node.dataset.display);
    const regionRetained = root.lastElementChild === oldRegion;
    graph.nodes = graph.nodes.filter(node => node.id !== 'transcript'); renderTextRegions(root, graph, {});
    const removed = !oldRegion.isConnected, missing = texts();
    graph.nodes.push(graphNode('LiveTextDisplay', 'transcript')); renderTextRegions(root, graph, {});
    const recreatedEmpty = texts(), regionRecreated = root.lastElementChild !== oldRegion;
    root.remove();
    return { replacement, retained, shortened, reset, arbitrary, noHtml, previewRetained, reordered, regionRetained, removed, missing, recreatedEmpty, regionRecreated };
  });
  expect(result).toEqual({ replacement: ['A', 'changed', 'same'], retained: true, shortened: ['A'], reset: [], arbitrary: ['<b>literal</b>', '', ''], noHtml: true, previewRetained: true, reordered: ['other', 'transcript'], regionRetained: true, removed: true, missing: [], recreatedEmpty: [], regionRecreated: true });
});

test('MV3 palette translation can be added and run; custom saved graph survives reload and profile restart unchanged', async ({ graphExtension: f }) => {
  let live = await openGraph(f); await fixtureTranslation(f, live);
  const editor = live.editor;
  for (const type of ['OpusMtEnJa', 'LiveTextDisplay']) {
    await editor.locator('#graph-node-type').selectOption(type); await editor.locator('#graph-add').click();
  }
  for (const [source, output, target, input] of [['speech', 'final', 'opusmtenja', 'text'], ['opusmtenja', 'text', 'livetextdisplay', 'append']]) {
    await editor.getByRole('button', { name: `${source} output ${output}`, exact: true }).click();
    await editor.getByRole('button', { name: `${target} input ${input}`, exact: true }).click();
  }
  await editor.getByRole('button', { name: 'Select livetextdisplay', exact: true }).click();
  await editor.getByLabel('livetextdisplay label', { exact: true }).fill('My translation');
  await editor.getByLabel('livetextdisplay label', { exact: true }).blur();
  await expect(editor.locator('#graph-errors')).toBeEmpty(); await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await startGraph(live); await emitFinal(live, 'manual');
  await expect(region(live, 'livetextdisplay').locator('li pre')).toHaveText(['Translated manual']);
  await emitFinal(live, 'manual'); await expect(region(live, 'livetextdisplay').locator('li pre')).toHaveText(['Translated manual', 'Translated manual']);
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  const raw = await live.evaluate(() => {
    localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: 'ja-en' }));
    return localStorage.getItem('processing-graph-v1');
  });
  await live.reload(); await editor.reload();
  expect(await live.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await editor.getByRole('button', { name: 'Select livetextdisplay', exact: true }).click();
  await expect(editor.getByLabel('livetextdisplay label', { exact: true })).toHaveValue('My translation');
  await f.restart(); live = await openGraph(f);
  expect(await live.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await expect(live.locator('.display-label')).toHaveText(['Text', 'My translation']);
  await expect(live.locator('li')).toHaveCount(0);
});
