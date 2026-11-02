import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document } from './fixtures/dom.js';
import { keyedDOMGraph } from './fixtures/keyed-dom-graph.js';
import { Pipeline } from '../web/pipeline.js';
import { DOM, NUMBER, TEXT } from '../web/port-contracts.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { PairedTextToDOMNode, KeyedDOMAccumulatorNode } from '../web/dom-nodes.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { defaultGraph, validateGraph, executableGraph, saveGraph, readGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY, edge } from '../extension/graph.js';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const cells = dom => [...dom.querySelectorAll('tbody tr')].map(row => [...row.children].map(cell => cell.textContent));
const context = (extra = {}) => ({ signal: new AbortController().signal, ...extra });
function workers(immediate = false) {
  const requests = [], owned = [];
  const factory = () => {
    const w = { postMessage(m) {
      if (m.type === 'translate') { requests.push({ ...m, w }); if (immediate) queueMicrotask(() => complete(requests.length - 1)); }
      if (['load', 'drain'].includes(m.type)) queueMicrotask(() => w.onmessage?.({ data: { id: m.id, type: m.type === 'load' ? 'ready' : 'drained' } }));
      if (m.type === 'vad-stop') queueMicrotask(() => w.onmessage?.({ data: { type: 'vad-stopped', session: m.session } }));
    }, terminate() { this.terminated = true; } };
    owned.push(w); return w;
  };
  const complete = (index, error) => { const r = requests[index]; r.w.onmessage?.({ data: { id: r.id, type: error ? 'error' : 'result', message: error, texts: [`translated:${r.text}`] } }); };
  return { factory, requests, owned, complete };
}

test('ASR IDs are stable across interleaved open utterances, instances and fresh Starts', () => {
  const output = [], a = new SpeechToTextNode(), b = new SpeechToTextNode();
  for (const node of [a, b]) node.context = context({ emitOutputs: values => output.push(values) });
  a.receiveEvent({ type: 'partial', id: 0, text: 'same' });
  a.receiveEvent({ type: 'partial', id: 1, text: 'same' });
  b.receiveEvent({ type: 'partial', id: 0, text: 'same' });
  for (const [node, id] of [[a, 0], [a, 1], [b, 0]]) node.receiveEvent({ type: 'final', id, text: 'same' });
  const ids = output.slice(0, 3).map(value => value.provisionalId);
  assert.equal(new Set(ids).size, 3); assert.deepEqual(output.slice(3).map(value => value.finalId), ids);
  a.resetUtterances(); a.receiveEvent({ type: 'partial', id: 0, text: 'new session' });
  assert.ok(!ids.includes(output.at(-1).provisionalId));
  a.dispose(); b.dispose();
});

