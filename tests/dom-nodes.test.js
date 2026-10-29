import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, domText } from './fixtures/dom.js';
import { DOM, TEXT } from '../web/port-contracts.js';
import { Pipeline } from '../web/pipeline.js';
import { TextToDOMNode, PairedTextToDOMNode, cloneDOM } from '../web/dom-nodes.js';
import { LiveTextDisplayNode } from '../web/text-nodes.js';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const ctx = (emit = () => {}) => ({ signal: new AbortController().signal, emit });

test('TEXT → DOM snapshots preserve exact literal values, including empty updates; sink ownership and fan-out', async () => {
  let emit; const a = [], b = [], emitted = [];
  const formatter = new TextToDOMNode();
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(c) { emit = c.emit; } }, formatter,
    a: new LiveTextDisplayNode(dom => a.push(dom)), b: new LiveTextDisplayNode(dom => b.push(dom)),
    observer: { inputs: { dom: DOM }, receive(_, dom) { emitted.push(dom); } },
  }, connections: [edge('source','text','formatter','text'), ...['a','b','observer'].map(id => edge('formatter','dom',id,'dom'))] });
  await pipeline.start();
  const values = ['  <script>alert(1)</script>\n\t<img src=x onerror=alert(1)>  ', 'same', 'same', ''];
  for (const text of values) emit('text', text);
  await pipeline.stop();
  assert.deepEqual(a.slice(1).map(domText), values); assert.deepEqual(b.slice(1).map(domText), values);
  for (let i = 0; i < values.length; i++) {
    assert.notEqual(a[i+1], b[i+1]); assert.notEqual(a[i+1], emitted[i]);
    assert.equal(a[i+1].querySelector('script,img'), null);
    assert.equal(a[i+1].style.whiteSpace, 'pre-wrap');
  }
  emitted[0].textContent = 'mutated'; assert.equal(domText(a[1]), values[0]);
  a[1].textContent = 'consumer mutation'; assert.equal(domText(b[1]), values[0]);
  const latest = a.at(-1); await pipeline.cancel(); emit('text','late'); await tick(); assert.equal(a.at(-1), latest);
  assert.deepEqual(pipeline.errors, []);
});

test('DOM accepts fragments and text nodes, clones before mounting, and rejects strings and active content', () => {
  const c = ctx(), states = [], sink = new LiveTextDisplayNode(dom => states.push(dom));
  assert.deepEqual(sink.inputs, { dom: DOM }); assert.equal(Object.hasOwn(sink.inputs,'content'), false);
  sink.start(); assert.equal(states[0].childNodes.length, 0);
  const fragment = document.createDocumentFragment(); fragment.append(document.createTextNode('literal'));
  sink.receive('dom', fragment, c); const root = document.createElement('div'); root.append(states.at(-1));
  assert.equal(fragment.childNodes.length, 1); assert.equal(fragment.firstChild.data,'literal'); assert.equal(root.textContent,'literal');
  assert.equal(cloneDOM(document.createTextNode('text')).data,'text');
  for (const value of ['<b>bad</b>', null, { nodeType: 1, cloneNode() {} }, document.createElement('script'), document.createElement('iframe'), document.createElement('img'), document.createElement('custom-element')]) assert.throws(() => sink.receive('dom',value,c), /DOM/);
  const event = document.createElement('div'); event.setAttribute('onclick','alert(1)'); assert.throws(() => cloneDOM(event),/attribute/);
  for (const css of ['@import "https://example.com";', 'div { background: url(https://example.com); }']) {
    const style = document.createElement('style'); style.textContent = css; assert.throws(() => cloneDOM(style), /resources/);
  }
  assert.throws(() => sink.receive('content','old TEXT',c),/dom: DOM/);
});

test('paired formatter commits only atomic groups, preserves duplicates/order/exact empties and clears stale success on error', () => {
  const snapshots = [], node = new PairedTextToDOMNode(), c = { ...ctx((_,dom) => snapshots.push(dom)), groupInputs: ['source','text','error'] };
  node.start(c); assert.equal(snapshots[0].querySelectorAll('tbody tr').length,0);
  const values = [{ source:' same\n',text:' first ' },{ source:' same\n',text:'second',error:'' },{ source:'',text:'' },{ source:'failure',text:'stale',error:'<b>offline</b>' }];
  for (const value of values) node.receiveInputs(value,c);
  assert.deepEqual(node.rows, [{source:' same\n',text:' first ',error:''},{source:' same\n',text:'second',error:''},{source:'',text:'',error:''},{source:'failure',text:'',error:'<b>offline</b>'}]);
  assert.equal(snapshots[1].querySelectorAll('tbody tr').length,1,'old snapshots are immutable');
  const last = snapshots.at(-1); assert.equal(last.querySelector('b'),null);
  assert.equal(last.querySelectorAll('td[tabindex="0"]').length,8);
  for (const value of [{source:'independent'},{text:'independent'},{error:'independent'}]) assert.throws(() => node.receiveInputs(value,ctx()),/grouped/);
  node.receiveInputs({source:'late',text:'late'},{...c,signal:AbortSignal.abort()}); assert.equal(node.rows.length,4);
  node.receiveInputs({source:'no error wire'},{...c,groupInputs:['source','text']}); assert.equal(node.rows.at(-1).error,'No translation returned.');
  node.stop(); node.receiveInputs({source:'late',text:'late'},c); assert.equal(node.rows.length,5);
  node.cancel(); assert.equal(node.rows.length,5); node.start(c); assert.equal(node.rows.length,0);
});

