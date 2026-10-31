import { accumulateDisplay } from './fixtures/text-accumulator.js';
import { addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { SpeechToTextWhisperNode } from '../web/whisper-node.js';
import { TranslationCommitNode } from '../web/translation-commit-node.js';
import { TextAccumulatorNode, TextFormatterNode } from '../web/text-nodes.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { NODE_TYPES, GRAPH_VERSION, graphNode, edge, validateGraph, saveGraph, readGraph, defaultGraph } from '../extension/graph.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const translators = ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaEnJa', 'TranslateGemmaJaEn'];
const store = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k,v) => m.set(k,v), removeItem: k => m.delete(k) }; };

// Exhaust all current TEXT producer ports, including ASR, summaries, formatters,
// accumulators and commit outputs. Missing required inputs are saveable drafts.
for (const translator of translators) test(`${translator}: every TEXT producer connects in either order and reloads as a draft`, () => {
  for (const [type, definition] of Object.entries(NODE_TYPES)) for (const [port, contract] of Object.entries(definition.outputs)) {
    if (contract !== TEXT) continue;
    for (const ports of [['provisional', 'text'], ['text', 'provisional']]) {
      const graph = { version: GRAPH_VERSION, nodes: [graphNode(type, 'producer'), graphNode(translator, 'consumer')], edges: [] };
      for (const input of ports) {
        graph.edges.push(edge('producer', port, 'consumer', input));
        assert.deepEqual(validateGraph(addDOMFormatters(graph)), [], `${type}.${port} → ${translator}.${input}`);
        const storage = store(); saveGraph(storage, addDOMFormatters(graph)); assert.deepEqual(readGraph(storage), graph);
      }
    }
  }
});

test('TranslationCommit and startup settings accept every contract-compatible edge in incomplete drafts', () => {
  for (const [type, definition] of Object.entries(NODE_TYPES)) for (const [port, contract] of Object.entries(definition.outputs)) {
    for (const [target, inputs] of [['TranslationCommit', ['boundary', 'source', 'text', 'error']], ['SpeechToTextWhisper', ['language']], ['SpeechToTextReazonSpeech', ['maxDuration']]]) {
      for (const input of inputs) if (NODE_TYPES[target].inputs[input] === contract) {
        const graph = { version: GRAPH_VERSION, nodes: [graphNode(type,'producer'),graphNode(target,'consumer')], edges:[edge('producer',port,'consumer',input)] };
        assert.deepEqual(validateGraph(addDOMFormatters(graph)), [], `${type}.${port} → ${target}.${input}`);
      }
    }
  }
});

function workers() {
  const requests = [], owned = [];
  const factory = () => {
    const w = { postMessage(m) {
      if (m.type === 'translate') requests.push({ ...m, w });
      if (['load', 'drain'].includes(m.type)) queueMicrotask(() => w.onmessage?.({data:{id:m.id,type:m.type === 'load' ? 'ready' : 'drained'}}));
      if (m.type === 'vad-stop') queueMicrotask(() => w.onmessage?.({data:{type:'vad-stopped',session:m.session}}));
    }, terminate() { this.terminated = true; } };
    owned.push(w); return w;
  };
  const complete = i => { const r = requests[i]; r.w.onmessage?.({data:{id:r.id,type:'result',texts:[`translated:${r.text}`]}}); };
  return { factory, requests, complete, owned };
}