for (const translator of ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa', null]) {
  test(`${translator || 'direct ASR'}: continuous keyed rows, FIFO duplicates, errors, Stop and fresh history`, async () => {
    const f = workers(), snapshots = [], diagnostics = [], graph = keyedDOMGraph(translator);
    assert.deepEqual(validateGraph(graph), []); assert.equal(executableGraph(graph).nodes.length, graph.nodes.length);
    const built = buildGraph(graph, { sourceFactory: () => ({ start() {}, stop() {} }), workerFactory: f.factory,
      translationWorkerFactory: f.factory, prepareTranslation() {}, prepareTranslateGemma() {},
      onDisplay: (_, dom) => snapshots.push(dom), onTranslationState: message => diagnostics.push(message) });
    try {
      await built.pipeline.start(); await built.translations[0]?.ready;
      const speech = built.speechNodes.get('speech'), send = (type, id, text) => speech.receiveEvent({ type, id, text });
      send('partial', 0, 'draft'); await tick(); assert.deepEqual(cells(snapshots.at(-1)), [['draft', '']]);
      send('final', 0, 'same'); await tick(); assert.deepEqual(cells(snapshots.at(-1)), [['same', '']]);
      send('partial', 1, 'next'); await tick(); assert.deepEqual(cells(snapshots.at(-1)), [['same', ''], ['next', '']]);
      send('final', 1, 'same'); send('final', 2, 'same'); await tick();
      assert.deepEqual(cells(snapshots.at(-1)), [['same', ''], ['same', ''], ['same', '']]);
      if (translator) {
        f.complete(0); await tick();
        assert.deepEqual(cells(snapshots.at(-1)), [['same', 'translated:same'], ['same', ''], ['same', '']]);
        f.complete(1, 'controlled failure'); await tick();
        assert.deepEqual(cells(snapshots.at(-1)), [['same', 'translated:same'], ['same', ''], ['same', '']]);
        assert.ok(diagnostics.some(message => message.includes('controlled failure')));
      }
      send('final', 3, ''); send('final', 4, '  '); await tick();
      assert.equal(cells(snapshots.at(-1)).length, 5);
      const retained = snapshots.at(-1); await built.pipeline.stop();
      send('partial', 5, 'late'); send('final', 5, 'late'); await tick();
      assert.equal(snapshots.at(-1), retained); assert.deepEqual(built.pipeline.errors, []);
      const history = built.pipeline.entries.get('history').node, empty = [];
      history.start(context({ emit: (_, dom) => empty.push(dom) })); assert.equal(empty[0].childNodes.length, 0);
    } finally { await built.pipeline.dispose(); }
    assert.ok(f.owned.every(w => w.terminated));
  });
}

for (const immediate of [false, true]) test(`independent delayed branches cannot overwrite a final or translated row (fast translation=${immediate})`, async () => {
  let source, releasePreview, releaseFinal;
  const snapshots = [], f = workers(immediate), preview = new PairedTextToDOMNode(), final = new PairedTextToDOMNode();
  const hold = (node, setRelease) => {
    const receive = node.receiveInputs.bind(node);
    node.receiveInputs = (values, c) => new Promise(resolve => setRelease(() => { receive(values, c); resolve(); }));
  };
  hold(preview, release => releasePreview = release); hold(final, release => releaseFinal = release);
  const translation = new OpusMtTranslationNode({ workerFactory: f.factory });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { id: NUMBER, text: TEXT }, start(c) { source = c; } }, preview, final, translation,
    translated: new PairedTextToDOMNode(), history: new KeyedDOMAccumulatorNode(), sink: { inputs: { dom: DOM }, receive(_, dom) { snapshots.push(dom); } },
  }, connections: [
    ...['preview', 'final', 'translation'].flatMap(id => [edge('source', 'id', id, 'id'), edge('source', 'text', id, id === 'translation' ? 'text' : 'input1')]),
    ...['id', 'source', 'text'].map((port, i) => edge('translation', port, 'translated', ['id', 'input1', 'input2'][i])),
    ...['preview', 'final', 'translated'].flatMap((id, i) => [edge(id, 'id', 'history', `id${i+1}`), edge(id, 'dom', 'history', `dom${i+1}`)]), edge('history', 'dom', 'sink', 'dom'),
  ] });
  await pipeline.start(); source.emitOutputs({ id: 42, text: 'same' }); await tick();
  if (!immediate) { releaseFinal(); await tick(); assert.deepEqual(cells(snapshots.at(-1)), [['same', '']]); f.complete(0); await tick(); }
  assert.deepEqual(cells(snapshots.at(-1)), [['same', 'translated:same']]);
  releasePreview(); if (immediate) releaseFinal(); await tick();
  assert.deepEqual(cells(snapshots.at(-1)), [['same', 'translated:same']]);
  await pipeline.stop(); assert.deepEqual(pipeline.errors, []); await pipeline.dispose();
});

