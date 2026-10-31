import { accumulateDisplay } from '../fixtures/text-accumulator.js';
import { test, expect, openGraph } from './graph-fixture.js';
import { graphNode, edge, defaultGraph } from '../../extension/graph.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

for (const translator of ['TranslateGemmaEnJa','TranslateGemmaJaEn','OpusMtEnJa','OpusMtJaEn']) test(`${translator}: MV3 editor connects ASR previews and window text in either order and saves incomplete drafts`, async ({ graphExtension:f }) => {
  test.setTimeout(90000);
  const live=await openGraph(f), editor=live.editor;
  for(const source of ['speech','window']) for(const ports of [['provisional','text'],['text','provisional']]) {
    const graph=defaultGraph(); graph.nodes.push(graphNode(translator,'translator',600,400),graphNode('TextWindow','window',300,400));
    await editor.evaluate(async graph=>{const {saveGraph}=await import('./graph.js');saveGraph(localStorage, window.addDOMFormatters(graph));},graph);await editor.reload();
    for(const input of ports){
      const output=source==='window'?'text':input==='text'?'final':'provisional';
      await editor.getByRole('button',{name:`${source} output ${output}`,exact:true}).press('Enter');
      await editor.getByRole('button',{name:`translator input ${input}`,exact:true}).press('Enter');
      await expect(editor.locator('#graph-errors')).toBeEmpty();
      await editor.locator('#graph-save').click();await expect(editor.locator('#graph-save')).toBeEnabled();
      await editor.reload();
      const saved=await editor.evaluate(()=>JSON.parse(localStorage.getItem('processing-graph-v1')));
      expect(saved.edges).toContainEqual(edge(source,output,'translator',input));
    }
  }
});

test('MV3 direct ASR → TranslateGemma provisional/final uses production scheduler and atomic commit',async({graphExtension:f})=>{
  await writeFile(path.join(f.root,'web/translategemma-worker.js'),`
    self.onmessage=({data:m})=>{
      if(m.type==='load')postMessage({id:m.id,type:'ready'});
      if(m.type==='drain')postMessage({id:m.id,type:'drained'});
      if(m.type==='translate')setTimeout(()=>postMessage({id:m.id,type:'result',texts:['translated:'+m.text]}),20);
    };`);
  const live=await openGraph(f);
  const graph=defaultGraph();graph.nodes.push(graphNode('TranslateGemmaEnJa','translator'),graphNode('TranslationCommit','commit'),graphNode('TextAccumulator','acc'),graphNode('LiveTextDisplay','translated'),graphNode('LiveTextDisplay','preview'));
  graph.edges.push(edge('speech','provisional','translator','provisional'),edge('speech','final','translator','text'),edge('speech','final','commit','boundary'),
    ...['source','text','error'].map(p=>edge('translator',p,'commit',p)),edge('commit','final','acc','append'),edge('translator','provisionalText','preview','content'),edge('acc','text','translated','content'));
  const result=await live.evaluate(async graph=>{
    const {buildGraph}=await import('./graph-runtime.js');const displays={},events=[];
    const built=buildGraph(window.addDOMFormatters(graph),{tabId:42,prepareTranslateGemma(){},onDisplay(id,dom){const text=dom.textContent;displays[id]=text;events.push({id,text});}});
    const wait=async predicate=>{const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('Timed out waiting for packaged translation');await new Promise(r=>setTimeout(r,5));}};
    try{
      await built.pipeline.start();await built.translations[0].ready;const speech=built.speechNodes.get('speech');
      speech.receiveEvent({type:'partial',text:'preview'});await wait(()=>displays.preview==='translated:preview');
      speech.receiveEvent({type:'final',text:'same',id:1});speech.receiveEvent({type:'final',text:'same',id:2});await built.pipeline.stop();
      return {displays,events,errors:built.pipeline.errors.map(e=>e.message)};
    }finally{await built.pipeline.dispose();}
  },graph);
  expect(result.errors).toEqual([]);expect(result.displays.translated).toBe('translated:same\ntranslated:same');
  expect(result.events).toContainEqual({id:'preview',text:'translated:preview'});
  expect(await live.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
});

test('MV3 formatter startup configuration is delivered before Whisper loads, and late values fail locally',async({graphExtension:f})=>{
  await writeFile(path.join(f.root,'web/whisper-worker.js'),`self.onmessage=({data:m})=>{if(m.type==='load')postMessage({type:'ready'});};`);
  const live=await openGraph(f),graph=defaultGraph();graph.nodes[1].type='SpeechToTextWhisper';graph.edges=graph.edges.filter(e=>e.from[1]!=='provisional');
  graph.nodes.push(graphNode('Text','language'),graphNode('TextFormatter','format'),graphNode('LiveTextDisplay','peer'));graph.nodes.at(-3).settings.value='ja';
  graph.edges.push(edge('language','value','format','input1'),edge('format','text','speech','language'),edge('language','value','peer','content'));
  const result=await live.evaluate(async graph=>{
    const {buildGraph}=await import('./graph-runtime.js');const displays={};
    const built=buildGraph(window.addDOMFormatters(graph),{tabId:42,onDisplay:(id,t)=>{displays[id]=t.textContent;}});
    try{
      await built.pipeline.start();await built.pipeline.entries.get('format').queue;await built.pipeline.entries.get('speech').queue;
      const language=window.graphWorkers.find(w=>w.url.includes('whisper-worker')).messages.find(m=>m.type==='load').language;
      built.pipeline.entries.get('language').context.emit('value','en');await built.pipeline.entries.get('format').queue;await built.pipeline.entries.get('speech').queue;await built.pipeline.entries.get('peer').queue;
      return {language,errors:built.pipeline.errors.map(e=>e.message),displays,state:built.pipeline.state};
    }finally{await built.pipeline.cancel();}
  },graph);
  expect(result.language).toBe('ja');expect(result.errors.join(' ')).toContain('before model loading');expect(result.state).toBe('running');expect(result.displays.peer).toBe('en');
});

