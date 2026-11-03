import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph } from './graph-fixture.js';
import { itemGraph } from '../fixtures/item-graph.js';

test('MV3 portable ITEM graph keeps final rows visible through queued Worker replies, Cancel and restart', async ({ graphExtension: f }) => {
  await writeFile(path.join(f.root, 'web/opus-mt-en-ja-worker.js'), `const pending=[]; self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready',id:data.id});
    if(data.type==='translate')pending.push(data);
    if(data.type==='fixture-complete'){const job=pending.shift();postMessage({type:job.text==='fail'?'error':'result',id:job.id,texts:['translated:'+job.text],message:'controlled failure'});}
    if(data.type==='drain')postMessage({type:'drained',id:data.id});
  };`);
  const live = await openGraph(f), graph = itemGraph();
  await live.editor.evaluate(async graph => { const { saveGraph } = await import('./graph.js'); saveGraph(localStorage, graph); }, graph);
  await live.editor.reload(); await expect(live.editor.locator('#graph-errors')).toBeEmpty();
  await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled();
  expect(await live.editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(graph);
  await live.evaluate(async () => { const { TabSession } = await import('./session.js'); const start = TabSession.prototype.start;
    TabSession.prototype.start = function(...args) { this.prepareTranslation = async () => {}; return start.apply(this, args); };
    window.keyedReply = () => graphWorkers.findLast(worker => worker.url.endsWith('opus-mt-en-ja-worker.js') && !worker.released).postMessage({ type: 'fixture-complete' });
  });
  await startGraph(live); const rows = live.locator('[data-display="display"] tr'), cells = live.locator('[data-display="display"] td');
  await live.evaluate(() => speech.receiveEvent({ type: 'partial', id: 0, text: 'draft' })); await expect(cells).toHaveText(['draft', '']);
  await live.evaluate(() => speech.receiveEvent({ type: 'final', id: 0, text: 'same' })); await expect(cells).toHaveText(['same', '']);
  await live.evaluate(() => speech.receiveEvent({ type: 'partial', id: 1, text: 'next' })); await expect(cells).toHaveText(['same', '', 'next', '']);
  await expect.poll(() => live.evaluate(() => graphWorkers.filter(w => !w.released).flatMap(w => w.messages).filter(m => m.type === 'translate').length)).toBe(1);
  await live.evaluate(() => keyedReply()); await expect(cells).toHaveText(['same', 'translated:same', 'next', '']);
  await live.evaluate(() => { speech.receiveEvent({ type: 'final', id: 1, text: 'same' }); speech.receiveEvent({ type: 'final', id: 2, text: 'fail' }); });
  await expect(rows).toHaveCount(3);
  await expect.poll(() => live.evaluate(() => graphWorkers.filter(w => !w.released).flatMap(w => w.messages).filter(m => m.type === 'translate').length)).toBe(2);
  await live.evaluate(() => keyedReply()); await expect(cells).toHaveText(['same', 'translated:same', 'same', 'translated:same', 'fail', '']);
  await expect.poll(() => live.evaluate(() => graphWorkers.filter(w => !w.released).flatMap(w => w.messages).filter(m => m.type === 'translate').length)).toBe(3);
  await live.evaluate(() => keyedReply()); await expect(cells).toHaveText(['same', 'translated:same', 'same', 'translated:same', 'fail', '']);
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); await expect(rows).toHaveCount(3);
  await startGraph(live); await expect(rows).toHaveCount(0);
  await live.evaluate(() => speech.receiveEvent({ type: 'final', id: 0, text: 'pending' })); await expect(cells).toHaveText(['pending', '']);
  await live.locator('#cancel-session').click(); await expect(live.locator('#start')).toBeEnabled(); await expect(cells).toHaveText(['pending', '']);
  expect(await live.evaluate(() => graphWorkers.every(worker => worker.released))).toBe(true);
  await live.editor.reload(); expect(await live.editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(graph);
});

test('MV3 saved Display.view opens a reviewed legacy draft and preserves exact original and earlier recovery copies', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  const raw = await live.editor.evaluate(async () => {
    const { GRAPH_VERSION, graphNode, edge, GRAPH_KEY, GRAPH_RECOVERY_KEY } = await import('./graph.js');
    const text = graphNode('Text', 'literal'); text.settings.value = '<b>legacy</b>\nnext';
    const graph = { version: GRAPH_VERSION, nodes: [text, graphNode('ViewBuilder', 'view'), graphNode('Display', 'display')],
      edges: [edge('literal', 'value', 'view', 'input1'), edge('view', 'view', 'display', 'view')] };
    const raw = JSON.stringify(graph, null, 2);
    localStorage.setItem(GRAPH_KEY, raw); localStorage.setItem(GRAPH_RECOVERY_KEY, 'older recovery'); return raw;
  });
  await live.reload(); await live.editor.reload();
  await expect(live.locator('#start')).toBeDisabled();
  await expect(live.editor.locator('#errors')).toContainText('Display ITEM port requires review');
  await expect(live.editor.getByRole('button', { name: 'display input view', exact: true })).toBeAttached();
  expect(await live.editor.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled();
  await expect(live.editor.locator('#errors')).toBeEmpty();
  const saved = await live.editor.evaluate(() => ({ graph: JSON.parse(localStorage.getItem('processing-graph-v1')),
    old: localStorage.getItem('processing-graph-before-v14'), original: localStorage.getItem('processing-graph-before-v14-2') }));
  expect(saved.old).toBe('older recovery'); expect(saved.original).toBe(raw);
  expect(saved.graph.nodes.find(n => n.id === 'display').legacyView).toBe(true);
  const unmarked = structuredClone(saved.graph); delete unmarked.nodes.find(n => n.id === 'display').legacyView;
  expect(unmarked).toEqual(JSON.parse(raw));
  await live.reload(); await live.editor.reload();
  await expect(live.editor.locator('#errors')).toBeEmpty();
  await live.evaluate(async () => {
    const { readGraph } = await import('./graph.js'), { buildGraph } = await import('./graph-runtime.js');
    const { renderTextRegions } = await import('./live-text-regions.js');
    const graph = readGraph(localStorage), root = document.createElement('div'); root.id = 'legacy-test'; document.body.append(root);
    const { pipeline } = buildGraph(graph, { onDisplay(id, dom) { renderTextRegions(root, graph, { [id]: dom }); } });
    await pipeline.start(); await pipeline.stop(); await pipeline.dispose();
  });
  await expect(live.locator('#legacy-test .display-content')).toHaveText('<b>legacy</b>\nnext');
  await expect(live.locator('#legacy-test b')).toHaveCount(0);
});