test('paired IDs are delivery-local; clears and ID-only updates never reuse another pair', () => {
  const out = [], node = new PairedTextToDOMNode(), c = context({ connectedInputs: ['id', 'input1', 'input2'], groupInputs: ['id', 'input1', 'input2'], emitOutputs: v => out.push(v) });
  node.start(); node.receiveInputs({ id: 1, input1: 'same', input2: 'old' }, c);
  node.receiveInputs({ id: 2 }, c); node.receiveInputs({ input1: '' }, { ...c, provisional: true });
  assert.throws(() => node.receiveInputs({ input1: '' }, c), /missing/);
  assert.equal(out.length, 1);
  node.receiveInputs({ id: 2, input1: 'same' }, c); assert.deepEqual(cells(out[1].dom), [['same', '']]); assert.equal(out[1].id, 2);
  assert.throws(() => node.receiveInputs({ id: 3, input1: 'wrong' }, { ...c, groupInputs: undefined }), /grouped/);
  assert.throws(() => node.receiveInputs({ input1: 'wrong' }, c), /missing/);
  node.cancel(); node.receiveInputs({ id: 3, input1: 'late' }, c); assert.equal(out.length, 2);
});

test('keyed history validates complete groups and clones retained and emitted DOM', () => {
  const node = new KeyedDOMAccumulatorNode(), snapshots = [], c = context({ groupInputs: ['id1', 'dom1'], emit: (_, dom) => snapshots.push(dom) });
  node.start(c); const dom = document.createElement('div'); dom.textContent = 'owned';
  node.receiveInputs({ id1: 1, dom1: dom }, c); dom.textContent = 'changed'; snapshots[1].firstChild.textContent = 'sink mutation';
  node.receiveInputs({ id1: 2, dom1: document.createDocumentFragment() }, c);
  assert.equal(snapshots.at(-1).firstChild.textContent, 'owned'); assert.equal(node.rows.size, 2);
  for (const values of [{ id1: 1 }, { dom1: dom }, { id1: NaN, dom1: dom }, { id1: -1, dom1: dom }, { id1: 1, dom1: 'bad' }]) assert.throws(() => node.receiveInputs(values, c));
  assert.throws(() => node.receiveInputs({ id1: 1, dom1: dom }, { ...c, groupInputs: undefined }), /grouped/);
  node.stop(); node.receiveInputs({ id1: 3, dom1: dom }, c); assert.equal(node.rows.size, 2);
});

for (const Node of [OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode]) {
  test(`${Node.name}: queued job IDs, errors and Cancel preserve the accepted snapshot`, async () => {
    const f = workers(), outputs = []; let source;
    const translation = new Node({ workerFactory: f.factory });
    const pipeline = new Pipeline({ nodes: { source: { outputs: { id: NUMBER, text: TEXT }, start(c) { source = c; } }, translation,
      sink: { inputs: translation.outputs, receiveInputs(values) { outputs.push(values); } } }, connections: [edge('source', 'id', 'translation', 'id'), edge('source', 'text', 'translation', 'text'),
        ...Object.keys(translation.outputs).map(port => edge('translation', port, 'sink', port))] });
    await pipeline.start();
    source.emitOutputs({ id: 1, text: 'same' }); source.emitOutputs({ id: 2, text: 'same' }); source.emitOutputs({ id: 3, text: '' }); await tick();
    f.complete(0); await tick(); f.complete(1, 'failed'); await tick();
    assert.deepEqual(outputs, [{ id: 1, source: 'same', text: 'translated:same', error: '' }, { id: 2, source: 'same', error: 'failed' }, { id: 3, source: '', text: '', error: '' }]);
    source.emitOutputs({ id: 4, text: 'pending' }); await tick(); await pipeline.cancel(); f.complete(2); await tick();
    assert.equal(outputs.length, 3); assert.ok(f.owned.every(w => w.terminated)); assert.deepEqual(pipeline.errors, []);
  });
}

