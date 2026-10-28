import { test, expect, openGraph, startGraph, emitFinal, conditionAssets, seedConditionGraph } from './if-condition-fixture.js';
import { openPalette } from './ui-controls.js';
const items=(page,id)=>page.locator(`[data-display="${id}"] .display-content`);
const card=editor=>editor.locator('#graph-models .model-card').filter({hasText:'IfCondition'});
const save=async editor=>{await editor.locator('#graph-save').click();await expect(editor.locator('#graph-save')).toBeEnabled();};

test('IfCondition palette/settings/wires persist; preparation verifies, cancels, retries and reuses cache without inference',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f),editor=page.editor;
 await openPalette(editor);await editor.locator('#graph-node-type').selectOption('IfCondition');await editor.locator('#graph-add').click();
 await editor.getByLabel('ifcondition condition',{exact:true}).fill('Does this text mention an animal?');
 await editor.getByRole('button',{name:'speech output final',exact:true}).click();await editor.getByRole('button',{name:'ifcondition input text',exact:true}).click();
 await editor.getByRole('button',{name:'ifcondition output yes',exact:true}).click();await editor.getByRole('button',{name:'transcript-accumulator input append',exact:true}).click();
 f.mode('corrupt');await save(editor);await expect(card(editor)).toHaveAttribute('data-state','Error');
 await editor.reload();await editor.getByRole('button',{name:'Select ifcondition',exact:true}).click();
 await expect(editor.getByLabel('ifcondition condition',{exact:true})).toHaveValue('Does this text mention an animal?');
 expect(await editor.evaluate(()=>JSON.parse(localStorage.getItem('processing-graph-v1')).edges.some(e=>e.from[0]==='ifcondition'&&e.from[1]==='yes'))).toBe(true);
 f.mode('hold');await save(editor);await expect(card(editor)).toHaveAttribute('data-state','Downloading');await card(editor).getByRole('button',{name:'Cancel preparation',exact:true}).click();
 await expect(card(editor)).toHaveAttribute('data-state','Canceled');f.mode('normal');await card(editor).getByRole('button',{name:'Retry preparation',exact:true}).click();
 await expect(card(editor)).toHaveAttribute('data-state','Ready');const count=f.requests.length;await save(editor);await expect(card(editor)).toHaveAttribute('data-state','Ready');expect(f.requests.length).toBe(count);
 expect(await page.evaluate(()=>window.graphWorkers.length)).toBe(0);
 await editor.getByLabel('ifcondition condition',{exact:true}).fill(' ');await save(editor);await expect(editor.locator('#graph-errors')).toContainText('nonempty');
 expect(await editor.evaluate(()=>JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.find(n=>n.id==='ifcondition').settings.condition)).toBe('Does this text mention an animal?');
});

test('production Worker with fixture logits routes once, preserves text/repeats/empty and drains on Stop',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await seedConditionGraph(page.editor);await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');
 await startGraph(page);for(const text of ['  yes-fixture\n','plain','  yes-fixture\n','','  '])await emitFinal(page,text);
 await page.locator('#stop').click();await expect(page.locator('#start')).toBeEnabled();
 await expect(items(page,'yes')).toHaveText(['  yes-fixture\n','  yes-fixture\n'].join('\n'));await expect(items(page,'no')).toHaveText(['plain','','  '].join('\n'));
 await expect(items(page,'transcript')).toHaveText(['  yes-fixture\n','plain','  yes-fixture\n','','  '].join('\n'));
 expect(await page.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
});

for(const text of ['uncertain-fixture','error-fixture','long-token-fixture'])test(`${text} stops only the condition branch and leaves the transcript usable`,async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await seedConditionGraph(page.editor);await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');await startGraph(page);
 await emitFinal(page,text);await expect(page.locator('#condition-status')).toContainText('unavailable');await expect(items(page,'yes')).toBeEmpty();await expect(items(page,'no')).toBeEmpty();
 await emitFinal(page,'peer still alive');await expect(items(page,'transcript')).toHaveText([text,'peer still alive'].join('\n'));await expect(page.locator('#status')).toHaveText('Transcription active');
 await page.locator('#cancel-session').click();expect(await page.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
});

test('missing cache never downloads at Start; Cancel during Stop/restart has no stale output',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await seedConditionGraph(page.editor);
 const count=f.requests.length;await startGraph(page);await expect(page.locator('#condition-status')).toContainText('missing');await emitFinal(page,'peer');await expect(items(page,'transcript')).toHaveText(['peer'].join('\n'));expect(f.requests.length).toBe(count);
 await page.locator('#cancel-session').click();await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');
 await startGraph(page);await emitFinal(page,'slow-fixture yes-fixture');await page.locator('#stop').click();await expect(page.locator('#status')).toContainText('Finalizing');
 await page.locator('#cancel-session').click();await expect(page.locator('#start')).toBeEnabled();await startGraph(page);await emitFinal(page,'yes-fixture');
 await expect(items(page,'yes')).toHaveText(['yes-fixture'].join('\n'));await page.waitForTimeout(1600);await expect(items(page,'yes')).toHaveText(['yes-fixture'].join('\n'));await page.locator('#stop').click();await expect(page.locator('#start')).toBeEnabled();
});

test('an unavailable packaged backend is visible and leaves the saved graph and unrelated path intact',async({graphExtension:f})=>{
 await conditionAssets(f);const page=await openGraph(f);await seedConditionGraph(page.editor);await save(page.editor);await expect(card(page.editor)).toHaveAttribute('data-state','Ready');
 const {writeFile}=await import('node:fs/promises');const path=await import('node:path');
 await writeFile(path.join(f.root,'web/vendor/translation/transformers.js'),"throw new Error('Controlled unavailable backend');");
 const saved=await page.evaluate(()=>localStorage.getItem('processing-graph-v1'));await startGraph(page);
 await expect(page.locator('#condition-status')).toContainText('Controlled unavailable backend');await emitFinal(page,'unrelated transcript');
 await expect(items(page,'transcript')).toHaveText(['unrelated transcript'].join('\n'));await expect(items(page,'yes')).toBeEmpty();await expect(items(page,'no')).toBeEmpty();
 expect(await page.evaluate(()=>localStorage.getItem('processing-graph-v1'))).toBe(saved);await page.locator('#stop').click();await expect(page.locator('#start')).toBeEnabled();
});
