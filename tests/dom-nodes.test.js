import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, domText } from './fixtures/dom.js';
import { DOM, TEXT } from '../web/port-contracts.js';
import { Pipeline } from '../web/pipeline.js';
import { TextToDOMNode, PairedTextToDOMNode, DOMAccumulatorNode, cloneDOM } from '../web/dom-nodes.js';
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

test('paired formatter emits only one exact pair per atomic result and never retains history', () => {
  const snapshots = [], node = new PairedTextToDOMNode(), c = { ...ctx((_,dom) => snapshots.push(dom)), groupInputs: ['source','text','error'] };
  node.start(c); assert.equal(snapshots.length, 0);
  const values = [{ source:' same\n',text:' first ' },{ source:' same\n',text:'second',error:'' },{ source:'',text:'' },{ source:'failure',text:'stale',error:'<b>offline</b>' }];
  for (const value of values) node.receiveInputs(value,c);
  assert.deepEqual(snapshots.map(dom => [...dom.querySelectorAll('td')].map(cell => cell.textContent)),
    [[' same\n',' first '],[' same\n','second'],['',''],['failure','Translation failed: <b>offline</b>']]);
  assert.equal(Object.hasOwn(node,'rows'), false);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.querySelectorAll('tbody tr').length, 1);
    assert.equal(snapshot.querySelectorAll('td[tabindex="0"]').length, 2);
    assert.equal(snapshot.querySelector('thead,b'), null);
    for (const [index,cell] of [...snapshot.querySelectorAll('td')].entries()) assert.equal(cell.getAttribute('aria-label'),`${index ? 'Translation' : 'Original'}: ${cell.textContent}`);
  }
  for (const value of [{source:'independent'},{text:'independent'},{error:'independent'}]) assert.throws(() => node.receiveInputs(value,ctx()),/grouped/);
  node.receiveInputs({source:'late',text:'late'},{...c,signal:AbortSignal.abort()}); assert.equal(snapshots.length,4);
  node.receiveInputs({source:'no error wire'},{...c,groupInputs:['source','text']});
  assert.equal(domText(snapshots.at(-1)),'no error wire\nTranslation failed: No translation returned.');
  node.stop(); node.receiveInputs({source:'late',text:'late'},c); assert.equal(snapshots.length,5);
  node.cancel(); node.start(c); assert.equal(snapshots.length,5);
});

test('DOMAccumulator owns inert generic snapshots and emits independent ordered history including duplicates', () => {
  const snapshots = [], node = new DOMAccumulatorNode(), c = ctx((_,dom) => snapshots.push(dom));
  node.start(c); assert.equal(snapshots[0].childNodes.length,0);
  const input = document.createDocumentFragment(), text = document.createElement('pre');
  text.textContent = '<script>literal</script>\n  exact  '; input.append(text);
  node.receive('append',input,c); node.receive('append',input,c);
  node.receive('append',document.createTextNode('tail'),c);
  assert.equal(input.firstChild,text); assert.equal(input.childNodes.length,1);
  assert.equal(snapshots[1].childNodes.length,1); assert.equal(snapshots[2].childNodes.length,2);
  assert.equal(domText(snapshots[3]),text.textContent.repeat(2)+'tail');
  text.textContent='producer mutation'; snapshots[2].firstChild.textContent='consumer mutation';
  node.receive('append',document.createTextNode('!'),c);
  assert.equal(domText(snapshots.at(-1)),'<script>literal</script>\n  exact  '.repeat(2)+'tail!');
  const before = snapshots.length;
  const active = document.createElement('div'); active.setAttribute('onclick','alert(1)');
  const style = document.createElement('style'); style.textContent='@import "https://example.com";';
  for (const value of ['<b>HTML</b>',null,document.createElement('script'),document.createElement('img'),active,style]) assert.throws(()=>node.receive('append',value,c),/DOM/);
  assert.throws(()=>node.receive('dom',input,c),/append: DOM/);
  assert.equal(snapshots.length,before,'rejected inputs cannot change history');
  node.receive('append',input,{...c,signal:AbortSignal.abort()}); assert.equal(snapshots.length,before);
  node.stop(); node.receive('append',input,c); assert.equal(snapshots.length,before);
  node.cancel(); node.receive('append',input,c); assert.equal(snapshots.length,before);
  node.start(c); assert.equal(snapshots.at(-1).childNodes.length,0);
  node.receive('append',document.createTextNode('fresh'),c); assert.equal(domText(snapshots.at(-1)),'fresh');
  node.dispose(); node.receive('append',input,c); assert.equal(domText(snapshots.at(-1)),'fresh');
});

