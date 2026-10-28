import { openPalette, loadTranslationFixture } from './ui-controls.js';
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
    expect(migrated.version).toBe(10);
    expect(migrated.nodes.find(node => node.id === id).type).toBe('LiveTextDisplay');
    expect(migrated.edges.filter(route => route.to[0] === id)).toEqual([{ from: [`${id}-accumulator`, 'text'], to: [id, 'content'] }]);
    await expect(live.locator('.live-text-region')).toHaveCount(1);
    await expect(region(live, id).locator('h2')).toHaveText('Original');
    await expect(region(live, id).locator('.display-content')).toBeEmpty();
    await expect(live.locator('#errors')).toBeEmpty();
    await expect(live.locator('#start')).toBeEnabled();
    await live.locator('#start').click();
    await expect(live.locator('#status')).toHaveText('Transcription active');
    await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'pending' }));
    await expect(region(live, id).locator('.display-content')).toHaveText('pending');
    await emitFinal(live, 'committed');
    await expect(region(live, id).locator('.display-content')).toHaveText('committed');
    await live.locator('#stop').click();
    await expect(live.locator('#start')).toBeEnabled();
    await expect(live.locator('#errors')).toBeEmpty();
  });
}

test('MV3 literal snapshot content, accessible controls and errors', async ({ graphExtension: f }) => {
  const live = await openGraph({ ...f, url: `${f.url}?error=Capture%20denied.&tab=42` });
  await expect(live.getByRole('alert')).toHaveText('Capture denied.');
  await expect(live.locator('footer')).toHaveCount(0);
  await expect(region(live, 'transcript').locator('.display-content')).toHaveAttribute('aria-live', 'polite');
  await expect(region(live, 'transcript').getByRole('button', { name: 'Copy text' })).toBeDisabled();
  await startGraph(live); await emitFinal(live, 'Visible result');
  await expect(region(live, 'transcript').locator('.display-content')).toHaveText('Visible result');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(region(live, 'transcript').locator('.display-content')).toHaveText('Visible result');
});

test('MV3 translation history, repeated inputs, safe labels and saved graph apply next session', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await fixtureTranslation(f, live);
  await loadTranslationFixture(live.editor); await live.editor.locator('#graph-save').click();
  await startGraph(live); await emitFinal(live, 'same'); await emitFinal(live, 'same');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(region(live, 'translated').locator('.display-content')).toHaveText('Japanese: same\nEnglish: Translated same\nJapanese: same\nEnglish: Translated same');
  await startGraph(live);
  const workers = await live.evaluate(() => window.graphWorkers.length);
  await live.editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
  await live.editor.getByLabel('transcript label', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await live.editor.getByLabel('transcript label', { exact: true }).blur(); await live.editor.locator('#graph-save').click();
  await expect(region(live, 'transcript').locator('h2')).toHaveText('Original');
  expect(await live.evaluate(() => window.graphWorkers.length)).toBe(workers);
  await live.locator('#cancel-session').click(); await startGraph(live);
  await expect(region(live, 'transcript').locator('h2')).toHaveText('<img src=x onerror=alert(1)>'); await expect(live.locator('#live-displays img')).toHaveCount(0);
  await live.locator('#cancel-session').click(); expect(await live.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
});

test('MV3 accumulator preview, empty values, duplicates, Stop/Cancel and long prefix selection/scroll', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await startGraph(live);
  const content = region(live, 'transcript').locator('.display-content');
  const values = ['  <img src=x onerror=alert(1)>\n& literal  ', 'same', 'same', '', ...Array.from({ length: 100 }, (_, i) => `item ${i}`)];
  for (const value of values) await emitFinal(live, value);
  await expect(content).toHaveText(values.join('\n')); await expect(live.locator('#live-displays img')).toHaveCount(0);
  await content.evaluate(root => {
    window.prefixNode = root.firstChild;
    const range = document.createRange(); range.setStart(root.firstChild, 5); range.setEnd(root.firstChild, 15);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    window.readerSelection = getSelection().toString(); root.scrollTop = 100; window.readerScroll = root.scrollTop;
  });
  for (const text of ['preview one', 'preview two', '', '<script>preview</script>']) {
    await live.evaluate(text => window.speech.receiveEvent({ type: 'partial', text }), text);
    await expect(content).toHaveText(values.join('\n') + (text ? '\n' + text : ''));
    expect(await content.evaluate(root => root.firstChild === window.prefixNode && getSelection().toString() === window.readerSelection && root.scrollTop === window.readerScroll)).toBe(true);
  }
  await emitFinal(live, 'new final'); values.push('new final'); await expect(content).toHaveText(values.join('\n'));
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'uncommitted' }));
  await expect(content).toContainText('uncommitted'); await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(content).toHaveText(values.join('\n'));
  await startGraph(live); await expect(content).toBeEmpty(); await emitFinal(live, 'new session');
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'discard' })); await expect(content).toContainText('discard');
  await live.locator('#cancel-session').click(); await expect(content).toHaveText('new session');
});

