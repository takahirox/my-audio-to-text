import { settleAutoSave } from './ui-controls.js';
import { test, expect, openGraph } from './graph-fixture.js';
import { graphNode, edge, defaultGraph } from '../../extension/graph.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

for (const translator of ['TranslateGemmaEnJa','TranslateGemmaJaEn','OpusMtEnJa','OpusMtJaEn']) test(`${translator}: MV3 editor connects ASR previews and window text in either order and saves incomplete drafts`, async ({ graphExtension:f }) => {
  test.setTimeout(90000);
  const live=await openGraph(f, { live: false }), editor=live.editor;
  for(const source of ['speech','window']) for(const ports of [['provisional','text'],['text','provisional']]) {
    const graph=defaultGraph(); graph.nodes.push(graphNode(translator,'translator',600,400),graphNode('TextWindow','window',300,400));
    await editor.evaluate(async graph=>{const { saveLiveGraphData } = await import('./graph-library.js');await saveLiveGraphData(localStorage, (graph));},graph);await editor.reload();
    for(const input of ports){
      const output=source==='window'?'text':input==='text'?'final':'provisional';
      await editor.getByRole('button',{name:`${source} output ${output}`,exact:true}).press('Enter');
      await editor.getByRole('button',{name:`translator input ${input}`,exact:true}).press('Enter');
      await expect(editor.locator('#graph-errors')).toBeEmpty();
      await settleAutoSave(editor);
      await editor.reload();
      const saved=await editor.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
      expect(saved.edges).toContainEqual(edge(source,output,'translator',input));
    }
  }
});

test('MV3 direct ASR → TranslateGemma provisional/final uses production scheduler and direct committed history',async({graphExtension:f})=>{
  await writeFile(path.join(f.root,'web/translategemma-worker.js'),`
    self.onmessage=({data:m})=>{
      if(m.type==='load')postMessage({id:m.id,type:'ready'});
      if(m.type==='drain')postMessage({id:m.id,type:'drained'});
      if(m.type==='translate')setTimeout(()=>postMessage({id:m.id,type:'result',texts:['translated:'+m.text]}),20);
    };`);
  const live=await openGraph(f, { live: false });
  const graph=defaultGraph();graph.nodes.push(graphNode('TranslateGemmaEnJa','translator'),graphNode('TextAccumulator','acc'),graphNode('Display','translated'),graphNode('Display','preview'));
  graph.edges.push(edge('speech','provisional','translator','provisional'),edge('speech','final','translator','text'),
    edge('translator','text','acc','append'),edge('translator','provisionalText','preview','input1'),edge('acc','text','translated','input1'));
  const result=await live.evaluate(async graph=>{
    const {buildGraph}=await import('./graph-runtime.js');const displays={},events=[];
    const built=buildGraph((graph),{tabId:42,prepareTranslateGemma(){},onDisplay(id,dom){const text=dom.textContent;displays[id]=text;events.push({id,text});}});
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

test('MV3 Cancel retains committed snapshots on direct and formatted paths',async({graphExtension:f})=>{
  const live=await openGraph(f, { live: false });
  const result=await live.evaluate(async()=>{
    const {Pipeline}=await import('../web/pipeline.js');const {TEXT}=await import('../web/port-contracts.js');
    const {DisplayNode}=await import('../web/display-node.js');
    const {TextAccumulatorNode,TextFormatterNode}=await import('../web/text-nodes.js');let source;const states={};
    const acc=new TextAccumulatorNode(),pipeline=new Pipeline({nodes:{source:{outputs:{text:TEXT},start(c){source=c;}},acc,format:new TextFormatterNode({template:'[{1}]'}),
      direct:new DisplayNode(t=>{states.direct=t.textContent;}),indirect:new DisplayNode(t=>{states.indirect=t.textContent;})},connections:[
      {from:['source','text'],to:['acc','append']},{from:['acc','text'],to:['direct','input1']},{from:['acc','text'],to:['format','input1']},{from:['format','text'],to:['indirect','input1']}]});
    await pipeline.start();source.emit('text','keep');await pipeline.entries.get('acc').queue;
    await pipeline.entries.get('format').queue;
    source.emit('text','queued');await pipeline.cancel();source.emit('text','late');return states;
  });
  expect(result).toEqual({direct:'keep',indirect:'[keep]'});
});
