import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document } from './fixtures/dom.js';
import { keyedTextGraph } from './fixtures/keyed-text-graph.js';
import { itemGraph } from './fixtures/item-graph.js';
import { viewGraph } from './fixtures/view-graph.js';
import { keyedDOMGraph } from './fixtures/keyed-dom-graph.js';
import { NUMBER, TEXT, VIEW, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST } from '../web/port-contracts.js';
import { TextDisplayNode } from '../web/text-display-node.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { renderTextRegions } from '../extension/live-text-regions.js';
import { NODE_TYPES, validateGraph, graphWarnings, executableGraph, saveGraph, readGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY } from '../extension/graph.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const cells = dom => [...dom.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent));
function fixture(connectedInputs, node) {
  const out = [], controller = new AbortController();
  node ??= new TextDisplayNode(dom => out.push(dom));
  node.onDisplay = dom => out.push(dom);
  const context = { signal: controller.signal, connectedInputs };
  node.start(context);
  return { node, context, out, controller, send: v => node.receiveInputs(v, context) };
}
test('one or both TEXT inputs, latest unkeyed snapshots, explicit clears and safe literal browser rendering', () => {
  for (const port of ['input1', 'input2']) {
    const f = fixture([port]);
    assert.deepEqual(f.node.inputs, NODE_TYPES.TextDisplay.inputs); assert.deepEqual(f.node.outputs, {});
    assert.equal(NODE_TYPES.TextDisplay.settings, undefined);
    f.send({ [port]: '<img src=x onerror=alert(1)>\n & text' });
    assert.equal(f.out.at(-1).firstChild.textContent, '<img src=x onerror=alert(1)>\n & text');
    assert.equal(f.out.at(-1).querySelector('img'), null);
    f.send({ [port]: '' }); assert.equal(f.out.at(-1).firstChild.textContent, '');
    assert.equal(f.node.rows.size, 0);
  }
  const f = fixture(['input1', 'input2']);
  f.send({ input1: 'L', input2: 'R' }); f.send({ input1: '' });
  assert.deepEqual(cells(f.out.at(-1)), [['', 'R']]);
  f.node.receiveInputs({ input1: 'next' }, { ...f.context, groupInputs: ['input1', 'input2'] });
  assert.deepEqual(cells(f.out.at(-1)), [['next', '']]);
  assert.equal(f.out.at(-1).querySelectorAll('tr').length, 1);
});
test('sink keyed history, buffering, independent updates, clearing, validation and snapshot ownership', () => {
  const f = fixture(['id', 'input1', 'input2']);
  assert.deepEqual(cells(f.out[0]), []);
  f.send({ input1: 'waiting', input2: 'right' }); assert.equal(f.out.length, 1);
  f.send({ id: -2.5 }); f.send({ id: 2 }); assert.equal(f.out.length, 2);
  f.send({ input1: 'B' });
  f.send({ id: -2.5, input1: 'A', input2: '' });
  assert.deepEqual(cells(f.out.at(-1)), [['A', ''], ['B', '']]);
  f.out.at(-1).querySelector('td').textContent = 'consumer mutation';
  f.send({ input2: 'translated A' });
  assert.deepEqual(cells(f.out.at(-1)), [['A', 'translated A'], ['B', '']]);
  const n = f.out.length;
  for (const id of [NaN, Infinity, '1']) assert.throws(() => f.send({ id, input1: 'bad' }), /finite number/);
  assert.throws(() => f.send({ id: 3, input1: null }), /TEXT/);
  assert.throws(() => f.send({ other: '' }), /Unknown/); assert.equal(f.out.length, n);
  f.node.receiveInputs({ input1: 'unidentified' }, { ...f.context, groupInputs: ['id', 'input1', 'input2'] });
  assert.equal(f.out.length, n);
  f.send({ id: 3 }); assert.deepEqual(cells(f.out.at(-1)).at(-1), ['unidentified', '']);
  const root = document.createElement('div'), graph = keyedTextGraph();
  renderTextRegions(root, graph, { display: f.out.at(-1) });
  assert.equal(root.children.length, 1); assert.equal(root.querySelector('h2').textContent, 'Text');
  assert.equal(root.querySelector('section').lang, 'und');
  assert.deepEqual(cells(root), cells(f.out.at(-1)));
});
for (const close of ['stop', 'cancel', 'dispose', 'abort']) test(`sink ${close} retains visible rows, rejects stale work and resets on Start`, () => {
  const f = fixture(['id', 'input1', 'input2']); f.send({ id: 1, input1: 'kept', input2: '' });
  if (close === 'abort') f.controller.abort(); else f.node[close]();
  f.send({ id: 1, input1: 'late' }); assert.equal(f.out.length, 2);
  const next = fixture(['id', 'input1', 'input2'], f.node);
  f.send({ id: 1, input1: 'old context' }); assert.equal(next.out.length, 1);
  next.send({ id: 1 }); assert.equal(next.out.length, 1);
  next.send({ input2: '' }); assert.deepEqual(cells(next.out.at(-1)), [['', '']]);
});

