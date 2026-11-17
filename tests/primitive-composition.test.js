import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { SpeechToTextMoonshineSmallJaNode as SpeechToTextNode } from '../web/moonshine-small-ja-node.js';
import { TextAccumulatorNode, TextFormatterNode } from '../web/text-nodes.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { NODE_TYPES, GRAPH_VERSION, graphNode, edge, validateGraph, saveGraph, readGraph, defaultGraph } from '../extension/graph.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const translators = ['TranslateGemma4B'];
const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };

// Exhaust all current TEXT producer ports, including ASR, summaries, formatters,
// accumulator outputs. Missing required inputs are saveable drafts.
for (const translator of translators) test(`${translator}: every TEXT producer connects in either order and reloads as a draft`, () => {
  for (const [type, definition] of Object.entries(NODE_TYPES)) for (const [port, contract] of Object.entries(definition.outputs)) {
    if (contract !== TEXT) continue;
    for (const ports of [['provisional', 'text'], ['text', 'provisional']]) {
      const graph = { version: GRAPH_VERSION, nodes: [graphNode(type, 'producer'), graphNode(translator, 'consumer')], edges: [] };
      for (const input of ports) {
        graph.edges.push(edge('producer', port, 'consumer', input));
        assert.deepEqual(validateGraph((graph)), [], `${type}.${port} → ${translator}.${input}`);
        const storage = store(); saveGraph(storage, (graph)); assert.deepEqual(readGraph(storage), graph);
      }
    }
  }
});

for (const translator of translators) test(`${translator}: direct ASR previews coalesce, finals stay FIFO including repeated equal text`, async () => {
  const f = workers(), displays = {};
  const graph = defaultGraph(); graph.nodes.push(graphNode(translator,'translator'), graphNode('TextAccumulator','acc'),graphNode('Display','translated'),graphNode('Display','preview'));
  graph.edges.push(edge('speech','provisional','translator','provisional'),edge('speech','final','translator','text'),
    edge('translator','provisionalText','preview','input1'),edge('translator','text','acc','append'),edge('acc','text','translated','input1'));
  const built = buildGraph((graph), { sourceFactory:()=>({start(){},stop(){}}), workerFactory:f.factory, translationWorkerFactory:f.factory, prepareTranslateGemma(){},onDisplay:(id,s)=>{ s = domText(s);displays[id]=s;} });
  try {
    await built.pipeline.start(); await built.translations[0].ready;
    const speech = built.speechNodes.get('speech');
    speech.receiveEvent({type:'partial',text:'old'}); await tick();
    speech.receiveEvent({type:'partial',text:'new'}); speech.receiveEvent({type:'partial',text:'latest'}); await tick();
    f.complete(0); await tick(); assert.equal(displays.translated,'');
    f.complete(1); await tick(); assert.equal(displays.preview,'translated:latest'); assert.equal(displays.translated,'');
    speech.receiveEvent({type:'final',text:'same',id:1}); speech.receiveEvent({type:'final',text:'same',id:2}); await tick();
    assert.equal(displays.translated,''); assert.equal(displays.preview,''); f.complete(2); await tick(); f.complete(3); await built.pipeline.stop();
    assert.equal(displays.translated,'translated:same\ntranslated:same'); assert.deepEqual(built.pipeline.errors,[]);
  } finally { await built.pipeline.dispose(); }
  assert.ok(f.owned.every(w=>w.terminated));
});

test('Cancel retains committed formatter/fan-out snapshots while rejecting queued and late results', async () => {
  const seen={}; let source; const acc=new TextAccumulatorNode();
  const pipeline=new Pipeline({nodes:{
    source:{outputs:{value:TEXT},start(c){source=c;}},acc,formatter:new TextFormatterNode({template:'[{1}]'}),
    direct:new TextSink(t=>{seen.direct=t;}),indirect:new TextSink(t=>{seen.indirect=t;}),
    ordinary:{inputs:{value:TEXT},receive(_,v){seen.ordinary=v;}},
  },connections:[edge('source','value','acc','append'),edge('acc','text','direct','input'),edge('acc','text','formatter','input1'),edge('formatter','text','indirect','input'),edge('acc','text','ordinary','value')]});
  await pipeline.start();source.emit('value','committed');await tick();
  source.emit('value','queued before Cancel');const cancel=pipeline.cancel();source.emit('value','late');await cancel;
  assert.deepEqual(seen,{direct:'committed',indirect:'[committed]',ordinary:'committed'});assert.equal(acc.committed,'committed');
});

for (const order of ['preview-first','final-first']) test(`grouped translator input ${order} commits only the final, including empty previews`, async () => {
  const {TranslationSchedulerNode}=await import('../extension/translation-scheduler.js');
  const f=workers(), results=[];let source;
  const pipeline=new Pipeline({nodes:{source:{outputs:{p:TEXT,f:TEXT},start(c){source=c;}},translator:new TranslationSchedulerNode({workerFactory:f.factory}),sink:{inputs:{text:TEXT},receive(_,text){results.push(text);}}},
    connections:[edge('source','p','translator','provisional'),edge('source','f','translator','text'),
      edge('translator','text','sink','text')]});
  await pipeline.start();source.emitOutputs(order==='preview-first'?{p:'',f:'final'}:{f:'final',p:''});await tick();
  assert.deepEqual(results,[]);assert.equal(f.requests.length,1);assert.equal(f.requests[0].text,'final');
  f.complete(0);await pipeline.stop();assert.deepEqual(results,['translated:final']);await pipeline.dispose();
});