test('typed graphs accept both DOM processors, reject TEXT and legacy display inputs, mixed producers and provisional pairing', () => {
  const g = defaultGraph({enabled:true}); assert.deepEqual(validateGraph(g),[]);
  assert.ok(g.nodes.some(node => node.type === 'TextToDOM')); assert.ok(g.nodes.some(node => node.type === 'PairedTextToDOM'));
  for (const port of ['dom','content']) {
    const invalid = structuredClone(g); invalid.edges = invalid.edges.filter(route => route.to[0] !== 'transcript');
    invalid.edges.push(edge('speech','final','transcript',port)); assert.match(validateGraph(invalid).join(' '),port === 'dom' ? /Incompatible/ : /Unknown port/);
  }
  const mixed = structuredClone(g); mixed.edges.find(route=>route.to[0]==='translated-format' && route.to[1]==='source').from=['speech','final'];
  assert.match(validateGraph(mixed).join(' '),/one translator/);
  g.edges.push(edge('speech','provisional','translation','provisional')); assert.match(validateGraph(g).join(' '),/committed translation only/);
});

test('real production scheduler graph pairs FIFO results, drains Stop, keeps committed rows on Cancel and rejects stale workers', async () => {
  const graph = defaultGraph({enabled:true}), workers = []; graph.nodes[0] = graphNode('Text','input');
  graph.nodes = graph.nodes.filter(node=>['input','translation','translated-format','translated'].includes(node.id));
  graph.edges = [edge('input','value','translation','text'), ...graph.edges.filter(route=>['translation','translated-format'].includes(route.from[0]))];
  graph.nodes[0].settings.value = 'same'; const states = [];
  const build = () => buildGraph(graph,{onDisplay:(_,dom)=>states.push(dom), translationWorkerFactory() {
    const worker={postMessage(data) { if(data.type==='translate') { this.request=data; return; } queueMicrotask(()=>this.onmessage?.({data:{id:data.id,type:data.type==='load'?'ready':'drained'}})); },terminate(){this.closed=true;},reply(text){this.onmessage?.({data:{id:this.request.id,type:'result',texts:[text]}});}}; workers.push(worker); return worker;
  }});
  const built=build(); await built.pipeline.start(); await tick(); workers[0].reply('one'); await tick();
  built.pipeline.entries.get('input').context.emit('value','same'); await tick();
  const stop=built.pipeline.stop(); await tick(); workers[0].reply('two'); await stop;
  assert.equal(domText(states.at(-1)),'same\none\nsame\ntwo'); await built.pipeline.dispose();
  const fresh=build(); await fresh.pipeline.start(); await tick(); assert.equal(states.at(-1).querySelectorAll?.('tbody tr')?.length ?? 0,0);
  workers[1].reply('committed'); await tick(); fresh.pipeline.entries.get('input').context.emit('value','pending'); await tick();
  await fresh.pipeline.cancel(); const committed=states.at(-1); workers[1].reply('stale'); await tick();
  assert.equal(states.at(-1),committed); assert.equal(domText(committed),'same\ncommitted'); assert.ok(workers.every(worker=>worker.closed));
});

test('v10 requires reviewed conversion and keeps exact saved original, unrelated branches, collision IDs and older recovery copies', () => {
  const old=defaultGraph(); old.version=10;
  old.nodes=old.nodes.filter(node=>node.id!=='transcript-dom'); old.edges=old.edges.filter(route=>route.from[0]!=='transcript-dom'&&route.to[0]!=='transcript-dom');
  old.nodes.push(graphNode('Text','transcript-dom'),graphNode('FocusedInputTextOutputNode','field'));
  old.edges.push(edge('speech','final','field','text'),edge('transcript-accumulator','text','transcript','content'));
  const original=JSON.stringify(old,null,2), values=new Map([[GRAPH_KEY,original],['processing-graph-before-v10','older']]);
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  let draft; assert.throws(()=>readGraph(storage),error=>{draft=error.recoveryGraph;return /v11 requires review/.test(error.message);});
  assert.equal(storage.getItem(GRAPH_KEY),original); assert.throws(()=>buildGraph(old,{}),/requires review/);
  assert.deepEqual(draft.nodes.slice(0,old.nodes.length),old.nodes); assert.ok(draft.nodes.some(node=>node.id==='transcript-dom-2'&&node.type==='TextToDOM'));
  assert.ok(draft.edges.some(route=>JSON.stringify(route)===JSON.stringify(edge('speech','final','field','text'))));
  saveGraph(storage,draft); assert.deepEqual(readGraph(storage),assertGraph(draft));
  assert.equal(storage.getItem(GRAPH_RECOVERY_KEY),original); assert.equal(storage.getItem('processing-graph-before-v10'),'older');
});

test('resetting a graph with legacy TEXT routes mislabeled as current version retains its exact original', () => {
  const invalid=defaultGraph();invalid.edges.at(-1).to[1]='content';
  const original=JSON.stringify(invalid),values=new Map([[GRAPH_KEY,original]]);
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
  assert.throws(()=>readGraph(storage),/Unknown port/);saveGraph(storage,defaultGraph());
  assert.equal(storage.getItem(GRAPH_RECOVERY_KEY),original);
});