function workers() {
  const requests = [], owned = [];
  const factory = () => {
    const w = { postMessage(m) {
      if (m.type === 'translate') requests.push({ ...m, w });
      if (['load', 'drain'].includes(m.type)) queueMicrotask(() => w.onmessage?.({ data: { id: m.id, type: m.type === 'load' ? 'ready' : 'drained' } }));
      if (m.type === 'vad-stop') queueMicrotask(() => w.onmessage?.({ data: { type: 'vad-stopped', session: m.session } }));
    }, terminate() { this.terminated = true; } };
    owned.push(w); return w;
  };
  const complete = (index, error) => { const r = requests[index]; r.w.onmessage?.({ data: { id: r.id, type: error ? 'error' : 'result', message: error, texts: [`translated:${r.text}`] } }); };
  return { factory, requests, owned, complete };
}
for (const graphFactory of [keyedTextGraph, viewGraph, itemGraph]) for (const translator of ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa', null]) {
  test(`${graphFactory.name}/${translator || 'direct ASR'}: preview → final → late A translation while B is active, no gap, literal rendering and lifecycle`, async () => {
    const f = workers(), snapshots = [], graph = graphFactory(translator);
    assert.deepEqual(validateGraph(graph), []); assert.deepEqual(graphWarnings(graph), []);
    assert.deepEqual(executableGraph(graph), graph);
    for (const r of graph.edges.filter(r => r.from[0] !== 'audio')) assert.ok([NUMBER, TEXT, VIEW, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST].includes(NODE_TYPES[graph.nodes.find(n => n.id === r.from[0]).type].outputs[r.from[1]]));
    const built = buildGraph(graph, { sourceFactory: () => ({ start() {}, stop() {} }), workerFactory: f.factory,
      translationWorkerFactory: f.factory, prepareTranslation() {}, prepareTranslateGemma() {}, onDisplay: (_, dom) => snapshots.push(dom) });
    try {
      await built.pipeline.start(); await built.translations[0]?.ready;
      const speech = built.speechNodes.get('speech'), send = (type, id, text) => speech.receiveEvent({ type, id, text });
      send('partial', 0, 'draft A'); await tick(); assert.deepEqual(cells(snapshots.at(-1)), [['draft A', '']]);
      const beforeFinal = snapshots.length;
      send('final', 0, '<script>alert(1)</script>'); await tick();
      assert.deepEqual(snapshots.slice(beforeFinal).map(cells), [[['<script>alert(1)</script>', '']]], 'one replacement with no blank gap');
      send('partial', 1, 'draft B'); await tick();
      assert.deepEqual(cells(snapshots.at(-1)), [['<script>alert(1)</script>', ''], ['draft B', '']]);
      if (translator) {
        f.complete(0); await tick();
        assert.deepEqual(cells(snapshots.at(-1)), [['<script>alert(1)</script>', 'translated:<script>alert(1)</script>'], ['draft B', '']]);
      }
      assert.equal(snapshots.at(-1).querySelector('script'), null);
      send('final', 1, 'same'); send('final', 2, 'same'); await tick();
      assert.deepEqual(cells(snapshots.at(-1)).slice(1), [['same', ''], ['same', '']]);
      if (translator) {
        f.complete(1); await tick(); f.complete(2, 'controlled failure'); await tick();
        assert.deepEqual(cells(snapshots.at(-1)).slice(1), [['same', 'translated:same'], ['same', '']]);
      }
      await built.pipeline.stop(); const retained = snapshots.at(-1);
      send('final', 3, 'late'); await tick(); assert.equal(snapshots.at(-1), retained);
      assert.deepEqual(built.pipeline.errors, []);
    } finally { await built.pipeline.dispose(); }
    assert.ok(f.owned.every(w => w.terminated));
  });
}
test('saved graphs round-trip without migration or changes to legacy DOM graphs/recovery', () => {
  const values = new Map([[GRAPH_RECOVERY_KEY, 'original recovery']]);
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  for (const graph of [keyedDOMGraph(), keyedTextGraph(), viewGraph(), itemGraph()]) {
    saveGraph(storage, graph); const original = storage.getItem(GRAPH_KEY);
    assert.deepEqual(readGraph(storage), graph); assert.equal(storage.getItem(GRAPH_KEY), original);
    assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), 'original recovery');
  }
  for (const type of ['TextToDOM', 'PairedTextToDOM', 'KeyedDOMAccumulator', 'DOMAccumulator', 'DOMCombiner', 'LiveTextDisplay']) assert.ok(NODE_TYPES[type]);
});
