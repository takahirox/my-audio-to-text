import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, GRAPH_KEY, NODE_TYPES, GRAPH_VERSION } from '../extension/graph.js';
import { FocusedInputTextOutputNode } from '../extension/page-output-node.js';
import { buildGraph, FinalTextNode } from '../extension/graph-runtime.js';
import { TEXT } from '../web/translation-nodes.js';
import { TRANSCRIPT } from '../web/transcription-nodes.js';
import { Pipeline } from '../web/pipeline.js';

function fieldGraph(translated = false) {
  const graph = defaultGraph({ enabled: translated });
  graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'), graphNode(translated ? 'TranslatedFinalText' : 'FinalText', 'text'));
  graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', 'text', 'final'), edge('text', 'text', 'field', 'text'));
  return graph;
}
test('one TEXT input; all audio sources and Live remain valid; transcript/translation cannot connect directly', () => {
  assert.deepEqual(NODE_TYPES.FocusedInputTextOutputNode.inputs, { text: TEXT });
  assert.equal(NODE_TYPES.SelectedFormFieldTextOutputNode, undefined);
  for (const translated of [false, true]) for (const type of ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio']) {
    const graph = fieldGraph(translated); graph.nodes[0].type = type;
    assert.deepEqual(validateGraph(graph), []); assert.ok(buildGraph(graph, { onTranscript() {}, onTranslation() {} }).pipeline);
    graph.edges.at(-1).from = [translated ? 'translation' : 'speech', 'final'];
    assert.match(validateGraph(graph).join('\n'), /Incompatible port/);
  }
  const graph = fieldGraph(); graph.edges.at(-2).from[1] = 'provisional';
  assert.match(validateGraph(graph).join('\n'), /Connect speech.final/);
});
test('version 1/2 field graphs migrate persistently, reuse adapters, preserve media, and reject ambiguous outputs visibly', () => {
  for (const version of [1, 2]) for (const oldType of ['FocusedInputTextOutputNode', 'SelectedFormFieldTextOutputNode']) for (const translated of [false, true]) {
    const graph = defaultGraph({ enabled: translated }); graph.version = version; graph.nodes[0].type = 'SelectedPageMediaAudio';
    graph.nodes.push({ ...graphNode('FocusedInputTextOutputNode', 'field'), type: oldType });
    graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', 'field', translated ? 'translatedFinal' : 'final'));
    let saved = JSON.stringify(graph);
    const storage = { getItem: key => key === GRAPH_KEY ? saved : null, setItem: (_key, value) => { saved = value; }, removeItem() {} };
    const migrated = readGraph(storage);
    assert.equal(migrated.version, GRAPH_VERSION); assert.equal(JSON.parse(saved).version, GRAPH_VERSION);
    assert.deepEqual(readGraph(storage), migrated); assert.deepEqual(validateGraph(migrated), []);
    assert.equal(migrated.nodes[0].type, 'SelectedPageMediaAudio');
    assert.equal(migrated.nodes.find(n => n.id === 'field').type, 'FocusedInputTextOutputNode');
    const adapter = migrated.nodes.find(n => n.type === (translated ? 'TranslatedFinalText' : 'FinalText'));
    assert.ok(migrated.edges.some(e => e.from[0] === adapter.id && e.to[0] === 'field' && e.to[1] === 'text'));
    // Existing final adapter can fan out to legacy destinations after migration.
    const oldWithAdapter = structuredClone(graph); oldWithAdapter.nodes.push(adapter);
    oldWithAdapter.edges.push(edge(translated ? 'translation' : 'speech', 'final', adapter.id, 'final'));
    assert.equal(assertGraph(oldWithAdapter).nodes.length, migrated.nodes.length);
    graph.edges.push(edge('speech', 'final', 'field', 'final'));
    assert.throws(() => assertGraph(graph), /Cannot migrate.*Reset and Save/);
  }
  const graph = defaultGraph(); graph.version = 1;
  assert.deepEqual(assertGraph(graph).edges, graph.edges);
  const malformed = fieldGraph(); malformed.version = 2; malformed.edges.at(-1).to[1] = 'final';
  assert.throws(() => assertGraph(malformed), /Cannot migrate/);
});
const context = () => ({ signal: new AbortController().signal });
function output({ target = { tabId: 42, documentId: 'document', label: 'Test page' }, response = { inserted: true } } = {}) {
  const sent = [], states = []; let closed = 0;
  const node = new FocusedInputTextOutputNode({ target, onState: (...state) => states.push(state), connectionFactory: () => ({ request: async (...args) => { sent.push(args); return response; }, close: () => closed++ }) });
  return { node, sent, states, closed: () => closed };
}
test('plain strings need no IDs; equal text is valid, no replay on Stop, cancellation ignores late delivery', async () => {
  const f = output(), ctx = context(); await f.node.start(ctx);
  assert.deepEqual(f.node.inputs, { text: TEXT });
  for (const text of ['one', 'one', 'two', ' ']) await f.node.receive('text', text, ctx);
  await f.node.receive('final', { id: 1, text: 'invalid' }, ctx);
  f.node.stop(); await f.node.receive('text', 'late', ctx);
  assert.deepEqual(f.sent.filter(([action]) => action === 'append').map(([, value]) => [value.text, value.sequence]), [['one', 0], ['one', 1], ['two', 2]]);
  assert.equal(f.closed(), 1);
  const controller = new AbortController(), other = output(); await other.node.start({ signal: controller.signal }); controller.abort();
  await other.node.receive('text', 'late', { signal: controller.signal }); assert.equal(other.sent.length, 1);
});
test('no focus/canceled edit skips a value; permission/transport errors detach only this branch without retry', async () => {
  const f = output({ response: { skipped: 'Focus a field' } }), ctx = context(); await f.node.start(ctx);
  await f.node.receive('text', 'private', ctx); assert.equal(f.node.failed, undefined); assert.match(f.states.at(-1)[0], /Insertion skipped/);
  f.node.connection.request = async () => ({ inserted: true }); await f.node.receive('text', 'next', ctx);
  assert.match(f.states.at(-1)[0], /inserted 1 text/);
  f.node.connection.request = async () => { throw Error('Permission lost'); };
  await f.node.receive('text', 'private', ctx); await f.node.receive('text', 'never', ctx);
  assert.equal(f.node.failed, true); assert.equal(f.closed(), 1); assert.match(f.states.at(-1)[0], /Permission lost/);
  assert.ok(!JSON.stringify(f.states).includes('private'));
});
for (const target of [null, {}, { tabId: 42 }, { tabId: 42, documentId: '' }]) test(`incomplete target ${JSON.stringify(target)} never opens a page`, async () => {
  const states = [], node = new FocusedInputTextOutputNode({ target, onState: (...state) => states.push(state), connectionFactory() { assert.fail('Must not connect'); } });
  const ctx = context(); await node.start(ctx); await node.receive('text', 'never', ctx);
  assert.equal(node.skipped, true); assert.match(states[0][0], /invoke the toolbar/); assert.equal(states[0][1], false);
});
test('runtime refuses a different tab even with an authorized document ID', () => {
  const built = buildGraph(fieldGraph(), { tabId: 42, outputTarget: { tabId: 99, documentId: 'other' } });
  assert.equal(built.pipeline.entries.get('field').node.target, undefined);
});
test('disconnect during output handshake never revives on a late reply', async () => {
  let disconnect, reply, closed = 0; const states = [], ctx = context();
  const node = new FocusedInputTextOutputNode({ target: { tabId: 42, documentId: 'gone', label: 'Page' }, onState: (...state) => states.push(state),
    connectionFactory: (_target, onEvent) => {
      disconnect = () => onEvent({ event: 'ended', error: 'Page navigated' });
      return { request: () => new Promise(resolve => { reply = resolve; }), close() { closed++; disconnect(); } };
    } });
  const starting = node.start(ctx); disconnect(); reply(); await starting; await node.receive('text', 'never', ctx);
  assert.equal(states.length, 1); assert.equal(states[0][1], false); assert.equal(closed, 1); assert.equal(node.sequence, 0);
});
test('final delivery policy deduplicates IDs upstream; plain TEXT fans out independently in order while Live receives transcripts', async () => {
  for (const translated of [false, true]) {
    const a = output(), b = output(), live = [];
    const adapter = new FinalTextNode(translated);
    const source = { inputs: {}, outputs: { final: adapter.inputs.final }, start(ctx) { this.emit = value => ctx.emit('final', value); } };
    const pipeline = new Pipeline({ nodes: { source, adapter, a: a.node, b: b.node, live: { inputs: { final: source.outputs.final }, outputs: {}, receive: (_port, value) => live.push(value) } }, connections: [edge('source', 'final', 'adapter', 'final'), edge('source', 'final', 'live', 'final'), edge('adapter', 'text', 'a', 'text'), edge('adapter', 'text', 'b', 'text')] });
    await pipeline.start();
    for (const [id, text, status] of [[0, 'pending', 'pending'], [1, 'one', 'complete'], [1, 'retry', 'complete'], [0, 'stale', 'complete'], [2, 'one', 'complete'], [3, 'x'.repeat(299) + '😀' + 'end', 'complete']]) {
      if (!translated && status !== 'complete') continue;
      source.emit({ id, source: { id }, text, status });
    }
    await pipeline.stop(); await pipeline.stop(); await pipeline.dispose();
    for (const f of [a, b]) assert.deepEqual(f.sent.filter(([action]) => action === 'append').map(([, v]) => v.text), ['one', 'one', 'x'.repeat(299) + '😀' + 'end']);
    assert.equal(live.length, translated ? 6 : 5);
  }
  assert.notEqual(TEXT, TRANSCRIPT);
});

test('microphone toolbar selection never requests permission; cancellation releases a late grant before model/capture startup', async () => {
  const { TabSession } = await import('../extension/session.js');
  const graph = defaultGraph({ enabled: false }); graph.nodes[0].type = 'MicrophoneAudio';
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let requests = 0, grant, stops = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia() { requests++; return new Promise(resolve => { grant = resolve; }); } } } });
  try {
    const session = new TabSession(() => {}, { graph, workerFactory() { throw Error('Canceled permission must not create Workers'); } });
    await session.start(42); assert.equal(requests, 0); assert.match(session.view.status, /Press Start/);
    const starting = session.start(undefined, { microphoneGesture: true }); assert.equal(requests, 1);
    session.cancel(); grant({ getTracks: () => [{ stop() { stops++; } }] }); await starting;
    assert.equal(stops, 1); assert.equal(session.view.state, 'idle'); assert.equal(session.session, null);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; }
});