test('MV3 Cancel retains committed snapshots on direct and formatted paths',async({graphExtension:f})=>{
  const live=await openGraph(f);
  const result=await live.evaluate(async()=>{
    const {Pipeline}=await import('../web/pipeline.js');const {TEXT}=await import('../web/port-contracts.js');
    const {TextToDOMNode}=await import('../web/dom-nodes.js');
    const {TextAccumulatorNode,TextFormatterNode,LiveTextDisplayNode}=await import('../web/text-nodes.js');let source;const states={};
    const acc=new TextAccumulatorNode(),pipeline=new Pipeline({nodes:{source:{outputs:{text:TEXT},start(c){source=c;}},acc,format:new TextFormatterNode({template:'[{1}]'}),
      directDOM:new TextToDOMNode(),indirectDOM:new TextToDOMNode(),direct:new LiveTextDisplayNode(t=>{states.direct=t.textContent;}),indirect:new LiveTextDisplayNode(t=>{states.indirect=t.textContent;})},connections:[
      {from:['source','text'],to:['acc','append']},{from:['acc','text'],to:['directDOM','text']},{from:['directDOM','dom'],to:['direct','dom']},{from:['acc','text'],to:['format','input1']},{from:['format','text'],to:['indirectDOM','text']},{from:['indirectDOM','dom'],to:['indirect','dom']}]});
    await pipeline.start();source.emit('text','keep');await pipeline.entries.get('acc').queue;
    await pipeline.entries.get('format').queue;
    source.emit('text','queued');await pipeline.cancel();source.emit('text','late');return states;
  });
  expect(result).toEqual({direct:'keep',indirect:'[keep]'});
});

test('MV3 session waits for inactive startup sources and rejects invalid values before creating model Workers',async({graphExtension:f})=>{
  const live=await openGraph(f),missing=defaultGraph();missing.nodes[1].type='SpeechToTextWhisper';missing.edges=missing.edges.filter(e=>e.from[1]!=='provisional');
  missing.nodes.push(graphNode('TextFormatter','unready'),graphNode('SpeechToTextWhisper','unready-asr'));
  missing.edges.push(edge('unready-asr','final','unready','input1'),edge('unready','text','speech','language'));
  const invalid=defaultGraph();invalid.nodes.push(graphNode('Number','cap'));invalid.edges.push(edge('cap','value','speech','maxDuration'));
  const results=await live.evaluate(async({missing,invalid})=>{
    const {TabSession}=await import('./session.js');const results=[];
    const run=async graph=>{
      let workers=0;const session=new TabSession(()=>{},{graph,workerFactory(){workers++;throw Error('Must not load invalid or missing configuration');},whisperWorkerFactory(){workers++;throw Error('Must not load a default model');},sourceFactory:()=>({start(){},stop(){}})});
      await session.start(42);await new Promise(r=>setTimeout(r,0));const state=session.view.state,signal=session.view.signal;
      await session.stop();await session.cancel();return {workers,state,signal,error:session.view.error};
    };
    results.push(await run(missing));
    for(const value of [0,-1,0.5,12.1]){invalid.nodes.at(-1).settings.value=value;results.push(await run(invalid));}
    return results;
  },{missing,invalid});
  expect(results[0].state).toBe('running');expect(results[0].signal).toContain('Waiting for startup language');expect(results[0].error).toContain('language unavailable');
  expect(results.every(r=>r.workers===0)).toBe(true);for(const result of results.slice(1))expect(result.error).toContain('1 to 12 seconds');
});

test('MV3 arbitrary NUMBER producer configures ReazonSpeech through ordinary ports',async({graphExtension:f})=>{
  const live=await openGraph(f);
  const result=await live.evaluate(async()=>{
    const {Pipeline}=await import('../web/pipeline.js');const {NUMBER,TEXT}=await import('../web/port-contracts.js');
    const {SpeechToTextNode,MONO_16KHZ_PCM}=await import('../web/transcription-nodes.js');
    let configuration;const speech=new SpeechToTextNode(),pipeline=new Pipeline({nodes:{
      configuration:{outputs:{arbitrary:NUMBER},start(c){configuration=c;}},audio:{outputs:{pcm:MONO_16KHZ_PCM}},speech,sink:{inputs:{text:TEXT},receive(){}}},
      connections:[{from:['configuration','arbitrary'],to:['speech','maxDuration']},{from:['audio','pcm'],to:['speech','audio']},{from:['speech','final'],to:['sink','text']}]});
    try{
      await pipeline.start();const before=window.graphWorkers.length;configuration.emit('arbitrary',2.5);await pipeline.entries.get('speech').queue;
      const cap=speech.core.simulation.maxSamples;configuration.emit('arbitrary',3);await pipeline.entries.get('speech').queue;
      return {before,cap,errors:pipeline.errors.map(e=>e.message)};
    }finally{await pipeline.cancel();}
  });
  expect(result.before).toBe(0);expect(result.cap).toBe(40000);expect(result.errors.join(' ')).toContain('before session startup');
  expect(await live.evaluate(()=>window.graphWorkers.every(w=>w.released))).toBe(true);
});