for (const translator of translators) test(`${translator}: direct ASR previews coalesce, finals stay FIFO and boundary matching survives equal text`, async () => {
  const f = workers(), displays = {};
  const graph = defaultGraph(); graph.nodes.push(graphNode(translator,'translator'), graphNode('TranslationCommit','commit'), graphNode('TextAccumulator','acc'),graphNode('LiveTextDisplay','translated'),graphNode('LiveTextDisplay','preview'));
  graph.edges.push(edge('speech','provisional','translator','provisional'),edge('speech','final','translator','text'),edge('speech','final','commit','boundary'),
    ...['source','text','error'].map(p => edge('translator',p,'commit',p)),edge('translator','provisionalText','preview','content'),edge('commit','final','acc','append'),edge('acc','text','translated','content'));
  const built = buildGraph(addDOMFormatters(graph), { sourceFactory:()=>({start(){},stop(){}}), workerFactory:f.factory, translationWorkerFactory:f.factory, prepareTranslation(){},prepareTranslateGemma(){},onDisplay:(id,s)=>{ s = domText(s);displays[id]=s;} });
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

for (const mismatch of ['equal independent event', 'different value', 'split atomic result']) test(`TranslationCommit visibly rejects ${mismatch}`, async () => {
  let a,b; const results=[];
  const commit = new TranslationCommitNode();
  const pipeline = new Pipeline({nodes:{
    a:{outputs:{value:TEXT},start(c){a=c;}}, b:{outputs:{value:TEXT},start(c){b=c;}},
    processor:{inputs:{value:TEXT},outputs:{s:TEXT,t:TEXT,e:TEXT},receive(_,value,c){
      if(mismatch==='split atomic result'){ c.emit('s',value); c.emit('t','translation'); c.emit('e',''); }
      else c.emitOutputs({s:mismatch==='different value'?'other':value,t:'translation',e:''});
    }},commit, sink:{inputs:{value:TEXT},receive(_,v){results.push(v);}},
  },connections:[edge('a','value','commit','boundary'),edge(mismatch==='equal independent event'?'b':'a','value','processor','value'),
    edge('processor','s','commit','source'),edge('processor','t','commit','text'),edge('processor','e','commit','error'),edge('commit','final','sink','value')]});
  await pipeline.start(); a.emit('value','same'); if(mismatch==='equal independent event')b.emit('value','same'); await tick();
  assert.equal(pipeline.errors.length,1); assert.match(pipeline.errors[0].message,/does not match|grouped/); assert.deepEqual(results,[]);
  await pipeline.dispose();
});

for (const kind of ['number','language']) test(`${kind}: arbitrary startup producer, bounded wait, consumer validation and late value rejection`, async () => {
  const f=workers(), speech=kind==='number'?new SpeechToTextNode({workerFactory:f.factory}):new SpeechToTextWhisperNode({workerFactory:f.factory});
  const port=kind==='number'?'maxDuration':'language'; let config,audio;
  const pipeline=new Pipeline({nodes:{
    settings:{outputs:{arbitrary:kind==='number'?NUMBER:TEXT},start(c){config=c;}},
    audio:{outputs:{audio:speech.inputs.audio},start(c){audio=c;}},speech,
    sink:{inputs:{value:TEXT},receive(){}},
  },connections:[edge('settings','arbitrary','speech',port),edge('audio','audio','speech','audio'),edge('speech','final','sink','value')]});
  await pipeline.start(); assert.equal(f.owned.length,0);
  audio.emit('audio',new Float32Array(37)); await tick(); assert.equal(speech.pendingSamples,37);
  config.emit('arbitrary',kind==='number'?2.5:'ja'); await tick();
  assert.equal(f.owned.length,2); assert.equal(speech.core.state,'running'); assert.equal(speech.pendingSamples,0);
  if(kind==='number')assert.equal(speech.core.simulation.maxSamples,40000); else assert.equal(speech.core.language,'ja');
  config.emit('arbitrary',kind==='number'?3:'en'); await tick();
  assert.match(pipeline.errors[0].message,/before .*startup|before model loading/); await pipeline.dispose();
});

for (const kind of ['number','language']) for (const finish of ['stop','overload']) test(`${kind}: missing startup value ${finish} fails visibly without model loading or default fallback`, async () => {
  const f=workers(), speech=kind==='number'?new SpeechToTextNode({workerFactory:f.factory}):new SpeechToTextWhisperNode({workerFactory:f.factory});
  const port=kind==='number'?'maxDuration':'language';
  const c={signal:new AbortController().signal,connectedInputs:[port],fail(){}};
  speech.start(c); assert.equal(f.owned.length,0);
  if(finish==='stop')assert.throws(()=>speech.stop(),/unavailable/);
  else assert.throws(()=>speech.receive('audio',new Float32Array(480001)),/unavailable/);
  assert.equal(f.owned.length,0); speech.dispose();
});

test('an inactive configured producer never silently selects an ASR default', async () => {
  const graph=defaultGraph(); graph.nodes.push(graphNode('TextFormatter','unready'),graphNode('SpeechToTextWhisper','unready-asr'));
  graph.nodes[1].type='SpeechToTextWhisper'; graph.edges=graph.edges.filter(e=>e.from[1]!=='provisional');
  graph.edges.push(edge('unready-asr','final','unready','input1'),edge('unready','text','speech','language'));
  const f=workers(), built=buildGraph(addDOMFormatters(graph),{whisperWorkerFactory:f.factory,sourceFactory:()=>({start(){},stop(){}})});
  await built.pipeline.start(); assert.equal(f.owned.length,0);
  await assert.rejects(built.pipeline.stop(),/unavailable/); await built.pipeline.dispose();
});

test('Cancel retains committed formatter/fan-out snapshots while rejecting queued and late results', async () => {
  const seen={}; let source; const acc=new TextAccumulatorNode();
  const pipeline=new Pipeline({nodes:{
    source:{outputs:{value:TEXT},start(c){source=c;}},acc,formatter:new TextFormatterNode({template:'[{1}]'}),
    direct:new TextSink(t=>{seen.direct=t;}),indirect:new TextSink(t=>{seen.indirect=t;}),
    ordinary:{inputs:{value:TEXT},receive(_,v){seen.ordinary=v;}},
  },connections:[edge('source','value','acc','append'),edge('acc','text','direct','content'),edge('acc','text','formatter','input1'),edge('formatter','text','indirect','content'),edge('acc','text','ordinary','value')]});
  await pipeline.start();source.emit('value','committed');await tick();
  source.emit('value','queued before Cancel');const cancel=pipeline.cancel();source.emit('value','late');await cancel;
  assert.deepEqual(seen,{direct:'committed',indirect:'[committed]',ordinary:'committed'});assert.equal(acc.committed,'committed');
});

for (const order of ['preview-first','final-first']) test(`grouped translator input ${order} commits only the final, including empty previews`, async () => {
  const {TranslationSchedulerNode}=await import('../extension/translation-scheduler.js');
  const f=workers(), results=[];let source;
  const pipeline=new Pipeline({nodes:{source:{outputs:{p:TEXT,f:TEXT},start(c){source=c;}},translator:new TranslationSchedulerNode({workerFactory:f.factory}),commit:new TranslationCommitNode(),sink:{inputs:{text:TEXT},receive(_,text){results.push(text);}}},
    connections:[edge('source','p','translator','provisional'),edge('source','f','translator','text'),edge('source','f','commit','boundary'),
      ...['source','text','error'].map(p=>edge('translator',p,'commit',p)),edge('commit','final','sink','text')]});
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
    const f=workers(),graph={version:GRAPH_VERSION,nodes:[graphNode('Text','final'),graphNode('Text','seed'),graphNode(type,'alternate'),graphNode('TranslateGemmaEnJa','translator'),graphNode('LiveTextDisplay','view'),graphNode('LiveTextDisplay','preview')],
      edges:[edge('final','value','translator','text'),edge('translator','text','view','content'),edge('translator','provisionalText','preview','content')]};
    if(type!=='Text')graph.edges.push(edge('seed','value','alternate',type==='TextFormatter'?'input1':'append'));
    graph.edges.push(edge('alternate',type==='Text'?'value':'text','translator','provisional'));
    let display,preview;const built=buildGraph(addDOMFormatters(graph),{translationWorkerFactory:f.factory,prepareTranslateGemma(){},onDisplay:(id,v)=>{ v = domText(v);if(id==='view')display=v;else preview=v;}});
    await built.pipeline.start();await tick();
    built.pipeline.entries.get(type==='Text'?'alternate':'seed').context.emit('value','preview');await tick();f.complete(0);await tick();
    assert.equal(preview,type === 'TextAccumulator' ? 'translated:\npreview' : 'translated:preview',type); assert.equal(display,'',type);
    built.pipeline.entries.get('final').context.emit('value','committed');await tick();f.complete(1);await tick();
    assert.equal(display,'translated:committed',type);await built.pipeline.stop();assert.deepEqual(built.pipeline.errors,[]);await built.pipeline.dispose();
  }
});

test('TranslationCommit final is an ordinary TEXT producer for another translator preview', async () => {
  const {windowGraph}=await import('./fixtures/windowed-translation.js');const f=workers(),graph=windowGraph('revisable');
  graph.nodes.find(n=>n.id==='window-chars').settings.value=6;
  graph.nodes.push(graphNode('Text','independent'),graphNode('TranslateGemmaEnJa','second'),graphNode('LiveTextDisplay','second-view'));
  graph.edges.push(edge('independent','value','second','text'),edge('commit','final','second','provisional'),edge('second','provisionalText','second-view','content'));
  let display;const built=buildGraph(addDOMFormatters(graph),{translationWorkerFactory:f.factory,prepareTranslateGemma(){},onDisplay:(id,v)=>{ v = domText(v);if(id==='second-view')display=v;}});
  await built.pipeline.start();await tick();built.pipeline.entries.get('input').context.emit('value','First.');await tick();f.complete(0);await tick();
  assert.equal(f.requests[1].text,'translated:First.');f.complete(1);await tick();assert.equal(display,'translated:translated:First.');
  await built.pipeline.stop();assert.deepEqual(built.pipeline.errors,[]);await built.pipeline.dispose();
});

test('session retains inactive configuration intent, shows waiting and loads no default model', async () => {
  const {TabSession}=await import('../extension/session.js');const f=workers(),graph=defaultGraph();
  graph.nodes[1].type='SpeechToTextWhisper';graph.edges=graph.edges.filter(e=>e.from[1]!=='provisional');
  graph.nodes.push(graphNode('TextFormatter','unready'),graphNode('SpeechToTextWhisper','unready-asr'));
  graph.edges.push(edge('unready-asr','final','unready','input1'),edge('unready','text','speech','language'));
  const session=new TabSession(()=>{},{graph,whisperWorkerFactory:f.factory,sourceFactory:()=>({start(){},stop(){}})});
  await session.start(42);assert.equal(f.owned.length,0);assert.match(session.view.signal,/speech: Waiting for startup language/);
  await session.stop();assert.match(session.view.error,/language unavailable/);await session.cancel();
});

class TextSink {
  inputs = { content: TEXT }; outputs = {};
  constructor(callback) { this.callback = callback; }
  start() { this.callback(''); }
  receive(_, text, context) { if (!context.signal.aborted) this.callback(text); }
}
