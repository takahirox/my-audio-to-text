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
    await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled(); await live.close(); live = await openGraph({ ...f, url: `${f.url}?error=&tab=42` });
    const migrated = await live.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
    expect(migrated.version).toBe(11);
    expect(migrated.nodes.find(node => node.id === id).type).toBe('LiveTextDisplay');
    expect(migrated.edges.filter(route => route.to[0] === id)).toEqual([{ from: [`${id}-dom`, 'dom'], to: [id, 'dom'] }]);
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
  await live.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedText=text;}}}));
  await region(live,'transcript').getByRole('button',{name:'Copy text'}).click();expect(await live.evaluate(()=>window.copiedText)).toBe('Visible result');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(region(live, 'transcript').locator('.display-content')).toHaveText('Visible result');
});

test('MV3 translation history, repeated inputs, safe labels and saved graph apply next session', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await fixtureTranslation(f, live);
  await loadTranslationFixture(live.editor); await live.editor.locator('#graph-save').click();
  await startGraph(live); await emitFinal(live, 'same'); await emitFinal(live, 'same');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(region(live, 'translated').locator('tbody tr')).toHaveCount(2);
  expect(await region(live, 'translated').locator('tbody td').allTextContents()).toEqual(['same','Translated same','same','Translated same']);
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

test('MV3 accumulator preview, empty values, duplicates, Stop/Cancel and complete DOM replacement', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await startGraph(live);
  const content = region(live, 'transcript').locator('.display-content');
  const values = ['  <img src=x onerror=alert(1)>\n& literal  ', 'same', 'same', '', ...Array.from({ length: 100 }, (_, i) => `item ${i}`)];
  for (const value of values) await emitFinal(live, value);
  await expect(content).toHaveText(values.join('\n')); await expect(live.locator('#live-displays img')).toHaveCount(0);
  for (const text of ['preview one', 'preview two', '', '<script>preview</script>']) {
    await live.evaluate(text => window.speech.receiveEvent({ type: 'partial', text }), text);
    await expect(content).toHaveText(values.join('\n') + (text ? '\n' + text : ''));
    await expect(content.locator('script,img')).toHaveCount(0);
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
    const { TextToDOMNode } = await import('../web/dom-nodes.js');
    const toDOM = text => { let dom; new TextToDOMNode().receive('text',text,{signal:new AbortController().signal,emit:(_,value)=>dom=value}); return dom; };
    const { renderTextRegions } = await import('./live-text-regions.js'), { defaultGraph, graphNode } = await import('./graph.js');
    const root = document.createElement('div'), graph = defaultGraph(); document.body.append(root);
    const render = text => renderTextRegions(root, graph, { transcript: toDOM(text) });
    const text = () => root.querySelector('.display-content').textContent;
    render('A\nB'); render('A\nchanged'); const replacement = text(); render('A'); const shortened = text(); render(''); const empty = text();
    render('<b>literal</b>'); const safe = !root.querySelector('b');
    const unicode = 'a'.repeat(4095) + '😀' + 'b'.repeat(4095) + '🌸'; render(unicode);
    const unicodeExact = text() === unicode && [...root.querySelector('.display-content').firstChild.childNodes].every(n => !/[\uD800-\uDBFF]$/.test(n.data));
    let snapshot = ''; const start = performance.now();
    for (let i = 0; i < 2000; i++) { snapshot += 'same segment\n'; render(snapshot); }
    const elapsedMs = performance.now() - start, correct = text() === snapshot;
    const boundedNodes = root.querySelector('.display-content').childNodes.length <= Math.ceil(snapshot.length / 4096);
    const original = root.firstElementChild; graph.nodes.push(graphNode('LiveTextDisplay', 'other')); graph.nodes.reverse();
    renderTextRegions(root, graph, { transcript: toDOM('history'), other: toDOM('other') });
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
  await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled(); await live.reload();
  const graph = await live.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(graph.version).toBe(11); expect(graph.nodes.filter(n => n.type === 'TextAccumulator')).toHaveLength(1);
  expect(graph.edges).toContainEqual({ from: ['summary', 'summary'], to: ['notes-dom', 'text'] });
  expect(await live.evaluate(() => localStorage.getItem('processing-graph-before-v11'))).toBe(raw);
  await live.editor.getByText('Original saved graph (migration recovery copy)', { exact: true }).click();
  await expect(live.editor.getByLabel('Original saved graph JSON', { exact: true })).toHaveValue(raw);
  await live.editor.getByLabel('Graph recovery version').selectOption({ label: 'processing-graph-before-v9' });
  await expect(live.editor.getByLabel('Original saved graph JSON', { exact: true })).toHaveValue('older original');
});

test('MV3 migrated snapshot survives Stop/Cancel with an inactive append draft', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  const raw = await live.evaluate(async () => {
    const { graphNode, edge, GRAPH_KEY } = await import('./graph.js');
    const graph = { version: 9, nodes: [graphNode('Text', 'snapshot'), graphNode('TextFormatter', 'draft'), graphNode('LiveTextDisplay', 'view')],
      edges: [edge('snapshot', 'value', 'view', 'replace'), edge('draft', 'text', 'view', 'append')] };
    graph.nodes[0].settings.value = '  <b>literal snapshot</b>\n';
    const raw = JSON.stringify(graph); localStorage.setItem(GRAPH_KEY, raw); return raw;
  });
  await live.reload(); await live.editor.reload();
  await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled(); await live.reload();
  const saved = await live.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(saved.nodes.some(node => node.id === 'draft')).toBe(true);
  expect(saved.edges).toContainEqual({ from: ['draft', 'text'], to: ['view-accumulator', 'append'] });
  expect(await live.evaluate(() => localStorage.getItem('processing-graph-before-v11'))).toBe(raw);
  // Reload the persisted v10 migration before exercising the actual Live controls.
  await live.reload();
  const content = region(live, 'view').locator('.display-content');
  for (const button of ['stop', 'cancel-session']) {
    await live.locator('#start').click();
    await expect(live.locator('#status')).toHaveText('Processing active');
    await expect(content).toHaveText('  <b>literal snapshot</b>\n', { useInnerText: false });
    await live.locator(`#${button}`).click();
    await expect(live.locator('#start')).toBeEnabled();
    expect(await content.textContent()).toBe('  <b>literal snapshot</b>\n');
    await expect(content.locator('b')).toHaveCount(0);
    await expect(live.locator('#errors')).toBeEmpty();
  }
});