test('saved keyed graphs round-trip; ID-less storage and migration recovery stay intact; malformed groups are visible', () => {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const old = defaultGraph(), original = JSON.stringify(old); storage.setItem(GRAPH_KEY, original); storage.setItem(GRAPH_RECOVERY_KEY, 'original recovery');
  assert.deepEqual(readGraph(storage), old); assert.equal(storage.getItem(GRAPH_KEY), original);
  const graph = keyedDOMGraph(); saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph); assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), 'original recovery');
  const id = graph.edges.find(route => route.to.join('.') === 'final.id'); id.from = ['speech', 'provisionalId'];
  assert.match(validateGraph(graph).join(), /atomic family/);
  id.from = ['speech', 'finalId']; graph.edges = graph.edges.filter(route => route.to.join('.') !== 'final.input1');
  assert.deepEqual(validateGraph(graph), []); assert.ok(!executableGraph(graph).nodes.some(node => node.id === 'final'));
  storage.setItem(GRAPH_KEY, '{bad'); assert.throws(() => readGraph(storage), /kept/); assert.equal(storage.getItem(GRAPH_KEY), '{bad');
});

test('atomic ASR final/preview clear keeps the preview visible while the final branch is held', async () => {
  const f = workers(), snapshots = [], built = buildGraph(keyedDOMGraph(null), {
    sourceFactory: () => ({ start() {}, stop() {} }), workerFactory: f.factory, onDisplay: (_, dom) => snapshots.push(dom),
  });
  await built.pipeline.start();
  const final = built.pipeline.entries.get('final').node, receive = final.receiveInputs.bind(final); let release;
  final.receiveInputs = (values, c) => new Promise(resolve => { release = () => { receive(values, c); resolve(); }; });
  const speech = built.speechNodes.get('speech');
  speech.receiveEvent({ type: 'partial', id: 0, text: 'preview' }); await tick();
  const beforeClear = snapshots.length;
  speech.receiveEvent({ type: 'final', id: 0, text: 'final' }); await tick();
  assert.deepEqual(cells(snapshots.at(-1)), [['preview', '']]);
  assert.equal(snapshots.length, beforeClear, 'the preview clear did not publish an empty row');
  release(); await tick(); assert.deepEqual(cells(snapshots.at(-1)), [['final', '']]);
  await built.pipeline.stop(); await built.pipeline.dispose();
});

test('scheduler IDs remain independent across preview clears, queued equal finals, size errors and Cancel', async () => {
  const { TranslationSchedulerNode } = await import('../extension/translation-scheduler.js');
  const f = workers(), out = [], diagnostics = [], controller = new AbortController();
  const c = context({ signal: controller.signal, connectedInputs: ['id', 'text', 'provisionalId', 'provisional'],
    groupInputs: ['id', 'text', 'provisionalId', 'provisional'], emitOutputs: values => out.push(values) });
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.factory, onState: value => diagnostics.push(value) });
  scheduler.start(c); await scheduler.ready;
  scheduler.receiveInputs({ provisionalId: 10, provisional: 'same' }, c); await tick();
  scheduler.receiveInputs({ provisionalId: 10, provisional: '', id: 11, text: 'same' }, c);
  scheduler.receiveInputs({ id: 12, text: 'same' }, c);
  scheduler.receiveInputs({ id: 13, text: 'x'.repeat(1001) }, c);
  scheduler.receiveInputs({ id: 14, text: '' }, c);
  scheduler.receiveInputs({ id: 999 }, c);
  assert.deepEqual(out, [{ provisionalId: 10, provisionalSource: '', provisionalText: '', provisionalError: '' }]);
  f.complete(0); await tick(); // obsolete preview reply must not acquire a final ID
  f.complete(1); await tick(); f.complete(2); await tick();
  assert.deepEqual(out.slice(1).map(value => value.id), [11, 12, 13, 14]);
  assert.deepEqual(out.slice(1, 3).map(value => value.text), ['translated:same', 'translated:same']);
  assert.equal(out[3].source, 'x'.repeat(1001)); assert.equal(Object.hasOwn(out[3], 'text'), false);
  assert.ok(diagnostics.some(message => message.includes('1,000'))); assert.equal(out[4].text, '');
  scheduler.receiveInputs({ provisionalId: 15, provisional: 'pending' }, c); await tick();
  controller.abort(); await scheduler.cancel(c); f.complete(3); await tick();
  assert.deepEqual(out.at(-1), { provisionalId: 15, provisionalSource: '', provisionalText: '', provisionalError: '' });
  assert.equal(out.length, 6); assert.ok(f.owned.every(w => w.terminated));
});

