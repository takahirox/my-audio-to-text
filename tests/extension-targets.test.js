import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, GRAPH_KEY } from '../extension/graph.js';
import { PageTextOutputNode } from '../extension/page-output-node.js';
import { buildGraph } from '../extension/graph-runtime.js';

function fieldGraph(type = 'FocusedInputTextOutputNode', translated = false) {
  const graph = defaultGraph({ enabled: translated });
  graph.nodes.push(graphNode(type, 'field'));
  graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', 'field', translated ? 'translatedFinal' : 'final'));
  return graph;
}
test('all concrete audio sources accept fan-out to Live and independent field sinks; source ambiguity rejected', () => {
  for (const type of ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio']) {
    const graph = fieldGraph(); graph.nodes[0].type = type;
    graph.nodes.push(graphNode('SelectedFormFieldTextOutputNode', 'selected')); graph.edges.push(edge('speech', 'final', 'selected', 'final'));
    assert.deepEqual(validateGraph(graph), []);
    graph.nodes.push(graphNode('MicrophoneAudio', 'other')); assert.match(validateGraph(graph).join('\n'), /Exactly one audio input/);
  }
});
test('Live is optional; finalized sinks have exactly one typed producer and never accept provisional text', () => {
  for (const translated of [false, true]) {
    const graph = fieldGraph('SelectedFormFieldTextOutputNode', translated);
    const removed = new Set(graph.nodes.filter(n => ['TranscriptView', 'TranslationView'].includes(n.type)).map(n => n.id));
    graph.nodes = graph.nodes.filter(n => !removed.has(n.id)); graph.edges = graph.edges.filter(e => !removed.has(e.to[0]));
    assert.deepEqual(validateGraph(graph), []);
    assert.ok(buildGraph(graph, { onTranscript() {} }).pipeline);
    graph.edges.at(-1).from[1] = 'provisional'; assert.match(validateGraph(graph).join('\n'), /Connect .*final/);
    graph.edges.at(-1).from[1] = 'final';
    graph.edges.push(edge('speech', 'final', 'field', 'final'));
    assert.match(validateGraph(graph).join('\n'), translated ? /exactly one finalized/ : /Duplicate edge/);
  }
});
test('version 1 saved graphs migrate persistently with identical routes and no page targets or permissions', () => {
  const original = defaultGraph(); original.version = 1;
  let saved = JSON.stringify(original);
  const storage = { getItem: key => key === GRAPH_KEY ? saved : null, setItem: (_key, value) => { saved = value; }, removeItem() {} };
  const migrated = readGraph(storage); assert.equal(migrated.version, 2); assert.equal(JSON.parse(saved).version, 2);
  assert.deepEqual(migrated.edges, original.edges); assert.deepEqual(migrated.nodes, original.nodes);
  assert.deepEqual(readGraph(storage), migrated); assert.equal(assertGraph(original).version, 2);
});
function output(selected = false) {
  const sent = [], states = []; let closed = 0;
  const target = { tabId: 42, documentId: 'document', label: 'Authorized test page', fieldId: selected ? 'field' : undefined };
  const node = new PageTextOutputNode({ selected, target, onState: state => states.push(state), connectionFactory: () => ({ request: async (...args) => { sent.push(args); }, close: () => closed++ }) });
  return { node, sent, states, target, closed: () => closed };
}
test('field sink preserves final order and skips duplicate/stale/blank finals and pending/error translations', async () => {
  const f = output(true), context = { signal: new AbortController().signal };
  await f.node.start(context); f.target.fieldId = 'changed'; assert.equal(f.node.target.fieldId, 'field');
  await f.node.receive('provisional', { text: 'never', id: 0 }, context);
  for (const [id, text] of [[1, 'one'], [1, 'duplicate'], [0, 'stale'], [2, 'two'], [3, ' ']]) await f.node.receive('final', { id, text }, context);
  for (const status of ['pending', 'error', 'canceled']) await f.node.receive('translatedFinal', { status, source: { id: 4 }, text: 'never' }, context);
  await f.node.receive('translatedFinal', { status: 'complete', source: { id: 4 }, text: 'translated' }, context);
  f.node.stop(); await f.node.receive('final', { id: 5, text: 'late' }, context);
  assert.deepEqual(f.sent.filter(([action]) => action === 'append').map(([, value]) => [value.text, value.sequence]), [['one', 0], ['two', 1], ['translated', 2]]);
  assert.equal(f.closed(), 1);
});
test('field errors detach the branch without retries, logging text or failing Live; missing identity fails closed', async () => {
  const f = output(), context = { signal: new AbortController().signal }; await f.node.start(context);
  f.node.connection.request = async () => { throw Error('Permission lost'); };
  await f.node.receive('final', { id: 1, text: 'private transcript' }, context);
  await f.node.receive('final', { id: 2, text: 'another' }, context);
  assert.ok(f.node.failed); assert.equal(f.closed(), 1); assert.match(f.states.at(-1), /Permission lost/); assert.ok(!f.states.join('').includes('private transcript'));
  const other = output(); await other.node.start(context); await other.node.receive('final', { text: 'no id' }, context); assert.ok(other.node.failed);
});
test('cancellation suppresses queued finals', async () => {
  const controller = new AbortController(), context = { signal: controller.signal };
  const f = output(); await f.node.start(context); controller.abort(); await f.node.receive('final', { id: 1, text: 'no' }, context);
  assert.equal(f.sent.length, 1); f.node.dispose();
});