test('MV3 pure renderer handles replacement, shortening, empty snapshots, graph reorder and long append sequence', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  const result = await live.evaluate(async () => {
    const { renderTextRegions } = await import('./live-text-regions.js'), { defaultGraph, graphNode } = await import('./graph.js');
    const root = document.createElement('div'), graph = defaultGraph(); document.body.append(root);
    const render = text => renderTextRegions(root, graph, { transcript: text });
    const text = () => root.querySelector('.display-content').textContent;
    render('A\nB'); render('A\nchanged'); const replacement = text(); render('A'); const shortened = text(); render(''); const empty = text();
    render('<b>literal</b>'); const safe = !root.querySelector('b');
    const unicode = 'a'.repeat(4095) + '😀' + 'b'.repeat(4095) + '🌸'; render(unicode);
    const unicodeExact = text() === unicode && [...root.querySelector('.display-content').childNodes].every(n => !/[\uD800-\uDBFF]$/.test(n.data));
    let snapshot = ''; const start = performance.now();
    for (let i = 0; i < 2000; i++) { snapshot += 'same segment\n'; render(snapshot); }
    const elapsedMs = performance.now() - start, correct = text() === snapshot;
    const boundedNodes = root.querySelector('.display-content').childNodes.length <= Math.ceil(snapshot.length / 4096);
    const original = root.firstElementChild; graph.nodes.push(graphNode('LiveTextDisplay', 'other')); graph.nodes.reverse();
    renderTextRegions(root, graph, { transcript: 'history', other: 'other' });
    const order = [...root.children].map(n => n.dataset.display), retained = original === root.lastElementChild;
    graph.nodes = graph.nodes.filter(n => n.id !== 'transcript'); renderTextRegions(root, graph, {});
    const removed = !original.isConnected, missing = text(); root.remove();
    return { replacement, shortened, empty, safe, unicodeExact, correct, boundedNodes, order, retained, removed, missing, elapsedMs };
  });
  expect({ ...result, elapsedMs: 0 }).toEqual({ replacement: 'A\nchanged', shortened: 'A', empty: '', safe: true, unicodeExact: true, correct: true, boundedNodes: true, order: ['other', 'transcript'], retained: true, removed: true, missing: '', elapsedMs: 0 });
  console.log(`2,000 render updates / 26,000 characters: ${result.elapsedMs.toFixed(1)} ms (DOM mutation, excludes forced layout)`);
});

test('MV3 accumulator can be added, saved, reloaded and retained through profile restart', async ({ graphExtension: f }) => {
  let live = await openGraph(f); await openPalette(live.editor);
  await live.editor.locator('#graph-node-type').selectOption('TextAccumulator'); await live.editor.locator('#graph-add').click();
  await live.editor.locator('#graph-save').click();
  await expect.poll(() => live.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.some(n => n.id === 'textaccumulator'))).toBe(true);
  const raw = await live.evaluate(() => localStorage.getItem('processing-graph-v1'));
  expect(JSON.parse(raw).nodes.some(n => n.id === 'textaccumulator' && n.type === 'TextAccumulator')).toBe(true);
  await live.editor.reload(); await expect(live.editor.locator('[data-node="textaccumulator"]')).toHaveCount(1);
  await f.restart(); live = await openGraph(f); expect(await live.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
});

test('MV3 v9 migration retains recovery versions and replace-only summary drafts', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  const raw = await live.evaluate(async () => {
    const { graphNode, edge, GRAPH_KEY } = await import('./graph.js');
    const graph = { version: 9, nodes: [graphNode('Text', 'source'), graphNode('LiveTextDisplay', 'history'), graphNode('MeetingSummaryLfm2', 'summary'), graphNode('LiveTextDisplay', 'notes')],
      edges: [edge('source', 'value', 'history', 'append'), edge('summary', 'summary', 'notes', 'replace')] };
    const raw = JSON.stringify(graph, null, 2); localStorage.setItem('processing-graph-before-v9', 'older original'); localStorage.setItem(GRAPH_KEY, raw); return raw;
  });
  await live.reload(); await live.editor.reload();
  const graph = await live.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(graph.version).toBe(10); expect(graph.nodes.filter(n => n.type === 'TextAccumulator')).toHaveLength(1);
  expect(graph.edges).toContainEqual({ from: ['summary', 'summary'], to: ['notes', 'content'] });
  expect(await live.evaluate(() => localStorage.getItem('processing-graph-before-v10'))).toBe(raw);
  await live.editor.getByText('Original saved graph (migration recovery copy)', { exact: true }).click();
  await expect(live.editor.getByLabel('Original saved graph JSON', { exact: true })).toHaveValue(raw);
  await live.editor.getByLabel('Graph recovery version').selectOption({ label: 'processing-graph-before-v9' });
  await expect(live.editor.getByLabel('Original saved graph JSON', { exact: true })).toHaveValue('older original');
});
