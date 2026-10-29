import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document } from './fixtures/dom.js';
import { DOM } from '../web/port-contracts.js';
import { DOMCombinerNode } from '../web/dom-nodes.js';
import { Pipeline } from '../web/pipeline.js';
import { LiveTextDisplayNode } from '../web/text-nodes.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { edge, validateGraph, saveGraph, readGraph } from '../extension/graph.js';
import { livePreviewGraph } from './fixtures/live-preview-graph.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = dom => { const copy = dom.cloneNode(true); for (const style of copy.querySelectorAll('style')) style.remove(); return [...copy.childNodes].map(n => n.textContent).join(''); };

for (const order of [['first', 'second'], ['second', 'first']]) test(`DOMCombiner replaces and clears independent owned snapshots (${order})`, () => {
  const node = new DOMCombinerNode(), snapshots = [], c = { signal: new AbortController().signal, emit: (_, dom) => snapshots.push(dom) };
  assert.deepEqual(node.inputs, { first: DOM, second: DOM }); assert.deepEqual(node.outputs, { dom: DOM });
  node.start(c); assert.equal(text(snapshots.at(-1)), '');
  node.receive(order[0], document.createDocumentFragment(), c); assert.equal(snapshots.at(-1).childNodes.length, 0);
  const input = document.createDocumentFragment(), style = document.createElement('style'); style.textContent = 'pre { color: red; }';
  input.append(style, document.createTextNode('A'));
  node.receive(order[0], input, c); input.lastChild.textContent = 'B'; node.receive(order[1], input, c);
  assert.equal(text(snapshots.at(-1)), order[0] === 'first' ? 'AB' : 'BA'); assert.equal(input.childNodes.length, 2);
  input.lastChild.textContent = 'producer mutation'; snapshots.at(-1).lastChild.textContent = 'consumer mutation';
  node.receive('second', document.createTextNode('C'), c); assert.equal(text(snapshots.at(-1)), (order[0] === 'first' ? 'A' : 'B') + 'C');
  node.receive('second', document.createTextNode('C'), c); assert.equal(snapshots.at(-1).querySelectorAll('style').length, 1);
  node.receive('first', document.createDocumentFragment(), c); assert.equal(text(snapshots.at(-1)), 'C');
  const before = snapshots.length;
  for (const invalid of ['html', null, document.createElement('script'), document.createElement('img')]) assert.throws(() => node.receive('second', invalid, c), /DOM/);
  const css = document.createElement('style'); css.textContent = '@import "bad";'; assert.throws(() => node.receive('second', css, c), /resources/);
  assert.throws(() => node.receive('append', input, c), /first\/second/); assert.equal(snapshots.length, before);
  node.receive('second', input, { ...c, signal: AbortSignal.abort() }); assert.equal(snapshots.length, before);
  for (const close of ['stop', 'cancel', 'dispose']) {
    node[close](); node.receive('second', input, c); assert.equal(snapshots.length, before);
  }
  node.start(c); assert.equal(text(snapshots.at(-1)), '');
  node.receive('second', document.createTextNode('fresh'), c); assert.equal(text(snapshots.at(-1)), 'fresh');
  node.receive('second', document.createDocumentFragment(), c); assert.equal(snapshots.at(-1).childNodes.length, 0);
});

test('DOMCombiner runtime owns retained snapshots and fan-out sinks own independent clones', async () => {
  let source; const a = [], b = [];
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { dom: DOM }, start(c) { source = c; } }, combined: new DOMCombinerNode(),
    a: new LiveTextDisplayNode(dom => a.push(dom)), b: new LiveTextDisplayNode(dom => b.push(dom)),
  }, connections: [edge('source', 'dom', 'combined', 'first'), ...['a', 'b'].map(id => edge('combined', 'dom', id, 'dom'))] });
  await pipeline.start(); source.emit('dom', document.createTextNode('same')); await tick();
  assert.notEqual(a.at(-1), b.at(-1)); a.at(-1).firstChild.textContent = 'mutation'; assert.equal(text(b.at(-1)), 'same');
  await pipeline.stop(); const retained = b.at(-1); source.emit('dom', document.createTextNode('late')); await tick(); assert.equal(b.at(-1), retained);
  await pipeline.cancel(); assert.deepEqual(pipeline.errors, []);
});

