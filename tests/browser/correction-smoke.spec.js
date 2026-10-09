import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { correctionFixtures } from '../fixtures/correction.js';
import { QWEN3_CORRECTION } from '../../web/correction-policy.js';

test('real Qwen3 production Worker: Japanese/English safety, errors, repeat, cache and local-only traffic', async ({ page, browser }, testInfo) => {
  test.skip(process.env.CORRECTION_SMOKE !== '1' || testInfo.project.name !== 'chromium', 'Opt-in 579 MB download and WebGPU shader-f16 device required.');
  test.setTimeout(900000);
  const requests=[],errors=[];
  page.on('request',r=>{const u=new URL(r.url());requests.push({url:u.origin+u.pathname,method:r.method(),hasBody:r.postData()!==null,containsInput:correctionFixtures.some(f=>r.url().includes(f.text)||r.url().includes(encodeURIComponent(f.text)))});});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('./nodes/qwen3-correction/');await expect(page.locator('#run')).toBeEnabled();
  const capabilities=await page.evaluate(async()=>{
    const adapter=await navigator.gpu?.requestAdapter();
    return {gpu:!!navigator.gpu,adapter:!!adapter,f16:!!adapter?.features.has('shader-f16'),info:adapter?.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description}:null,userAgent:navigator.userAgent,secure:isSecureContext,isolated:crossOriginIsolated};
  });
  let result, pageRun;
  try {
    expect(capabilities.adapter).toBe(true);expect(capabilities.f16).toBe(true);
    // One model owner evaluates the ordered batch. No fixture metadata enters
    // its plain TEXT input. Consumers alone retain identity/reference/order.
    result=await page.evaluate(async fixtures=>{
      const {Pipeline}=await import('../../pipeline.js');
      const {SpeechTranscriptCorrectionNode,TEXT}=await import('../../correction-nodes.js');
      const {TextOutputNode}=await import('../../translation-nodes.js');
      const events=[],failures=[],runs=[],originals=[];let sourceContext,ready,loaded;
      const started=performance.now();
      const correction=new SpeechTranscriptCorrectionNode({language:'auto',onFailure:'bypass',onEvent:event=>{if(event.status!=='progress')events.push(event);if(event.type==='ready')ready=performance.now();}});
      const graph=new Pipeline({nodes:{source:{outputs:{text:TEXT},start(c){sourceContext=c;}},correction,original:new TextOutputNode(t=>originals.push(t)),sink:new TextOutputNode(t=>runs.push({text:t,time:performance.now()}))},connections:[
        {from:['source','text'],to:['original','text']},{from:['source','text'],to:['correction','text']},{from:['correction','text'],to:['sink','text']},
      ],onError:error=>failures.push(error.message)});
      try {
        await graph.start();loaded=performance.now()-started;
        // Explicit per-input bypass lets all quality fixtures run after a
        // rejected candidate. Rejections are counted separately from exact
        // copies, never as successful model inference.
        for(const fixture of [...fixtures,fixtures[0]]){
          const before=performance.now(), previousEvents=events.length;sourceContext.emit('text',fixture.text);
          await graph.entries.get('correction').queue;await graph.entries.get('sink').queue;await graph.entries.get('original').queue;
          if(failures.length)break;
          const run=runs.at(-1);run.id=fixture.id;run.input=fixture.text;run.expected=fixture.expected;run.kind=fixture.kind;
          run.inferenceMs=run.time-before;delete run.time;
          run.rejections=events.slice(previousEvents).filter(e=>e.type==='bypass');
          run.exactMatch=run.text===fixture.expected;run.changed=run.text!==fixture.text;
          run.outcome=run.rejections.length?'rejected':run.exactMatch?(fixture.kind==='exact-copy'?'unchanged-correct':'corrected'):(fixture.kind==='exact-copy'?'regression':run.changed?'other-change':'missed-correction');
        }
        await graph.stop();
      }catch(error){failures.push(error.message);}finally{await graph.dispose();}
      const {CORRECTION_CACHE}=await import('../../correction-cache.js');
      const cache=await caches.open(CORRECTION_CACHE);const cacheKeys=(await cache.keys()).map(r=>r.url);
      return {loadedMs:loaded,totalMs:performance.now()-started,runs,originals,events,failures,cacheKeys};
    },correctionFixtures);
    console.log(JSON.stringify({browser:browser.version(),capabilities,loadedMs:result.loadedMs,totalMs:result.totalMs,runs:result.runs,failures:result.failures,cacheKeys:result.cacheKeys,cacheWarnings:result.events.filter(e=>e.status==='cache-warning')}));
    expect(result.failures).toEqual([]);expect(result.runs).toHaveLength(correctionFixtures.length+1);
    expect(result.originals).toEqual([...correctionFixtures,correctionFixtures[0]].map(f=>f.text));
    expect(result.runs.filter(r=>r.input===correctionFixtures[0].text).map(r=>r.text)).toHaveLength(2);
    for(const language of ['ja','en']) expect(result.runs.some(r=>!r.rejections.length&&correctionFixtures.find(f=>f.id===r.id)?.language===language)).toBe(true);
    expect(errors).toEqual([]);
    // Exercise the actual Playground controls with real inference too. This
    // fresh Worker also reveals whether the previous model cache can be reused.
    await page.locator('#input').fill(correctionFixtures[0].text);
    await page.locator('#language').selectOption('ja');
    await page.locator('#run').click();
    await expect(page.locator('#status')).toHaveText(/^(Complete|Error)$/, { timeout: 840000 });
    pageRun = await page.evaluate(() => Object.fromEntries(['status', 'errors', 'original', 'output', 'load-time', 'latency', 'cache-status'].map(id => [id, document.getElementById(id).textContent])));
    expect(pageRun.status).toBe('Complete'); expect(pageRun.errors).toBe('');
    expect(pageRun.original).toBe(correctionFixtures[0].text);
    expect(pageRun.output.trim().length).toBeGreaterThan(0);
    pageRun.language = 'ja'; pageRun.expected = correctionFixtures[0].expected;
    pageRun.exactMatch = pageRun.output === pageRun.expected;
    pageRun.outcome = pageRun.exactMatch ? 'unchanged-correct' : 'regression';
    for(const r of requests){
      expect(r.method).toBe('GET');expect(r.hasBody).toBe(false);expect(r.containsInput).toBe(false);
      const u=new URL(r.url);if(u.origin!==new URL(page.url()).origin){
        expect(u.hostname==='huggingface.co'||u.hostname==='hf.co'||u.hostname.endsWith('.hf.co')).toBe(true);
        if(u.hostname==='huggingface.co')expect(u.pathname.startsWith(`/${QWEN3_CORRECTION.id}/resolve/${QWEN3_CORRECTION.revision}/`)||u.pathname.startsWith(`/api/resolve-cache/models/${QWEN3_CORRECTION.id}/${QWEN3_CORRECTION.revision}/`)).toBe(true);
      }
    }
    // Quality counts are evidence, not a fluent-output quality assertion.
  } finally {
    const path=testInfo.outputPath('correction-evidence.json');
    await writeFile(path,JSON.stringify({time:new Date().toISOString(),browser:browser.version(),capabilities,model:QWEN3_CORRECTION,fixtures:correctionFixtures,result,pageRun,requests,errors},null,2)+'\n');
    await testInfo.attach('correction-evidence',{path,contentType:'application/json'});
  }
});