test('one formatter fans out to latest and accumulated displays with independent DOM ownership', async () => {
  let source; const latest = [], a = [], b = [], formatted = [], history = [];
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: {source: TEXT, text: TEXT, error: TEXT}, start(c) { source=c; } },
    pairs: new PairedTextToDOMNode(), acc: new DOMAccumulatorNode(),
    latest: new LiveTextDisplayNode(dom=>latest.push(dom)),
    a: new LiveTextDisplayNode(dom=>a.push(dom)), b: new LiveTextDisplayNode(dom=>b.push(dom)),
    formatted: {inputs: {dom: DOM}, receive(_,dom) {formatted.push(dom);}},
    history: {inputs: {dom: DOM}, receive(_,dom) {history.push(dom);}},
  }, connections: [
    ...['source','text','error'].map(port=>edge('source',port,'pairs',port)),
    edge('pairs','dom','acc','append'), edge('pairs','dom','latest','dom'), edge('pairs','dom','formatted','dom'),
    edge('acc','dom','a','dom'), edge('acc','dom','b','dom'), edge('acc','dom','history','dom'),
  ] });
  await pipeline.start();
  const values = [{source:' same\n',text:'日本語'}, {source:' same\n',text:'日本語'}, {source:'<script>source</script>',error:'<b>offline</b>'}, {source:'',text:''}];
  const expected = [];
  for (const value of values) {
    source.emitOutputs(value); await tick();
    expected.push([value.source,value.error ? `Translation failed: ${value.error}` : value.text]);
    assert.deepEqual([...latest.at(-1).querySelectorAll('td')].map(cell=>cell.textContent),expected.at(-1));
    for (const list of [a,b]) {
      assert.deepEqual([...list.at(-1).querySelectorAll('td')].map(cell=>cell.textContent),expected.flat());
      assert.equal(list.at(-1).querySelectorAll('tbody tr').length,expected.length);
      assert.equal(list.at(-1).querySelector('thead,script,b'),null);
    }
    assert.notEqual(a.at(-1),b.at(-1)); assert.notEqual(a.at(-1),history.at(-1));
    // Consumer/producer tree mutations cannot alter another display or future history.
    a.at(-1).querySelector('td').textContent='mounted mutation';
    formatted.at(-1).querySelector('td').textContent='producer mutation';
    history.at(-1).querySelector('td').textContent='snapshot mutation';
    assert.equal(b.at(-1).querySelector('td').textContent,expected[0][0]);
    assert.equal(latest.at(-1).querySelector('td').textContent,value.source);
  }
  await pipeline.stop(); assert.deepEqual(pipeline.errors,[]);
  const retained=b.at(-1); await pipeline.cancel(); source.emitOutputs({source:'late',text:'late'}); await tick();
  assert.equal(b.at(-1),retained);
});

test('typed graphs save explicit DOM history without rewriting direct v11 wiring and reject incompatible types', () => {
  const g = defaultGraph({enabled:true}); assert.deepEqual(validateGraph(g),[]);
  assert.equal(g.nodes.some(node => node.type === 'DOMAccumulator'),false);
  const direct = JSON.stringify(g), values = new Map([[GRAPH_KEY,direct]]);
  const storage = { getItem:key=>values.get(key)??null, setItem:(key,value)=>values.set(key,value), removeItem:key=>values.delete(key) };
  assert.deepEqual(readGraph(storage),assertGraph(g)); assert.equal(storage.getItem(GRAPH_KEY),direct);
  g.nodes.push(graphNode('DOMAccumulator','history'));
  g.edges = g.edges.filter(route => route.from[0] !== 'translated-format');
  g.edges.push(edge('translated-format','dom','history','append'),edge('history','dom','translated','dom'));
  assert.deepEqual(validateGraph(g),[]); saveGraph(storage,g); assert.deepEqual(readGraph(storage),assertGraph(g));
  const bad = structuredClone(g); bad.edges = bad.edges.filter(route=>route.to[0]!=='history'); bad.edges.push(edge('speech','final','history','append')); assert.match(validateGraph(bad).join(' '),/Incompatible/);
  assert.ok(g.nodes.some(node => node.type === 'TextToDOM')); assert.ok(g.nodes.some(node => node.type === 'PairedTextToDOM'));
  for (const port of ['dom','content']) {
    const invalid = structuredClone(g); invalid.edges = invalid.edges.filter(route => route.to[0] !== 'transcript');
    invalid.edges.push(edge('speech','final','transcript',port)); assert.match(validateGraph(invalid).join(' '),port === 'dom' ? /Incompatible/ : /Unknown port/);
  }
});

for (const reverse of [false, true]) test(`paired compatible drafts save with alternate producers, independent ports and either edge order (${reverse})`, () => {
  const graph = { version: defaultGraph().version, nodes: [graphNode('Text','literal'), graphNode('TextFormatter','alternate'),
    graphNode('PairedTextToDOM','pairs'), graphNode('LiveTextDisplay','display')], edges: [edge('literal','value','pairs','source')] };
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) };
  for (const routes of [[], [edge('alternate','text','pairs','text'),edge('pairs','dom','display','dom')]]) {
    graph.edges.push(...routes); if (reverse) graph.edges.reverse();
    assert.deepEqual(validateGraph(graph), []); saveGraph(storage,graph); assert.deepEqual(readGraph(storage),assertGraph(graph));
  }
});