for (const selected of [false, true]) {
  for (const target of [undefined, {}, { tabId: 42 }, ...(selected ? [{ tabId: 42, documentId: 'authorized' }] : [])]) {
    test(`${selected ? 'selected' : 'focused'} output skips incomplete target ${JSON.stringify(target)} without opening a page connection`, async () => {
      const states = [], context = { signal: new AbortController().signal };
      const node = new PageTextOutputNode({ target, selected, onState: (...state) => states.push(state), connectionFactory() { assert.fail('Skipped output must not touch a page'); } });
      await node.start(context);
      assert.equal(node.skipped, true);
      assert.equal(states[0][1], false);
      assert.match(states[0][0], /output skipped: no (authorized target|selected field)/);
      assert.match(states[0][0], /Input and output targets.*next session/);
      // A later target cannot activate this session or insert missed finals.
      node.target = { tabId: 42, documentId: 'later', fieldId: 'later' };
      for (const port of ['final', 'translatedFinal']) await node.receive(port, { id: 1, source: { id: 1 }, status: 'complete', text: 'never' }, context);
      node.stop(); node.dispose();
      assert.equal(states.length, 1);
      assert.equal(node.sequence, 0);
    });
  }
  for (const stage of ['connect', 'output']) {
    test(`${selected ? 'selected' : 'focused'} output startup ${stage} failure stays branch-local and closes its connection`, async () => {
      let closed = 0;
      const states = [], context = { signal: new AbortController().signal };
      const node = new PageTextOutputNode({ selected, target: { tabId: 42, documentId: 'stale', fieldId: 'removed' }, onState: (...state) => states.push(state),
        connectionFactory() {
          if (stage === 'connect') throw Error('Permission lost');
          return { request: async () => { throw Error('Selected field removed'); }, close() { closed++; } };
        } });
      await node.start(context);
      await node.receive('final', { id: 1, text: 'never' }, context);
      assert.equal(node.skipped, true); assert.equal(closed, stage === 'connect' ? 0 : 1);
      assert.equal(states[0][1], false); assert.match(states[0][0], /output skipped: target unavailable/);
    });
  }
}

test('disconnect during output handshake reports one skipped state and never revives on a late reply', async () => {
  let disconnect, reply, closed = 0;
  const states = [], context = { signal: new AbortController().signal };
  const node = new PageTextOutputNode({ target: { tabId: 42, documentId: 'gone', label: 'Page' }, onState: (...state) => states.push(state),
    connectionFactory: (_target, onEvent) => {
      disconnect = () => onEvent({ event: 'ended', error: 'Page navigated' });
      return { request: () => new Promise(resolve => { reply = resolve; }), close() { closed++; disconnect(); } };
    } });
  const starting = node.start(context); disconnect(); reply(); await starting;
  await node.receive('final', { id: 1, text: 'never' }, context);
  assert.equal(states.length, 1); assert.equal(states[0][1], false);
  assert.match(states[0][0], /output skipped: target unavailable \(Page navigated\)/);
  assert.equal(closed, 1); assert.equal(node.sequence, 0);
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
