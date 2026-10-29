import { test, expect, openGraph, startGraph, emitFinal } from './graph-fixture.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const notes = page => page.locator('[data-display="notes"] .display-content');
const transcript = page => page.locator('[data-display="transcript"] .display-content');

async function setup(f, type, phase) {
  // Only the model Worker protocol is deterministic here. The production Node,
  // shared Pipeline, session, Live UI and Worker ownership remain unchanged.
  await writeFile(path.join(f.root, 'web/meeting-summary-worker.js'), `
    self.onmessage = ({data}) => {
      if (data.type === 'load') postMessage({id:data.id, type:${JSON.stringify(phase === 'load' ? 'error' : 'ready')}, message:'Controlled model load failure'});
      if (data.type === 'summarize') {
        if (data.text.includes('slow')) { setTimeout(() => postMessage({id:data.id,type:'result',summary:'stale notes'}),1500); return; }
        postMessage({id:data.id,type:data.text.includes('fail')?'error':'result',message:'Controlled inference failure',summary:'committed notes'});
      }
    };`);
  const page = await openGraph(f);
  await page.evaluate(async () => {
    const { Pipeline } = await import('../web/pipeline.js'); const start = Pipeline.prototype.start;
    Pipeline.prototype.start = function() { if (this.entries.has('summary')) window.modelPipeline = this; return start.call(this); };
  });
  await page.editor.evaluate(async type => {
    const { defaultGraph, graphNode, edge, saveGraph } = await import('./graph.js');
    const graph = defaultGraph();
    graph.nodes.push(graphNode(type, 'summary'), graphNode('TextToDOM', 'notes-dom'), graphNode('LiveTextDisplay', 'notes'));
    graph.edges.push(edge('speech', 'final', 'summary', 'text'), edge('summary', 'summary', 'notes-dom', 'text'), edge('notes-dom', 'dom', 'notes', 'dom'));
    saveGraph(localStorage, graph);
  }, type);
  return page;
}
const flush = page => page.evaluate(() => window.modelPipeline.entries.get('summary').node.flush());
const state = page => page.evaluate(() => ({ failed:window.modelPipeline.entries.get('summary').failed, errors:window.modelPipeline.errors.map(e=>e.message), state:window.modelPipeline.state }));

for (const type of ['MeetingSummaryLfm2', 'MeetingSummaryQwen35']) {
  for (const phase of ['load', 'inference']) test(`${type}: ${phase} failure is tracked once; transcription survives Stop and restart`, async ({ graphExtension: f }) => {
    const page = await setup(f, type, phase); await startGraph(page);
    if (phase === 'inference') {
      await emitFinal(page, 'first'); await flush(page); await expect(notes(page)).toHaveText('committed notes');
      await emitFinal(page, 'fail'); await flush(page);
    }
    await expect(page.locator('#summary-status')).toContainText(phase === 'load' ? 'Controlled model load failure' : 'Controlled inference failure');
    expect(await state(page)).toMatchObject({ failed:true, state:'running' });
    expect((await state(page)).errors).toHaveLength(1);
    await expect(page.locator('#errors')).toBeEmpty();
    await emitFinal(page, 'surviving transcript'); await expect(transcript(page)).toContainText('surviving transcript');
    await expect(page.locator('#status')).toHaveText('Transcription active');
    const saved = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
    await page.locator('#stop').click(); await expect(page.locator('#status')).toHaveText('Stopped. Outputs are ready.');
    await expect(transcript(page)).toContainText('surviving transcript');
    await expect(notes(page)).toHaveText(phase === 'load' ? '' : 'committed notes');
    expect(await page.evaluate(() => window.graphWorkers.every(w=>w.released))).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(saved);
    await startGraph(page); await emitFinal(page, 'fresh');
    if (phase === 'inference') { await flush(page); await expect(notes(page)).toHaveText('committed notes'); }
    await expect(transcript(page)).toHaveText('fresh');
    await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(() => window.graphWorkers.every(w=>w.released))).toBe(true);
  });

  test(`${type}: Cancel interrupts Stop inference and a restart rejects stale output`, async ({ graphExtension: f }) => {
    const page = await setup(f, type, 'inference'); await startGraph(page);
    await emitFinal(page, 'first'); await flush(page); await expect(notes(page)).toHaveText('committed notes');
    await emitFinal(page, 'slow'); await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Finalizing');
    await page.locator('#cancel-session').click(); await expect(page.locator('#start')).toBeEnabled();
    await expect(notes(page)).toHaveText('committed notes');
    expect(await page.evaluate(() => window.graphWorkers.every(w=>w.released))).toBe(true);
    await startGraph(page); await emitFinal(page, 'fresh'); await flush(page);
    await page.waitForTimeout(1600); await expect(notes(page)).toHaveText('committed notes'); await expect(transcript(page)).toHaveText('fresh');
    await page.locator('#stop').click(); await expect(page.locator('#status')).toHaveText('Stopped. Outputs are ready.');
  });
}