test('MV3 committed translation pairs align, hover/focus together, retain errors and reject canceled results', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await fixtureTranslation(f,live);
  for (const worker of ['opus-mt-worker.js','opus-mt-en-ja-worker.js']) await writeFile(path.join(f.root,'web',worker), `self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready',id:data.id});
    if(data.type==='translate')setTimeout(()=>postMessage(data.text==='fail'?{type:'error',id:data.id,message:'<b>offline</b>'}:{type:'result',id:data.id,texts:[data.text==='same'?'long translation\\n'.repeat(8):'Translated '+data.text]}),data.text==='slow'?1500:20);
    if(data.type==='drain')postMessage({type:'drained',id:data.id});
  };`);
  await loadTranslationFixture(live.editor); await startGraph(live);
  await emitFinal(live,'same'); await emitFinal(live,'same'); await emitFinal(live,'fail');
  await live.evaluate(()=>window.activeSession.session.pipeline.entries.get('speech').context.emit('final',''));
  const rows = region(live,'translated').locator('tbody tr'); await expect(rows).toHaveCount(4);
  expect(await rows.nth(2).locator('td').allTextContents()).toEqual(['fail','Translation failed: <b>offline</b>']);
  expect(await rows.nth(3).locator('td').allTextContents()).toEqual(['','']);
  await expect(region(live,'translated').locator('b')).toHaveCount(0);
  const aligned = await rows.nth(0).locator('td').evaluateAll(cells=>cells.map(cell=>{const r=cell.getBoundingClientRect();return {top:r.top,height:r.height};}));
  expect(aligned[0]).toEqual(aligned[1]); expect(aligned[0].height).toBeGreaterThan(100);
  for (const method of ['hover','focus']) for (const side of [0,1]) {
    await live.mouse.move(0,0); await rows.nth(0).locator('td').nth(side)[method]();
    const colors = await rows.evaluateAll(rows=>rows.map(row=>[...row.children].map(cell=>getComputedStyle(cell).backgroundColor)));
    expect(colors[0][0]).toBe(colors[0][1]); expect(colors[0][0]).not.toBe('rgba(0, 0, 0, 0)');
    expect(colors[1]).toEqual(['rgba(0, 0, 0, 0)','rgba(0, 0, 0, 0)']);
  }
  if (process.env.UPDATE_DOM_SCREENSHOT) await live.screenshot({path:'docs/evidence/graph-138-paired.png',fullPage:true});
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await startGraph(live); await emitFinal(live,'committed'); await expect(rows).toHaveCount(1);
  await emitFinal(live,'slow'); await live.locator('#cancel-session').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(rows).toHaveCount(1); expect(await live.evaluate(()=>window.graphWorkers.every(worker=>worker.released))).toBe(true);
  await startGraph(live); await expect(rows).toHaveCount(0); await emitFinal(live,'fresh');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  expect(await rows.locator('td').allTextContents()).toEqual(['fresh','Translated fresh']);
});