for (const reverse of [false, true]) test(`saved full ASR/translation graph clears preview before delayed finals, preserves newer speech and drains/restarts (${reverse})`, async () => {
  const graph = livePreviewGraph(); if (reverse) graph.edges.reverse();
  assert.deepEqual(validateGraph(graph), []);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
  for (const port of ['first', 'second']) {
    const bad = structuredClone(graph); bad.edges = bad.edges.filter(route => route.to[1] !== port);
    bad.edges.push(edge('speech', 'final', 'combined', port)); assert.match(validateGraph(bad).join(' '), /Incompatible/);
  }
  const requests = [], states = [], workers = [];
  const factory = () => {
    const worker = { postMessage(m) {
      if (m.type === 'translate') { requests.push({ receive: worker.onmessage, ...m }); return; }
      if (['load', 'drain', 'stop'].includes(m.type)) queueMicrotask(() => worker.onmessage?.({ data: { id: m.id, session: m.session, type: m.type === 'load' ? 'ready' : m.type === 'stop' ? 'stopped' : 'drained' } }));
    }, terminate() { this.closed = true; } }; workers.push(worker); return worker;
  };
  const build = () => buildGraph(graph, { sourceFactory: () => ({ start() {}, stop() {} }), zipformerWorkerFactory: factory, translationWorkerFactory: factory, onDisplay: (_, dom) => states.push(dom) });
  const built = build(); await built.pipeline.start(); await built.translations[0].ready;
  const speech = built.speechNodes.get('speech');
  const preview = value => speech.receiveEvent({ type: 'partial', text: value });
  const final = id => speech.receiveEvent({ type: 'final', id, text: 'same' });
  const reply = (index, error = false) => { const r = requests[index]; r.receive({ data: { id: r.id, ...(error ? { type: 'error', message: 'offline' } : { type: 'result', texts: ['日本語'] }) } }); };
  preview('<script>literal</script>'); await tick(); assert.equal(text(states.at(-1)), '<script>literal</script>'); assert.equal(states.at(-1).querySelector('script'), null);
  final(0); await tick(); assert.equal(text(states.at(-1)), ''); assert.equal(requests.length, 1);
  preview('new preview'); await tick(); reply(0); await tick(); assert.equal(text(states.at(-1)), 'same日本語new preview');
  final(0); await tick(); assert.equal(text(states.at(-1)), 'same日本語new preview', 'duplicate finals must not clear newer preview');
  final(1); await tick(); assert.equal(text(states.at(-1)), 'same日本語');
  const stop = built.pipeline.stop(); await tick(); reply(1); await stop;
  assert.equal(states.at(-1).querySelectorAll('tr').length, 2); assert.equal(text(states.at(-1)), 'same日本語same日本語');
  await built.pipeline.dispose();
  const fresh = build(); await fresh.pipeline.start(); await fresh.translations[0].ready; assert.equal(text(states.at(-1)), '');
  const next = fresh.speechNodes.get('speech'); next.receiveEvent({ type: 'final', id: 0, text: 'fail' }); await tick();
  next.receiveEvent({ type: 'partial', text: 'new after failure' }); reply(2, true); await tick();
  assert.match(text(states.at(-1)), /failTranslation failed: .*offlinenew after failure/);
  await fresh.pipeline.cancel(); assert.deepEqual(fresh.pipeline.errors, []);
  const canceled = build(); await canceled.pipeline.start(); await canceled.translations[0].ready;
  canceled.speechNodes.get('speech').receiveEvent({ type: 'partial', text: 'discard' });
  canceled.speechNodes.get('speech').receiveEvent({ type: 'final', id: 0, text: 'pending' }); await tick();
  assert.equal(text(states.at(-1)), ''); assert.equal(requests.length, 4);
  await canceled.pipeline.cancel(); const retained = states.at(-1); reply(3); await tick(); assert.equal(states.at(-1), retained);
  assert.ok(workers.every(w => w.closed)); assert.deepEqual(canceled.pipeline.errors, []);
});
