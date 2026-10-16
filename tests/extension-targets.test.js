import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, GRAPH_KEY, NODE_TYPES, GRAPH_VERSION } from '../extension/graph.js';
import { FocusedInputTextOutputNode } from '../extension/page-output-node.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { TEXT } from '../web/translation-nodes.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { legacyGraph, legacyAdapter } from './fixtures/legacy-graph.js';
import { Pipeline } from '../web/pipeline.js';
import { TargetControls } from '../extension/target-controls.js';

function fieldGraph(translated = false) {
  const graph = defaultGraph({ enabled: translated });
  graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'));
  graph.edges.push(edge(translated ? 'translation' : 'speech', translated ? 'text' : 'final', 'field', 'text'));
  return graph;
}
test('toolbar preparation authorizes only executable focused outputs, leaving parked and incomplete outputs unallocated', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    scripting: { async executeScript(options) { calls.push(['script', options]); return [{ documentId: 'document' }]; } },
    tabs: { connect(tabId, options) {
      calls.push(['connect', tabId, options]);
      let reply;
      return {
        onMessage: { addListener(listener) { reply = listener; } }, onDisconnect: { addListener() {} },
        postMessage(message) { calls.push(['request', message.action]); reply({ request: message.request, result: { label: 'Test page' } }); },
        disconnect() { calls.push(['disconnect']); },
      };
    } },
  } });
  try {
    const parked = defaultGraph(); parked.nodes.push(graphNode('FocusedInputTextOutputNode', 'parked'));
    const incomplete = defaultGraph();
    incomplete.nodes.push(graphNode('SpeechToTextWhisper', 'unfinished'), graphNode('FocusedInputTextOutputNode', 'field'));
    incomplete.edges.push(edge('unfinished', 'final', 'field', 'text'));
    for (const graph of [parked, incomplete, fieldGraph()]) {
      const session = { graph, outputTarget: { tabId: 99, documentId: 'stale' }, update() {} };
      const controls = Object.assign(Object.create(TargetControls.prototype), { session, render() {} });
      await controls.prepareFocusedOutput(42);
      if (graph === parked || graph === incomplete) {
        assert.deepEqual(calls, [], 'inactive outputs must not inject scripts or open page connections');
        assert.equal(session.outputTarget, null, 'stale authorization is cleared');
        assert.equal(controls.busy, undefined);
      } else {
        assert.deepEqual(calls.map(([action]) => action), ['script', 'connect', 'request', 'disconnect']);
        assert.deepEqual(calls[0][1].target, { tabId: 42, frameIds: [0] });
        assert.deepEqual(calls[1].slice(1), [42, { name: 'local-page-target', documentId: 'document' }]);
        assert.equal(session.outputTarget.documentId, 'document');
        assert.equal(session.outputTarget.tabId, 42);
      }
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor); else delete globalThis.chrome;
  }
});
test('direct TEXT input accepts different producers and all audio sources; removed diagnostic ports cannot connect', () => {
  assert.deepEqual(NODE_TYPES.FocusedInputTextOutputNode.inputs, { text: TEXT });
  assert.equal(NODE_TYPES.SelectedFormFieldTextOutputNode, undefined);
  for (const translated of [false, true]) for (const type of ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio']) {
    const graph = fieldGraph(translated); graph.nodes[0].type = type;
    assert.deepEqual(validateGraph(graph), []); assert.ok(buildGraph(graph, { onTranscript() {}, onTranslation() {} }).pipeline);
    graph.edges.at(-1).from = ['speech', 'provisional'];
    assert.deepEqual(validateGraph(graph), [], 'TEXT compatibility is independent of producer/port semantics');
    if (translated) { graph.edges.at(-1).from = ['translation', 'finalIndex']; assert.match(validateGraph(graph).join('\n'), /Unknown port/); }
  }
});
test('version 1/2 field graphs migrate persistently, preserve media, and reject ambiguous outputs visibly', () => {
  for (const version of [1, 2]) for (const oldType of ['FocusedInputTextOutputNode', 'SelectedFormFieldTextOutputNode']) for (const translated of [false, true]) {
    const graph = legacyGraph({ enabled: translated }, version); graph.nodes[0].type = 'SelectedPageMediaAudio';
    graph.nodes.push({ ...graphNode('FocusedInputTextOutputNode', 'field'), type: oldType });
    graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', 'field', translated ? 'translatedFinal' : 'final'));
    let saved = JSON.stringify(graph);
    const storage = { getItem: key => key === GRAPH_KEY ? saved : null, setItem: (_key, value) => { saved = value; }, removeItem() {} };
    let migrated; try { migrated = readGraph(storage); } catch (error) { if (!error.recoveryGraph) throw error; migrated = error.recoveryGraph; saved = JSON.stringify(migrated); }
    assert.equal(migrated.version, GRAPH_VERSION); assert.equal(JSON.parse(saved).version, GRAPH_VERSION);
    assert.deepEqual(readGraph(storage), migrated); assert.deepEqual(validateGraph(migrated), []);
    assert.equal(migrated.nodes[0].type, 'SelectedPageMediaAudio');
    assert.equal(migrated.nodes.find(n => n.id === 'field').type, 'FocusedInputTextOutputNode');
    assert.ok(migrated.edges.some(route => JSON.stringify(route) === JSON.stringify(edge(translated ? 'translation' : 'speech', translated ? 'text' : 'final', 'field', 'text'))));
    graph.edges.push(edge('speech', 'final', 'field', 'final'));
    assert.throws(() => assertGraph(graph), /Cannot migrate.*Reset and Save/);
  }
});
test('version 3 removes adapters preserving every fan-out route and translation view diagnostics', () => {
  for (const translated of [false, true]) {
    const graph = legacyGraph({ enabled: translated });
    graph.nodes.push(legacyAdapter(translated), graphNode('FocusedInputTextOutputNode', 'a'), graphNode('FocusedInputTextOutputNode', 'b'));
    graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', 'text', 'final'), edge('text', 'text', 'a', 'text'), edge('text', 'text', 'b', 'text'));
    const before = structuredClone(graph), migrated = repair(graph);
    assert.deepEqual(graph, before, 'migration never mutates stored input');
    assert.equal(migrated.nodes.some(node => node.id === 'text'), false);
    for (const id of ['a', 'b']) assert.ok(migrated.edges.some(route => JSON.stringify(route) === JSON.stringify(edge(translated ? 'translation' : 'speech', translated ? 'text' : 'final', id, 'text'))));
    if (translated) assert.ok(migrated.edges.some(route => route.from[1] === 'source' && route.to[0] === 'translated-format'));
    graph.edges.find(route => route.to[0] === 'text').from[1] = 'provisional';
    assert.throws(() => assertGraph(graph), /Cannot migrate text adapter.*Reset and Save/);
  }
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
  for (const text of ['one', 'one', 'two', '']) await f.node.receive('text', text, ctx);
  await f.node.receive('final', { id: 1, text: 'invalid' }, ctx);
  f.node.stop(); await f.node.receive('text', 'late', ctx);
  assert.deepEqual(f.sent.filter(([action]) => action === 'append').map(([, value]) => [value.text, value.sequence]), [['one', 0], ['one', 1], ['two', 2]]);
  assert.equal(f.closed(), 1);
  const controller = new AbortController(), other = output(); await other.node.start({ signal: controller.signal }); controller.abort();
  await other.node.receive('text', 'late', { signal: controller.signal }); assert.equal(other.sent.length, 1);
});
test('focused TEXT output forwards Japanese and explicit whitespace verbatim, skipping only empty strings', async () => {
  const f = output(), ctx = context(); await f.node.start(ctx);
  const texts = ['今日は', 'いい天気ですね', ' world', ' ', '\n', '\t', '  next\n\t '];
  for (const text of ['', ...texts, '', null, { text: 'invalid' }]) await f.node.receive('text', text, ctx);
  assert.deepEqual(f.sent.filter(([action]) => action === 'append').map(([, value]) => [value.text, value.sequence]), texts.map((text, sequence) => [text, sequence]));
  assert.equal(f.node.inserted, texts.length);
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
test('SpeechToText deduplicates worker IDs before direct TEXT fan-out; equal strings with distinct IDs deliver once', async () => {
  const a = output(), b = output(), live = [], speech = new SpeechToTextNode();
  speech.start = ctx => { speech.context = ctx; }; speech.stop = () => {};
  const pipeline = new Pipeline({ nodes: { speech, a: a.node, b: b.node, live: { inputs: { final: TEXT }, outputs: {}, receive: (_port, value) => live.push(value) } }, connections: [edge('speech', 'final', 'live', 'final'), edge('speech', 'final', 'a', 'text'), edge('speech', 'final', 'b', 'text')] });
  await pipeline.start();
  speech.receiveEvent({ type: 'partial', id: 0, text: 'provisional' });
  for (const [id, text] of [[1, 'one'], [1, 'retry'], [0, 'stale'], [2, 'one'], [3, 'x'.repeat(299) + '😀' + 'end']]) speech.receiveEvent({ type: 'final', id, text });
  await pipeline.stop(); await pipeline.stop(); await pipeline.dispose();
  for (const f of [a, b]) assert.deepEqual(f.sent.filter(([action]) => action === 'append').map(([, v]) => v.text), ['one', 'one', 'x'.repeat(299) + '😀' + 'end']);
  assert.deepEqual(live, ['one', 'one', 'x'.repeat(299) + '😀' + 'end']);
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

function repair(graph) {
  try { return assertGraph(graph); } catch (error) { if (!error.recoveryGraph) throw error; return assertGraph(error.recoveryGraph); }
}
