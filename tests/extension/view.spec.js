import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph, startGraph } from './graph-fixture.js';
import { viewGraph } from '../fixtures/view-graph.js';

test('MV3 portable VIEW graph keeps final rows visible through queued Worker replies, Cancel and restart', async ({ graphExtension: f }) => {
  await writeFile(path.join(f.root, 'web/opus-mt-en-ja-worker.js'), `const pending=[]; self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready',id:data.id});
    if(data.type==='translate')pending.push(data);
    if(data.type==='fixture-complete'){const job=pending.shift();postMessage({type:job.text==='fail'?'error':'result',id:job.id,texts:['translated:'+job.text],message:'controlled failure'});}
    if(data.type==='drain')postMessage({type:'drained',id:data.id});
  };`);
  const live = await openGraph(f), graph = viewGraph();
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
