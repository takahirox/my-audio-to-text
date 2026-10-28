import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export { test, expect, openGraph, startGraph, emitFinal } from './graph-fixture.js';

export async function conditionAssets(f, real = false) {
  const manifestPath = path.join(f.root,'extension/if-condition-assets.json');
  const original = JSON.parse(await readFile(manifestPath,'utf8'));
  const files = real ? original : [{path:'weights.bin',bytes:8192,sha256Chunks:[createHash('sha256').update(Buffer.alloc(8192,17)).digest('hex')]}];
  for(const file of files) {
    const body=real ? await readFile(path.resolve('.cache/if-condition/c07f66d9cbf781191bee66edfe8ad7856f045781',file.path)) : Buffer.alloc(8192,17);
    file.sourceURL=f.asset(`if-condition/${file.path}`,body);
  }
  await writeFile(manifestPath,JSON.stringify(files));
  if(real) return;
  // Deterministic logits replace ONLY the heavyweight model/runtime. The owned
  // production Worker, cache verification, prompt bounds and policy stay real.
  const runtime=path.join(f.root,'web/vendor/translation'); await mkdir(runtime,{recursive:true});
  await writeFile(path.join(runtime,'transformers.js'),`
export const env={backends:{onnx:{wasm:{}}}};
export async function pipeline(id,model,options){
 if(env.allowRemoteModels!==false||env.useWasmCache!==false||env.useBrowserCache!==false)throw Error('Remote runtime access enabled');
 const tokenizer=(text,options)=>({input_ids:{data:BigInt64Array.from([/yes/i.test(text)?2n:3n]),dims:[1,text.includes('long-token-fixture')?513:20],text}});
 const infer=async inputs=>{
 const text=inputs.input_ids.text;
 if(text.includes('slow-fixture'))await new Promise(r=>setTimeout(r,1500));
 if(text.includes('error-fixture'))throw Error('Controlled inference failure');
 const branch=text.includes('yes-fixture')?0:1;
 const data=Float32Array.from({length:2},(_,i)=>i===branch?8:0);
 if(text.includes('uncertain-fixture'))data[0]=data[1]=8;
 return {logits:{dims:[1,2],data}};
 };
 infer.config={label2id:{entailment:0,not_entailment:1}};return {tokenizer,model:infer};
}`);
}

export async function seedConditionGraph(editor) {
  await editor.evaluate(async()=>{
    const {defaultGraph,graphNode,edge,saveGraph}=await import('./graph.js');
    const g=defaultGraph();g.nodes.push(graphNode('IfCondition','condition',500,300),graphNode('LiveTextDisplay','yes',850,300),graphNode('LiveTextDisplay','no',850,600),graphNode('TextAccumulator','yes-acc'),graphNode('TextAccumulator','no-acc'));
    g.nodes.find(n=>n.id==='yes').settings.label='Yes';g.nodes.find(n=>n.id==='no').settings.label='No';
    g.edges.push(edge('speech','final','condition','text'),edge('condition','yes','yes-acc','append'),edge('condition','no','no-acc','append'),edge('yes-acc','text','yes','content'),edge('no-acc','text','no','content'));
    saveGraph(localStorage,g);
  });
  await editor.reload();
}
