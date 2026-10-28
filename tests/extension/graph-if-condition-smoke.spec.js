import { test, expect, openGraph, startGraph, emitFinal, conditionAssets, seedConditionGraph } from './if-condition-fixture.js';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { IF_CONDITION_MODEL } from '../../web/if-condition-model.js';

// No model/runtime substitutions. Only the upstream audio/ASR producer is a
// fixture. Save, cache integrity, owned Worker, inference, CSP and sinks are real.
test('real packaged IfCondition: Save preparation, offline Yes/No, original text, Stop/drain, independent conditions and repeat',async({graphExtension:f},info)=>{
 test.skip(!process.env.IF_CONDITION_SMOKE,'Opt-in: prepare the pinned smoke model, build, then npm run test:if-condition-real.');
 test.setTimeout(600000);
 await conditionAssets(f,true);const page=await openGraph(f);await seedConditionGraph(page.editor);
 const modelCard=page.editor.locator('#graph-models .model-card').filter({hasText:'IfCondition'});
 await page.editor.locator('#graph-save').click();await expect(modelCard).toHaveAttribute('data-state','Ready',{timeout:180000});
 expect(await page.evaluate(()=>window.graphWorkers.length)).toBe(0);
 const downloads=f.requests.length;await page.editor.locator('#graph-save').click();await expect(modelCard).toHaveAttribute('data-state','Ready',{timeout:30000});expect(f.requests.length).toBe(downloads);
 const assets=JSON.parse(await readFile('extension/if-condition-assets.json','utf8'));
 const host=await page.evaluate(()=>({browser:navigator.userAgent,isolated:crossOriginIsolated}));
 const runtime=JSON.parse(await readFile('scripts/if-condition-runtime.json','utf8'));
 const csp=JSON.parse(await readFile('extension/manifest.json','utf8')).content_security_policy;
 const requests=[],violations=[],runs=[];
 f.context.on('request',request=>{if(request.url().startsWith('http'))requests.push(request.url());});
 await page.evaluate(()=>{window.cspViolations=[];addEventListener('securitypolicyviolation',e=>cspViolations.push({directive:e.violatedDirective,uri:e.blockedURI}));});
 const items=id=>page.locator(`[data-display="${id}"] .display-content`);
 const cases=[
  {condition:'Is this a question?',texts:[['  What time does the meeting begin?\n','yes'],['The meeting begins at noon.','no'],['The meeting begins at noon.','no'],['','no']]},
  {condition:'Is the sentiment of this text positive?',texts:[['I am delighted with this wonderful gift.','yes'],['I hate this awful product.','no']]},
  {condition:'Is this a question?',texts:[['What time does the meeting begin?','yes'],['The train leaves at noon.','no']]},
 ];
 try {
  await f.context.setOffline(true);
  for(const {condition,texts} of cases){
   await page.editor.getByRole('button',{name:'Select condition',exact:true}).click();await page.editor.getByLabel('condition condition',{exact:true}).fill(condition);await page.editor.locator('#graph-save').click();await expect(page.editor.locator('#graph-save')).toBeEnabled();
   const started=Date.now();await startGraph(page,120000);const loadMs=Date.now()-started;
   const outputs={yes:[],no:[]},decisions=[];
   for(const [text,branch]of texts){
    const before=Date.now();await emitFinal(page,text);outputs[branch].push(text);
    await expect(items(branch)).toHaveText(outputs[branch].join('\n'),{timeout:30000});
    expect(await items(branch==='yes'?'no':'yes').allTextContents()).toEqual(outputs[branch==='yes'?'no':'yes']);
    decisions.push({text,branch,latencyMs:Date.now()-before});
   }
   await page.locator('#stop').click();await expect(page.locator('#start')).toBeEnabled({timeout:60000});
   await expect(page.locator('#errors')).toBeEmpty();expect(await page.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
   runs.push({condition,loadMs,decisions});
  }
  // Two simultaneously executable instances have separate conditions/Workers,
  // while sharing only the same prepared immutable asset cache.
  await page.editor.evaluate(async()=>{
   const {readGraph,saveGraph,graphNode,edge}=await import('./graph.js');const g=readGraph(localStorage);
   g.nodes.push(graphNode('IfCondition','animal',500,650),graphNode('LiveTextDisplay','animal-yes',1200,300),graphNode('LiveTextDisplay','animal-no',1200,600),graphNode('TextAccumulator','animal-yes-acc'),graphNode('TextAccumulator','animal-no-acc'));
   g.nodes.find(n=>n.id==='animal').settings.condition='Does this text mention an animal?';
   g.edges.push(edge('speech','final','animal','text'),edge('animal','yes','animal-yes-acc','append'),edge('animal','no','animal-no-acc','append'),edge('animal-yes-acc','text','animal-yes','content'),edge('animal-no-acc','text','animal-no','content'));saveGraph(localStorage,g);
  });
  await page.editor.reload();await page.editor.locator('#graph-save').click();await expect(page.editor.locator('#graph-save')).toBeEnabled();
  const parallelStart=Date.now();await startGraph(page,120000);
  const batch=Array.from({length:8},(_,i)=>i%2?'The meeting begins at noon.':'What time does the meeting begin?');
  await page.evaluate(batch=>{for(const text of batch)window.speech.receiveEvent({type:'final',text});document.getElementById('stop').click();},batch);
  await expect(page.locator('#start')).toBeEnabled({timeout:60000});
  expect(await items('yes').allTextContents()).toEqual(batch.filter((_,i)=>i%2===0));expect(await items('no').allTextContents()).toEqual(batch.filter((_,i)=>i%2===1));
  expect(await items('animal-yes').allTextContents()).toEqual([]);expect(await items('animal-no').allTextContents()).toEqual(batch);
  expect(await page.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
  runs.push({parallelConditions:['Is this a question?','Does this text mention an animal?'],inputs:batch,stopDrainMs:Date.now()-parallelStart});
  expect(requests).toEqual([]);violations.push(...await page.evaluate(()=>cspViolations));expect(violations).toEqual([]);
 } finally {
  const evidence={time:new Date().toISOString(),platform:os.platform(),arch:os.arch(),cpu:os.cpus()[0]?.model,host,csp,model:IF_CONDITION_MODEL,runtime,modelBytes:assets.reduce((sum,f)=>sum+f.bytes,0),inference:'Real packaged model and WASM runtime; fixture upstream producer only',runs,requests,violations};
  const output=info.outputPath('if-condition-evidence.json');await writeFile(output,JSON.stringify(evidence,null,2)+'\n');await info.attach('if-condition-evidence',{path:output,contentType:'application/json'});
 }
});