test('Cancel closes field side effects while retaining committed accumulator text', async () => {
  const {FocusedInputTextOutputNode}=await import('../extension/page-output-node.js');
  const edits=[];let source;
  const acc=new TextAccumulatorNode(),field=new FocusedInputTextOutputNode({target:{tabId:42,documentId:'fixture'},connectionFactory:()=>({async request(action,data){if(action==='append')edits.push(data.text);return {inserted:true};},close(){}})});
  const pipeline=new Pipeline({nodes:{source:{outputs:{text:TEXT},start(c){source=c;}},acc,field},connections:[edge('source','text','acc','append'),edge('acc','text','field','text')]});
  await pipeline.start();source.emit('text','keep');await tick();const accepted=edits.slice();
  await pipeline.cancel();assert.deepEqual(edits,accepted);assert.equal(field.disposed,true);assert.equal(acc.committed,'keep');
});

test('Text literals and formatter/accumulator snapshots execute as independent translator previews', async () => {
  for (const type of ['Text','TextFormatter','TextAccumulator']) {
    const f=workers(),graph={version:GRAPH_VERSION,nodes:[graphNode('Text','final'),graphNode('Text','seed'),graphNode(type,'alternate'),graphNode('TranslateGemma4B','translator'),graphNode('Display','view'),graphNode('Display','preview')],
      edges:[edge('final','value','translator','text'),edge('translator','text','view','input1'),edge('translator','provisionalText','preview','input1')]};
    if(type!=='Text')graph.edges.push(edge('seed','value','alternate',type==='TextFormatter'?'input1':'append'));
    graph.edges.push(edge('alternate',type==='Text'?'value':'text','translator','provisional'));
    let display,preview;const built=buildGraph((graph),{translationWorkerFactory:f.factory,prepareTranslateGemma(){},onDisplay:(id,v)=>{ v = domText(v);if(id==='view')display=v;else preview=v;}});
    await built.pipeline.start();await tick();
    built.pipeline.entries.get(type==='Text'?'alternate':'seed').context.emit('value','preview');await tick();f.complete(0);await tick();
    assert.equal(preview,type === 'TextAccumulator' ? 'translated:\npreview' : 'translated:preview',type); assert.equal(display,'',type);
    built.pipeline.entries.get('final').context.emit('value','committed');await tick();f.complete(1);await tick();
    assert.equal(display,'translated:committed',type);await built.pipeline.stop();assert.deepEqual(built.pipeline.errors,[]);await built.pipeline.dispose();
  }
});

test('Committed translator text is an ordinary TEXT producer for another translator preview', async () => {
  const {windowGraph}=await import('./fixtures/windowed-translation.js');const f=workers(),graph=windowGraph('window');
  graph.nodes.find(n=>n.id==='window-chars').settings.value=6;
  graph.nodes.push(graphNode('Text','independent'),graphNode('TranslateGemma4B','second'),graphNode('Display','second-view'));
  graph.edges.push(edge('independent','value','second','text'),edge('translator','text','second','provisional'),edge('second','provisionalText','second-view','input1'));
  let display;const built=buildGraph((graph),{translationWorkerFactory:f.factory,prepareTranslateGemma(){},onDisplay:(id,v)=>{ v = domText(v);if(id==='second-view')display=v;}});
  await built.pipeline.start();await tick();built.pipeline.entries.get('input').context.emit('value','First.');await tick();f.complete(0);await tick();
  assert.equal(f.requests[1].text,'translated:First.');f.complete(1);await tick();assert.equal(display,'translated:translated:First.');
  await built.pipeline.stop();assert.deepEqual(built.pipeline.errors,[]);await built.pipeline.dispose();
});

class TextSink {
  inputs = { input: TEXT }; outputs = {};
  constructor(callback) { this.callback = callback; }
  start() { this.callback(''); }
  receive(_, text, context) { if (!context.signal.aborted) this.callback(text); }
}

function workers() {
  const requests = [], owned = [];
  const factory = () => {
    const w = { postMessage(m) {
      if (m.type === 'translate') requests.push({ ...m, w });
      if (['load', 'drain'].includes(m.type)) queueMicrotask(() => w.onmessage?.({data:{id:m.id,type:m.type === 'load' ? 'ready' : 'drained'}}));
      if (m.type === 'stop') queueMicrotask(() => w.onmessage?.({data:{type:'stopped',session:m.session}}));
    }, terminate() { this.terminated = true; } };
    owned.push(w); return w;
  };
  const complete = i => { const r = requests[i]; r.w.onmessage?.({data:{id:r.id,type:'result',texts:[`translated:${r.text}`]}}); };
  return { factory, requests, complete, owned };
}