for (const reverse of [false, true]) test(`paired consumer accepts alternate grouped producers and arbitrary output names (${reverse})`, async () => {
  let c; const pairs = new PairedTextToDOMNode(), snapshots = [];
  const connections = [edge('pairs','dom','snapshots','dom'),edge('alternate','original','pairs','source'),edge('alternate','translated','pairs','text'),edge('alternate','failure','pairs','error')];
  const pipeline = new Pipeline({ nodes: { alternate: { outputs: { original: TEXT, translated: TEXT, failure: TEXT }, start(context) { c = context; } }, pairs,
    snapshots: { inputs: {dom: DOM}, receive(_,dom) { snapshots.push(dom); } } },
    connections: reverse ? connections.reverse() : connections });
  await pipeline.start();
  for (const translated of ['one','two','']) {
    c.emitOutputs(reverse ? { translated, original: 'same', failure: '' } : { original: 'same', translated, failure: '' });
  }
  c.emitOutputs({ original: 'failed', failure: 'offline' });
  await pipeline.stop();
  assert.deepEqual(snapshots.map(domText), ['same\none','same\ntwo','same\n','failed\nTranslation failed: offline']);
  assert.deepEqual(pipeline.errors,[]); await pipeline.dispose();
});

for (const reverse of [false, true]) for (const mode of ['separate emissions','mixed producers','independent error','provisional']) {
  test(`paired consumer rejects ${mode} without affecting ordinary fan-out (${reverse})`, async () => {
    let a, b; const pairs = new PairedTextToDOMNode(), plain = [], snapshots = [];
    const connections = [edge('pairs','dom','snapshots','dom'),edge('a','s','pairs','source'),edge(mode === 'mixed producers' ? 'b' : 'a','t','pairs','text'),
      edge(mode === 'independent error' ? 'b' : 'a','e','pairs','error'),edge('a','t','plain','text')];
    const pipeline = new Pipeline({ nodes: {
      a: { outputs: { s: TEXT, t: TEXT, e: TEXT }, start(c) { a = c; } },
      b: { outputs: { t: TEXT, e: TEXT }, start(c) { b = c; } }, pairs,
      snapshots: { inputs: {dom: DOM}, receive(_,dom) { snapshots.push(dom); } },
      plain: { inputs: { text: TEXT }, receive(_,value) { plain.push(value); } },
    }, connections: reverse ? connections.reverse() : connections });
    await pipeline.start();
    if (mode === 'separate emissions') { a.emit('s','same'); a.emit('t','same'); }
    else {
      if (reverse) b.emitOutputs({t:'same',e:''});
      a.emitOutputs({s:'same',t:'same',e:''}, {provisional: mode === 'provisional'});
      if (!reverse) b.emitOutputs({t:'same',e:''});
    }
    await tick();
    assert.deepEqual(snapshots,[]); assert.equal(pipeline.errors.length,1);
    assert.match(pipeline.errors[0].message,mode === 'provisional' ? /provisional/ : /grouped/);
    a.emit('t','healthy'); await tick(); assert.deepEqual(plain,['same','healthy']);
    await pipeline.cancel(); assert.deepEqual(snapshots,[]);
  });
}

for (const history of [false, true]) for (const reverse of [false, true]) test(`real scheduler pairs FIFO results, drains Stop, freezes Cancel and resets Start (history=${history}, reversed=${reverse})`, async () => {
  const graph = defaultGraph({enabled:true}), workers = []; graph.nodes[0] = graphNode('Text','input');
  graph.nodes = graph.nodes.filter(node=>['input','translation','translated-format','translated'].includes(node.id));
  graph.edges = [edge('input','value','translation','text'), ...graph.edges.filter(route=>['translation','translated-format'].includes(route.from[0]))];
  if (history) {
    graph.nodes.push(graphNode('DOMAccumulator','history'));
    graph.edges = graph.edges.filter(route => route.from[0] !== 'translated-format');
    graph.edges.push(edge('translated-format','dom','history','append'),edge('history','dom','translated','dom'));
  }
  graph.nodes.push(graphNode('TextFormatter','inactive'));
  graph.edges.push(edge('inactive','text','translation','provisional'));
  if (reverse) graph.edges.reverse();
  assert.deepEqual(validateGraph(graph),[]);
  graph.nodes[0].settings.value = 'same'; const states = [];
  const build = () => buildGraph(graph,{onDisplay:(_,dom)=>states.push(dom), translationWorkerFactory() {
    const worker={postMessage(data) { if(data.type==='translate') { this.request=data; return; } queueMicrotask(()=>this.onmessage?.({data:{id:data.id,type:data.type==='load'?'ready':'drained'}})); },terminate(){this.closed=true;},reply(text){this.onmessage?.({data:{id:this.request.id,type:'result',texts:[text]}});}}; workers.push(worker); return worker;
  }});
  const built=build(); assert.equal(built.pipeline.entries.has('inactive'),false);
  await built.pipeline.start(); await tick(); workers[0].reply('one'); await tick();
  built.pipeline.entries.get('input').context.emit('value','same'); await tick();
  const stop=built.pipeline.stop(); await tick(); workers[0].reply('two'); await stop;
  assert.equal(domText(states.at(-1)),history ? 'same\none\nsame\ntwo' : 'same\ntwo'); await built.pipeline.dispose();
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
