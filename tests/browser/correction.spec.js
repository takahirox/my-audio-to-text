import { test, expect } from '@playwright/test';
import { QWEN3_CORRECTION } from '../../web/correction-policy.js';
async function fixture(page, mode = 'success', gpu = 'available') {
  await page.context().route('**/qwen3-correction-worker.js', async route => {
    const original=await route.fetch();
    const value=gpu==='absent'?'undefined':`{requestAdapter:async()=>${gpu==='no-adapter'?'null':`({features:new Set(${gpu==='no-f16'?'[]':"['shader-f16']"})})`}}`;
    await route.fulfill({response:original,body:`Object.defineProperty(self.navigator,'gpu',{value:${value}});\n${await original.text()}`});
  });
  await page.context().route('**/correction-assets/transformers.js', route => route.fulfill({contentType:'text/javascript',body:`
    export const env={backends:{onnx:{wasm:{}}}};
    export async function pipeline(task,id,options) {
      if(task!=='text-generation'||id!==${JSON.stringify(QWEN3_CORRECTION.id)}||options.revision!==${JSON.stringify(QWEN3_CORRECTION.revision)}||options.device!=='webgpu'||options.dtype!=='q4f16') throw Error('Wrong checkpoint/runtime');
      if(env.allowLocalModels!==false||env.useBrowserCache!==false||env.useCustomCache!==true||!env.customCache||env.backends.onnx.wasm.numThreads!==1||env.backends.onnx.wasm.proxy!==false||!env.backends.onnx.wasm.wasmPaths.mjs.includes('/correction-assets/')) throw Error('Wrong local runtime/cache policy');
      options.progress_callback({status:'progress',file:'weights',progress:50});
      if(${JSON.stringify(mode)}==='cache-warning')options.progress_callback({status:'cache-warning',message:'Cache quota exceeded; later runs may download again.'});
      if(${JSON.stringify(mode)}==='load-error') throw Error('Offline cache miss');
      if(${JSON.stringify(mode)}==='loading') await new Promise(r=>setTimeout(r,1500));
      let original,candidate,length;
      const tokenizer=prompt=>{
        const messages=JSON.parse(prompt);
        original=messages[1].content;
        length=original==='tokens'?1025:10;
        return {input_ids:{dims:[1,length]}};
      };
      tokenizer.apply_chat_template=(messages,settings)=>{
        if(settings.enable_thinking!==false||settings.add_generation_prompt!==true||settings.tokenize!==false)throw Error('Thinking must be disabled');
        for(const term of ['minimal','uncertain','proper names','negation','paraphrase','translate','no audio'])if(!messages[0].content.includes(term))throw Error('Missing policy '+term);
        return JSON.stringify(messages);
      };
      tokenizer.decode=()=>candidate;
      return {tokenizer,model:{config:{eos_token_id:151645},async generate(settings){
        if(settings.do_sample!==false||settings.max_new_tokens!==256||settings.num_beams!==1)throw Error('Wrong decoding bounds');
        if(${JSON.stringify(mode)}==='inference-error'||original==='fail')throw Error('Inference failed');
        await new Promise(r=>setTimeout(r,original==='slow'?1500:10));
        candidate=original==='bad-format'?'<think>Reasoning</think>bad':original==='bad-number'?'42':original.replace('転機','天気').replace('their is','there is');
        return {tolist:()=>[Array(length).fill(0n).concat([1n,original==='truncated'?2n:151645n])]};
      }}};
    }
  `}));
}
async function observe(page) {
  await page.evaluate(async()=>{
    const {Pipeline}=await import('../../pipeline.js'); const start=Pipeline.prototype.start;
    window.graphs=[];Pipeline.prototype.start=function(){window.graphs.push(this);return start.call(this);};
    const Native=Worker;window.workers=[];window.Worker=class extends Native{
      constructor(url,options){super(url,options);this.record={url:String(url),terminated:0};window.workers.push(this.record);}
      terminate(){this.record.terminated++;super.terminate();}
    };
  });
}
test('navigation under prefix, production graph/Worker, original comparison, times, repeat and bypass',async({page})=>{
  await fixture(page);const requests=[];page.on('request',r=>requests.push(r.url()));
  const prefix=!process.env.ASR_BASE_URL&&!process.env.ASR_BENCHMARK?'./my-audio-to-text/':'./';
  await page.goto(prefix);await page.getByRole('link',{name:'Qwen3 Transcript Correction (Japanese / English)',exact:true}).click();
  await expect(page.locator('#run')).toBeEnabled();expect(requests.some(url=>/correction-assets|huggingface/.test(url))).toBe(false);
  await observe(page);
  for(const text of ['今日は良い転機です。','their is a cat','I will not attend on October 9, 2026 at 14:30.','<img src=x onerror=alert(1)>']) {
    await page.locator('#input').fill(text);await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Complete');
    await expect(page.locator('#original')).toHaveText(text);await expect(page.locator('#output')).toHaveText(text.replace('転機','天気').replace('their is','there is'));
    await expect(page.locator('#latency')).toContainText('ms');await expect(page.locator('#load-time')).toContainText('ms');
    await expect(page.locator('#input')).toHaveValue(text);
    if(text.includes('転機'))await expect(page.locator('#change')).toContainText('“転機” → “天気”');
    await expect(page.locator('#output img')).toHaveCount(0);
  }
  expect(await page.evaluate(()=>[...window.graphs[0].entries.values()].map(e=>e.node.constructor.name))).toEqual(['TextInputNode','SpeechTranscriptCorrectionNode','TextOutputNode','TextOutputNode']);
  expect(await page.evaluate(()=>window.workers.map(w=>w.terminated))).toEqual([1,1,1,1]);
  for(const worker of await page.evaluate(()=>window.workers)) expect(worker.url).toBe(new URL('../../qwen3-correction-worker.js',page.url()).href);
  await page.locator('#bypass').check();await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Bypassed');
  expect(await page.evaluate(()=>window.workers.length)).toBe(4);await expect(page.locator('#change')).toHaveText('Exact copy of the original.');
  await page.getByRole('link',{name:'Node Playground',exact:true}).click();await expect(page).toHaveTitle('Node Playground');
});
for(const mode of ['load-error','inference-error']) test(`${mode}: visible errors preserve original and retry/bypass works`,async({page})=>{
  await fixture(page,mode);await page.goto('./nodes/qwen3-correction/');await expect(page.locator('#run')).toBeEnabled();await observe(page);
  await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText(mode==='load-error'?'Offline cache miss':'Inference failed');await expect(page.locator('#output')).toBeEmpty();
  await expect(page.locator('#original')).toHaveText('今日は良い天気です。');expect(await page.evaluate(()=>window.workers[0].terminated)).toBe(1);
  await page.locator('#bypass').check();await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Bypassed');
  await page.locator('#bypass').uncheck();await page.context().unroute('**/correction-assets/transformers.js');await fixture(page);
  await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Complete');
});
for(const phase of ['loading','generation']) test(`cancel during ${phase}, late output ignored, fresh run`,async({page})=>{
  await fixture(page,phase==='loading'?'loading':'success');await page.goto('./nodes/qwen3-correction/');await expect(page.locator('#run')).toBeEnabled();await observe(page);
  await page.locator('#input').fill('slow');await page.locator('#run').click();await expect(page.locator('#status')).toContainText(phase==='loading'?'Loading':'Generating');
  await page.locator('#cancel').click();await expect(page.locator('#status')).toHaveText('Canceled');await expect(page.locator('#original')).toHaveText('slow');await expect(page.locator('#output')).toBeEmpty();
  await page.locator('#input').fill('fresh');await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Complete');await expect(page.locator('#output')).toHaveText('fresh');
  expect(await page.evaluate(()=>window.workers.map(w=>w.terminated))).toEqual([1,1]);
});
for(const [text,message] of [['tokens','1,024 tokens'],['truncated','output limit'],['bad-format','invalid response format'],['bad-number','numeric figures']]) test(`Worker rejects ${text}; original retained`,async({page})=>{
  await fixture(page);await page.goto('./nodes/qwen3-correction/');await page.locator('#input').fill(text);await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Error');await expect(page.locator('#errors')).toContainText(message);await expect(page.locator('#output')).toBeEmpty();await expect(page.locator('#original')).toHaveText(text);
});
for(const gpu of ['absent','no-adapter','no-f16']) test(`unsupported GPU ${gpu} fails before runtime/model requests`,async({page})=>{
  await fixture(page,'success',gpu);const requests=[];page.on('request',r=>{if(/correction-assets|huggingface/.test(r.url()))requests.push(r.url());});
  await page.goto('./nodes/qwen3-correction/');await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('Error');
  await expect(page.locator('#errors')).toContainText(gpu==='absent'?'requires WebGPU':gpu==='no-adapter'?'No WebGPU adapter':'shader-f16');expect(requests).toEqual([]);
});
test('real production Worker FIFO empty/long inputs, drain, error recovery and repeat',async({page})=>{
  await fixture(page);await page.goto('./nodes/qwen3-correction/');
  const responses=await page.evaluate(async()=>{
    const worker=new Worker(new URL('../../qwen3-correction-worker.js',location.href),{type:'module'});
    const pending=new Map();worker.onmessage=({data})=>{if(data.id){pending.get(data.id)(data);pending.delete(data.id);}};
    let id=0;const call=data=>new Promise(resolve=>{pending.set(++id,resolve);worker.postMessage({...data,id});});
    const results=[await call({type:'load',language:'en'})];
    results.push(...await Promise.all(['',' ', 'fail','x'.repeat(501),'their is a cat','again'].map(text=>call({type:'correct',text}))));
    results.push(await call({type:'drain'}));worker.terminate();return results;
  });
  expect(responses.map(r=>r.type)).toEqual(['ready','result','result','error','error','result','result','drained']);
  expect(responses[1].text).toBe('');expect(responses[2].text).toBe(' ');expect(responses[5].text).toBe('there is a cat');expect(responses[6].text).toBe('again');
});
test('real browser CacheStorage persists pinned assets between adapters; empty page input avoids Worker',async({page})=>{
  await fixture(page);await page.goto('./nodes/qwen3-correction/');await expect(page.locator('#run')).toBeEnabled();await observe(page);
  await page.locator('#input').fill(' ');await page.locator('#run').click();await expect(page.locator('#errors')).toContainText('Enter a final transcript');expect(await page.evaluate(()=>window.workers.length)).toBe(0);
  const cached=await page.evaluate(async()=>{
    const {correctionCache,CORRECTION_CACHE}=await import('../../correction-cache.js');const {QWEN3_CORRECTION:m}=await import('../../correction-policy.js');
    const url='https://huggingface.co/'+m.id+'/resolve/'+m.revision+'/config.json';const events=[];
    await caches.delete(CORRECTION_CACHE);const first=correctionCache(caches,e=>events.push(e));
    const miss=await first.match(url);await first.put(url,new Response('cached fixture'));
    const second=correctionCache(caches,e=>events.push(e));const response=await second.match(url);
    const text=await response.text();await caches.delete(CORRECTION_CACHE);return {miss:!!miss,text,events};
  });expect(cached).toEqual({miss:false,text:'cached fixture',events:[]});
});

test('cache quota warning stays visible through successful inference',async({page})=>{
  await fixture(page,'cache-warning');await page.goto('./nodes/qwen3-correction/');await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText('Complete');await expect(page.locator('#cache-status')).toContainText('Cache quota exceeded');
});