test('standalone Worker communication failure retains each queued source and ID', async () => {
  const f = workers(), out = []; let source;
  const translation = new OpusMtTranslationNode({ workerFactory: f.factory });
  const pipeline = new Pipeline({ nodes: { source: { outputs: { id: NUMBER, text: TEXT }, start(c) { source = c; } }, translation,
    sink: { inputs: translation.outputs, receiveInputs(values) { out.push(values); } } }, connections: [edge('source', 'id', 'translation', 'id'), edge('source', 'text', 'translation', 'text'),
      ...Object.keys(translation.outputs).map(port => edge('translation', port, 'sink', port))] });
  await pipeline.start(); source.emitOutputs({ id: 1, text: 'same' }); source.emitOutputs({ id: 2, text: 'same' }); await tick();
  f.owned[0].onmessageerror({ message: 'broken channel' }); await tick();
  assert.deepEqual(out, [{ id: 1, source: 'same', error: 'broken channel' }, { id: 2, source: 'same', error: 'broken channel' }]);
  await pipeline.stop(); assert.deepEqual(pipeline.errors, []); await pipeline.dispose();
});

test('an unconnected translator or half-wired history slot cannot park direct transcription', async () => {
  const graph = keyedDOMGraph();
  graph.nodes = graph.nodes.filter(node => node.id !== 'translation');
  graph.edges = graph.edges.filter(route => ![route.from[0], route.to[0]].includes('translation'));
  const selected = executableGraph(graph);
  assert.ok(selected.nodes.some(node => node.id === 'history'));
  assert.ok(!selected.nodes.some(node => node.id === 'translated'));
  assert.ok(!selected.edges.some(route => ['id3', 'dom3'].includes(route.to[1])));
  // Even when the producer participates through another complete slot, do not
  // deliver its half-wired ID independently into the unfinished history slot.
  graph.edges = graph.edges.filter(route => route.to.join('.') !== 'history.id3');
  graph.edges.push(edge('final', 'id', 'history', 'id3'));
  graph.edges = graph.edges.filter(route => route.to.join('.') !== 'history.dom3');
  assert.ok(!executableGraph(graph).edges.some(route => route.to.join('.') === 'history.id3'));
  const f = workers(), out = [], built = buildGraph(graph, { workerFactory: f.factory,
    sourceFactory: () => ({ start() {}, stop() {} }), onDisplay: (_, dom) => out.push(dom) });
  await built.pipeline.start(); built.speechNodes.get('speech').receiveEvent({ type: 'final', id: 0, text: 'direct' }); await tick();
  assert.deepEqual(cells(out.at(-1)), [['direct', '']]);
  await built.pipeline.stop(); assert.deepEqual(built.pipeline.errors, []); await built.pipeline.dispose();
});

test('final-only Whisper feeds keyed history without a provisional port', async () => {
  const graph = keyedDOMGraph(null), f = workers(), out = [];
  graph.nodes.find(node => node.id === 'speech').type = 'SpeechToTextWhisper';
  graph.nodes = graph.nodes.filter(node => node.id !== 'preview');
  graph.edges = graph.edges.filter(route => ![route.from[0], route.to[0]].includes('preview'));
  const built = buildGraph(graph, { sourceFactory: () => ({ start() {}, stop() {} }), whisperWorkerFactory: f.factory, onDisplay: (_, dom) => out.push(dom) });
  await built.pipeline.start(); const speech = built.speechNodes.get('speech');
  speech.receiveEvent({ type: 'final', id: 0, text: 'same' }); speech.receiveEvent({ type: 'final', id: 1, text: 'same' }); await tick();
  assert.deepEqual(cells(out.at(-1)), [['same', ''], ['same', '']]);
  await built.pipeline.stop(); assert.deepEqual(built.pipeline.errors, []); await built.pipeline.dispose();
});
