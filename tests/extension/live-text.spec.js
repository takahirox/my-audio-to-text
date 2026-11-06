import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, openGraph } from './graph-fixture.js';
import { installLiveScrollFixture, checkLiveScrolling, checkLiveTextFlowScrolling } from '../fixtures/live-scroll.js';
const region = (page, id) => page.locator(`[data-display="${id}"]`);

test('MV3 summary TEXT snapshots render literally through Display.input, drain Stop and retain committed output during pagehide cancellation', async ({ graphExtension: f }) => {
  await writeFile(path.join(f.root,'web/text-summary-worker.js'), `self.onmessage=({data})=>{
    if(data.type==='load')postMessage({type:'ready',id:data.id});
    if(data.type==='summarize')setTimeout(()=>postMessage({type:'result',id:data.id,summary:data.text}),data.text==='slow'?1500:10);
  };`);
  const live=await openGraph(f), literal='<script>literal note</script>\nsecond line';
  await live.evaluate(async literal=>{
    const {graphNode,edge,saveGraph}=await import('./graph.js');
    const source=graphNode('Text','source');source.settings.value=literal;
    saveGraph(localStorage,{version:15,nodes:[source,graphNode('TextSummaryLfm2','summary'),graphNode('Display','notes')],
      edges:[edge('source','value','summary','text'),edge('summary', 'summary', 'notes', 'input1')]});
    window.dispatchEvent(new StorageEvent('storage',{key:'processing-graph-v1'}));
    const {TabSession}=await import('./session.js'), start=TabSession.prototype.start;
    TabSession.prototype.start=function(...args){window.summarySession=this;return start.apply(this,args);};
  },literal);
  await live.locator('#start').click();await expect(live.locator('#status')).toHaveText('Processing active');
  const content=region(live,'notes').locator('.display-content');await expect(content).toHaveText(literal);
  await expect(content.locator('script')).toHaveCount(0);
  await live.evaluate(()=>window.summarySession.session.pipeline.entries.get('source').context.emit('value','slow'));
  await expect(live.locator('#summary-status')).toContainText('summarizing text');
  await live.locator('#stop').click();await expect(live.locator('#status')).toHaveText('Finalizing graph outputs…');
  await expect(live.locator('#start')).toBeDisabled();
  await expect(live.locator('#start')).toBeEnabled();await expect(content).toHaveText('slow');
  await live.locator('#start').click();await expect(content).toHaveText(literal);
  await live.evaluate(()=>window.summarySession.session.pipeline.entries.get('source').context.emit('value','slow'));
  await expect.poll(()=>live.evaluate(()=>window.graphWorkers.some(worker=>!worker.released&&worker.messages.some(message=>message.type==='summarize'&&message.text==='slow')))).toBe(true);
  await live.evaluate(() => window.dispatchEvent(new Event('pagehide')));await expect(live.locator('#start')).toBeDisabled();await expect(content).toHaveText(literal);
  expect(await live.evaluate(()=>window.graphWorkers.every(worker=>worker.released))).toBe(true);
});


test('MV3 shared renderer keeps independent bottom-aware scroll positions with actual overflowing DOM', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await installLiveScrollFixture(live, true);
  await checkLiveScrolling(live, expect);
});

for (const rootType of ['inline', 'text', 'fragment']) {
  test(`MV3 Live layout following observes ${rootType} snapshots and preserves a scrolled-up region`, async ({ graphExtension: f }) => {
    const live = await openGraph(f);
    await installLiveScrollFixture(live, true);
    await checkLiveTextFlowScrolling(live, expect, rootType);
  });
}
