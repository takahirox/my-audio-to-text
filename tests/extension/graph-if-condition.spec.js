import { expectPreparedIdle } from './live-lifecycle.js';
import { test, expect, openGraph, startGraph, emitFinal, conditionAssets, seedConditionGraph } from './if-condition-fixture.js';
import { openPalette } from './ui-controls.js';
const items=(page,id)=>page.locator(`[data-display="${id}"] .display-content`);
const card=editor=>editor.locator('#graph-models .model-card').filter({hasText:'IfCondition'});
const save=async editor=>{await editor.locator('#graph-save').click();await expect(editor.locator('#graph-save')).toBeEnabled();};
const trackPipeline=page=>page.evaluate(async()=>{
 const {Pipeline}=await import('../web/pipeline.js'),start=Pipeline.prototype.start;
 Pipeline.prototype.start=function(){if(this.entries.has('condition'))window.conditionPipeline=this;return start.call(this);};
});
const expectFailure=async page=>{
 expect(await page.evaluate(()=>({failed:window.conditionPipeline.entries.get('condition').failed,errors:window.conditionPipeline.errors.length,state:window.conditionPipeline.state}))).toEqual({failed:true,errors:1,state:'running'});
 await expect(page.locator('#errors')).toContainText('IfCondition unavailable');
 await expect(page.locator('#errors')).toBeVisible();
 expect((await page.locator('#errors').textContent()).split('\n')).toHaveLength(1);
 expect(await page.evaluate(()=>window.graphWorkers.filter(w=>w.url.includes('if-condition-worker')).every(w=>w.released))).toBe(true);
};

test('IfCondition palette/settings/wires persist; preparation verifies, cancels, retries and reuses cache without inference',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f),editor=page.editor;
 await openPalette(editor);await editor.locator('#graph-node-type [data-type="IfCondition"]').click();
 await editor.getByLabel('ifcondition condition',{exact:true}).fill('Does this text mention an animal?');
 await editor.getByRole('button',{name:'speech output final',exact:true}).click();await editor.getByRole('button',{name:'ifcondition input text',exact:true}).click();
 await editor.getByRole('button',{name:'ifcondition output yes',exact:true}).click();await editor.getByRole('button',{name:'transcript input input1',exact:true}).click();
 f.mode('corrupt');await save(editor);await expect(card(editor)).toHaveAttribute('data-state','Error');
 await editor.reload();await editor.getByRole('button',{name:'Select ifcondition',exact:true}).click();
 await expect(editor.getByLabel('ifcondition condition',{exact:true})).toHaveValue('Does this text mention an animal?');
 expect(await editor.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })().edges.some(e=>e.from[0]==='ifcondition'&&e.from[1]==='yes'))).toBe(true);
 f.mode('hold');await save(editor);await expect(card(editor)).toHaveAttribute('data-state','Downloading');await card(editor).getByRole('button',{name:'Cancel preparation',exact:true}).click();
 await expect(card(editor)).toHaveAttribute('data-state','Canceled');f.mode('normal');await card(editor).getByRole('button',{name:'Retry preparation',exact:true}).click();
 await expect(card(editor)).toHaveAttribute('data-state','Ready');const count=f.requests.length;await save(editor);await expect(card(editor)).toHaveAttribute('data-state','Ready');expect(f.requests.length).toBe(count);
 expect(await page.evaluate(()=>window.graphWorkers.filter(w=>w.url.includes('if-condition-worker')).flatMap(w=>w.messages).some(m=>m.type==='decide'))).toBe(false);
 await editor.getByLabel('ifcondition condition',{exact:true}).fill(' ');await save(editor);await expect(editor.locator('#graph-errors')).toContainText('nonempty');
 expect(await editor.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })().nodes.find(n=>n.id==='ifcondition').settings.condition)).toBe('Does this text mention an animal?');
});

test('production Worker with fixture logits routes once, preserves text/repeats/empty and drains on Stop',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await seedConditionGraph(page.editor);await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');
 await startGraph(page);for(const text of ['  yes-fixture\n','plain','  yes-fixture\n','','  '])await emitFinal(page,text);
 await page.locator('#stop').click();await expect(page.locator('#start')).toBeEnabled();
 await expect(items(page,'yes')).toHaveText(['  yes-fixture\n','  yes-fixture\n'].join('\n'));await expect(items(page,'no')).toHaveText(['plain','','  '].join('\n'));
 await expect(items(page,'transcript')).toHaveText(['  yes-fixture\n','plain','  yes-fixture\n','','  '].join('\n'));
 await expectPreparedIdle(page);
});

for(const text of ['uncertain-fixture','error-fixture','long-token-fixture'])test(`${text} stops only the condition branch and leaves the transcript usable`,async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await trackPipeline(page);await seedConditionGraph(page.editor);await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');await startGraph(page);
 await emitFinal(page,text);await expect(page.locator('#condition-status')).toContainText('unavailable');await expect(items(page,'yes')).toBeEmpty();await expect(items(page,'no')).toBeEmpty();
 await expectFailure(page);
 await emitFinal(page,'peer still alive');await expect(items(page,'transcript').locator('tr td:first-child')).toHaveText([text,'peer still alive']);await expect(page.locator('#status')).toHaveText('Transcription active');
 if (text === 'error-fixture') await page.locator('#stop').click();
 else await page.evaluate(() => window.graphSession.cancel());
 await expect(page.locator('#start')).toBeEnabled();
 if(text==='error-fixture')await expect(page.locator('#status')).toHaveText('Stopped. Outputs are ready.');
 await expectPreparedIdle(page);
});

test('missing cache never downloads at Start; Cancel during Stop/restart has no stale output',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await trackPipeline(page);await seedConditionGraph(page.editor);
 const count=f.requests.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.locator('#errors')).toContainText('missing');await expect(page.locator('#start')).toBeDisabled();expect(f.requests.length).toBe(count);
 await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');
 await startGraph(page);await emitFinal(page,'slow-fixture yes-fixture');await page.locator('#stop').click();await expect(page.locator('#status')).toContainText('Finalizing');
 await page.evaluate(() => window.graphSession.cancel());await expect(page.locator('#start')).toBeEnabled();await startGraph(page);await emitFinal(page,'yes-fixture');
 await expect(items(page,'yes')).toHaveText(['yes-fixture'].join('\n'));await page.waitForTimeout(1600);await expect(items(page,'yes')).toHaveText(['yes-fixture'].join('\n'));await page.locator('#stop').click();await expect(page.locator('#start')).toBeEnabled();
});

test('an unavailable packaged backend blocks Start and preserves the saved graph',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await seedConditionGraph(page.editor);await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');
 const {writeFile}=await import('node:fs/promises');const path=await import('node:path');
 await writeFile(path.join(f.root,'web/vendor/translation/transformers.js'),"throw new Error('Controlled unavailable backend');");
 const saved=await page.evaluate(()=>localStorage.getItem('processing-graph-library-v1'));await page.reload();
 await expect(page.locator('#errors')).toContainText('Controlled unavailable backend');await expect(page.locator('#start')).toBeDisabled();
 expect(await page.evaluate(()=>localStorage.getItem('processing-graph-library-v1'))).toBe(saved);
 await expect.poll(()=>page.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
});