test('MV3 v10 TEXT display is blocked until reviewed Save; original JSON and older backups remain accessible', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  const raw = await live.evaluate(async()=>{
    const {graphNode,edge,GRAPH_KEY}=await import('./graph.js');
    const source=graphNode('Text','source');source.settings.value='<script>literal</script>\nnotes';
    const graph={version:10,nodes:[source,graphNode('LiveTextDisplay','notes'),graphNode('Text','parked')],edges:[edge('source','value','notes','content')]};
    const raw=JSON.stringify(graph,null,2);localStorage.setItem(GRAPH_KEY,raw);localStorage.setItem('processing-graph-before-v10','older recovery');return raw;
  });
  await live.reload();await live.editor.reload();
  await expect(live.locator('#start')).toBeDisabled();await expect(live.locator('#errors')).toContainText('v11 requires review');
  expect(await live.evaluate(()=>localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await live.editor.getByText('Original saved graph (migration recovery copy)',{exact:true}).click();
  await expect(live.editor.getByLabel('Original saved graph JSON',{exact:true})).toHaveValue(raw);
  await live.editor.locator('#graph-save').click();await expect(live.editor.locator('#graph-save')).toBeEnabled();
  const saved=await live.evaluate(()=>JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(saved.version).toBe(11);expect(saved.nodes.some(node=>node.id==='parked')).toBe(true);
  expect(saved.edges).toContainEqual({from:['notes-dom','dom'],to:['notes','dom']});
  expect(await live.evaluate(()=>localStorage.getItem('processing-graph-before-v11'))).toBe(raw);
  expect(await live.evaluate(()=>localStorage.getItem('processing-graph-before-v10'))).toBe('older recovery');
  await live.locator('#start').click();await expect(region(live,'notes').locator('.display-content')).toHaveText('<script>literal</script>\nnotes');
  await expect(region(live,'notes').locator('script')).toHaveCount(0);await live.locator('#stop').click();
});

test('MV3 editor adds both DOM processors, saves/reloads them and rejects direct TEXT to the DOM sink', async ({ graphExtension: f }) => {
  const live=await openGraph(f), editor=live.editor;
  for (const type of ['TextToDOM','PairedTextToDOM']) {
    await openPalette(editor);await editor.locator('#graph-node-type').selectOption(type);await editor.locator('#graph-add').click();
  }
  await editor.getByRole('button',{name:'speech output final',exact:true}).click();
  await expect(editor.getByRole('button',{name:'transcript input dom',exact:true})).toBeDisabled();
  await expect(editor.getByRole('button',{name:'transcript input content',exact:true})).toHaveCount(0);
  await editor.getByRole('button',{name:'texttodom input text',exact:true}).click();
  await editor.getByRole('button',{name:'texttodom output dom',exact:true}).click();
  await editor.getByRole('button',{name:'transcript input dom',exact:true}).click();
  await expect(editor.locator('#graph-errors')).toBeEmpty();await editor.locator('#graph-save').click();await expect(editor.locator('#graph-save')).toBeEnabled();
  await editor.reload();await expect(editor.locator('[data-node="pairedtexttodom"]')).toHaveCount(1);
  const graph=await editor.evaluate(()=>JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(graph.edges).toContainEqual({from:['texttodom','dom'],to:['transcript','dom']});
});

test('MV3 summary TEXT snapshots render literally through TextToDOM, retain committed output on Cancel and drain Stop', async ({ graphExtension: f }) => {
  await writeFile(path.join(f.root,'web/meeting-summary-worker.js'), `self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready',id:data.id});
    if(data.type==='summarize')setTimeout(()=>postMessage({type:'result',id:data.id,summary:data.text}),data.text==='slow'?1500:10);
  };`);
  const live=await openGraph(f), literal='<script>literal note</script>\nsecond line';
  await live.evaluate(async literal=>{
    const {graphNode,edge,saveGraph}=await import('./graph.js');
    const source=graphNode('Text','source');source.settings.value=literal;
    saveGraph(localStorage,{version:11,nodes:[source,graphNode('MeetingSummaryLfm2','summary'),graphNode('TextToDOM','format'),graphNode('LiveTextDisplay','notes')],
      edges:[edge('source','value','summary','text'),edge('summary','summary','format','text'),edge('format','dom','notes','dom')]});
    window.dispatchEvent(new StorageEvent('storage',{key:'processing-graph-v1'}));
    const {TabSession}=await import('./session.js'), start=TabSession.prototype.start;
    TabSession.prototype.start=function(...args){window.summarySession=this;return start.apply(this,args);};
  },literal);
  await live.locator('#start').click();await expect(live.locator('#status')).toHaveText('Processing active');
  const content=region(live,'notes').locator('.display-content');await expect(content).toBeEmpty();
  await live.evaluate(()=>window.summarySession.session.pipeline.entries.get('summary').node.flush());await expect(content).toHaveText(literal);
  await expect(content.locator('script')).toHaveCount(0);
  await live.evaluate(async()=>{
    const pipeline=window.summarySession.session.pipeline;pipeline.entries.get('source').context.emit('value','slow');
    await pipeline.entries.get('summary').queue;void pipeline.entries.get('summary').node.flush();
  });
  await live.locator('#cancel-session').click();await expect(live.locator('#start')).toBeEnabled();await expect(content).toHaveText(literal);
  expect(await live.evaluate(()=>window.graphWorkers.every(worker=>worker.released))).toBe(true);
  await live.locator('#start').click();await expect(live.locator('#status')).toHaveText('Processing active');await expect(content).toBeEmpty();
  await live.locator('#stop').click();await expect(live.locator('#start')).toBeEnabled();await expect(content).toHaveText(literal);
});
