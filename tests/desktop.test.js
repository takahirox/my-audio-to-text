import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultDesktopGraph, desktopNodeTypes, planGraph } from '../desktop/graph.js';
import { DesktopLibrary } from '../desktop/library.js';
import { DesktopSession } from '../desktop/session.js';
import { FocusedApplicationTextOutputNode } from '../desktop/focused-output.js';
import { FloatingDisplayNode } from '../web/floating-display-node.js';
import { edge, graphNode, GRAPH_VERSION, NODE_TYPES } from '../extension/graph.js';
import { exportEntry } from '../extension/graph-library.js';
import { extractSubgraph } from '../extension/subgraphs.js';
import { fetchPinnedModelAsset } from '../desktop/model-transport.js';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/port-contracts.js';
import { TextFormatterNode } from '../web/text-nodes.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const plan = () => planGraph(defaultDesktopGraph(), 'dictation');

test('desktop JSON rejects browser-only endpoints and preserves saved revisions and selection', t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-library-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'library.json');
  const library = new DesktopLibrary(path);
  const insertionOnly = defaultDesktopGraph();
  insertionOnly.nodes.pop();
  insertionOnly.edges.pop();
  const savedWithoutDisplay = library.add('Insertion only', insertionOnly);
  const graph = defaultDesktopGraph();
  graph.nodes.push(graphNode('ChromeTabAudio', 'tab'));
  assert.throws(() => library.add('Unsupported', graph), /ChromeTabAudio, tab\) requires the Chrome extension/);
  const entry = library.add('Second', defaultDesktopGraph());
  library.select(entry.id);
  const snapshot = planGraph(entry.graph, 'dictation');
  const replacement = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Display', 'display')],
    edges: [edge('text', 'value', 'display', 'input1')] };
  library.save(entry.id, entry.revision, replacement);
  assert.throws(() => library.save(entry.id, entry.revision, graph), /changed since/);
  const reopened = new DesktopLibrary(path);
  assert.equal(reopened.value.selected, entry.id);
  assert.deepEqual(reopened.lookup().graph, replacement);
  assert.deepEqual(reopened.lookup(savedWithoutDisplay.id).graph, insertionOnly);
  assert.deepEqual(planGraph(insertionOnly, 'dictation').graph, insertionOnly);
  assert.throws(() => planGraph(reopened.lookup().graph, 'dictation'), /connected focused application output/);
  assert.deepEqual(snapshot.graph, defaultDesktopGraph());
});

test('focused output inserts each nonempty generic TEXT delivery in order', async () => {
  let context;
  const output = [];
  const pipeline = new Pipeline({ nodes: {
    producer: { outputs: { text: TEXT }, start(value) { context = value; } },
    target: new FocusedApplicationTextOutputNode(text => { output.push(text); }),
  }, connections: [edge('producer', 'text', 'target', 'text')] });
  await pipeline.start();
  context.emitOutputs({ text: 'partial' }, { provisional: true });
  context.emitOutputs({ text: '東京🙂' }, { provisional: true });
  context.emit('text', '東京🙂');
  context.emitOutputs({ text: '' }, { provisional: true });
  context.emit('text', 'next');
  await pipeline.stop();
  await pipeline.dispose();
  assert.deepEqual(output, ['partial', '東京🙂', '東京🙂', 'next']);
});

test('default desktop wiring shows provisional TEXT and inserts only final TEXT', async () => {
  let speech;
  let snapshot = '';
  const output = [];
  const connections = plan().graph.edges.filter(({ from }) => from[0] === 'speech');
  const pipeline = new Pipeline({ nodes: {
    speech: { outputs: { provisional: TEXT, final: TEXT }, provisionalOutputs: ['provisional'],
      start(context) { speech = context; } },
    'focused-output': new FocusedApplicationTextOutputNode(text => { output.push(text); }),
    'floating-display': new FloatingDisplayNode(text => { snapshot = text; }),
  }, connections });
  await pipeline.start();
  speech.emit('provisional', 'partial');
  await tick();
  assert.equal(snapshot, 'partial');
  assert.deepEqual(output, []);
  speech.emit('final', 'final text');
  await tick();
  assert.equal(snapshot, 'partial');
  speech.emit('provisional', '');
  await pipeline.stop();
  await pipeline.dispose();
  assert.equal(snapshot, '');
  assert.deepEqual(output, ['final text']);
});

test('Floating Display receives generic TEXT even when repeated or empty, and ignores Cancel cleanup', async () => {
  let source;
  const seen = [];
  const pipeline = new Pipeline({ nodes: {
    custom: { outputs: { value: TEXT }, start(context) { source = context; }, cancel(context) { context.emit('value', 'cleanup'); } },
    floating: new FloatingDisplayNode(text => { seen.push(text); }),
  }, connections: [edge('custom', 'value', 'floating', 'text')] });
  await pipeline.start();
  source.emitOutputs({ value: '<b>literal</b>' }, { provisional: true });
  source.emit('value', '<b>literal</b>');
  source.emit('value', '');
  await tick();
  await pipeline.cancel();
  source.emit('value', 'late');
  assert.deepEqual(seen, ['<b>literal</b>', '<b>literal</b>', '']);
});

test('focused output inserts every snapshot emitted by the formatter', async () => {
  let first, second;
  const output = [], live = [];
  const pipeline = new Pipeline({ nodes: {
    first: { outputs: { preview: TEXT, final: TEXT }, provisionalOutputs: ['preview'], start(context) { first = context; } },
    second: { outputs: { final: TEXT }, start(context) { second = context; } },
    formatter: new TextFormatterNode({ template: '{1}|{2}|{3}', inputCount: 3 }, { separatePreviews: true }),
    target: new FocusedApplicationTextOutputNode(text => output.push(text)),
    display: { inputs: { text: TEXT }, receive(_, text) { live.push(text); } },
  }, connections: [
    edge('first', 'preview', 'formatter', 'input1'), edge('second', 'final', 'formatter', 'input2'),
    edge('first', 'final', 'formatter', 'input3'), edge('formatter', 'text', 'target', 'text'),
    edge('formatter', 'text', 'display', 'text'),
  ] });
  await pipeline.start();
  first.emit('preview', 'unfinished hypothesis');
  second.emit('final', 'confirmed text');
  first.emitOutputs({ preview: 'next hypothesis', final: 'first final' });
  second.emit('final', 'another final');
  await pipeline.stop();
  await pipeline.dispose();
  assert.deepEqual(live, ['unfinished hypothesis||', '|confirmed text|', '|confirmed text|first final', '|another final|first final']);
  assert.deepEqual(output, live);
});

test('focused output ignores cancellation deliveries even with a fresh cleanup signal', async () => {
  const output = [];
  const pipeline = new Pipeline({ nodes: {
    producer: { outputs: { text: TEXT }, cancel(context) { context.emit('text', 'cleanup'); } },
    target: new FocusedApplicationTextOutputNode(text => { output.push(text); }),
  }, connections: [edge('producer', 'text', 'target', 'text')] });
  await pipeline.start();
  await pipeline.cancel();
  assert.deepEqual(output, []);
});

test('Stop drains and blocks new starts, then rejects the old runtime token', async () => {
  const inserted = [], shown = [];
  let id;
  const controller = new DesktopSession({
    target: { request: async (action, token, text) => { if (action === 'insert') inserted.push([token, text]); } },
    run: async (action, token) => {
      if (action === 'start') id = token;
      if (action === 'stop') {
        assert.equal(controller.current.floatingText, '');
        controller.floatingDisplay(token, 'during drain');
        await controller.insert(token, ' final\n');
      }
    },
    onChange() {}, onDisplay() {}, onFloatingDisplay: text => shown.push(text),
  });
  await controller.start(plan());
  const old = id;
  controller.floatingDisplay(old, 'first preview');
  const draining = controller.stop();
  await controller.start(plan());
  assert.equal(id, old);
  await draining;
  await controller.start(plan());
  assert.notEqual(id, old);
  assert.equal(controller.current.floatingText, '');
  controller.floatingDisplay(old, 'late preview');
  await assert.rejects(controller.insert(old, 'late'), /no longer authorized/);
  assert.deepEqual(inserted, [[old, ' final\n']]);
  controller.floatingDisplay(id, 'new preview');
  const cancel = controller.cancel();
  assert.equal(controller.current.floatingText, '');
  controller.floatingDisplay(id, 'after cancel');
  assert.deepEqual(shown, ['first preview', 'new preview']);
  await cancel;
});

test('fatal helper failure discards queued output and cannot overlap cleanup with a new session', async () => {
  let complete, id;
  const writes = [];
  const controller = new DesktopSession({
    target: { request: async (action, _token, text) => {
      if (action === 'insert') {
        writes.push(text);
        await new Promise(resolve => { complete = resolve; });
      }
    } },
    run: async (action, token) => { if (action === 'start') id = token; },
    onChange() {}, onDisplay() {},
  });
  await controller.start(plan());
  const first = controller.insert(id, 'in flight');
  const second = controller.insert(id, 'pending');
  await tick();
  const canceled = controller.cancel('Accessibility service stopped', id);
  await assert.rejects(controller.insert(id, 'stale'), /no longer authorized/);
  await controller.start(plan());
  assert.equal(controller.state.phase, 'canceling');
  complete();
  await first;
  await assert.rejects(second, /no longer authorized/);
  await canceled;
  assert.equal(controller.state.error, 'Accessibility service stopped');
  assert.deepEqual(writes, ['in flight']);
});

test('authorization and microphone denial fail visibly, then a new Start succeeds', async () => {
  let starts = 0, releases = 0, cancels = 0;
  let failAuthorization = true;
  const controller = new DesktopSession({
    target: { request: async action => {
      if (action === 'authorize' && failAuthorization) throw Error('Accessibility permission denied');
      if (action === 'release') releases++;
    } },
    run: async action => {
      if (action === 'start' && ++starts === 1) throw Error('Microphone permission denied');
      if (action === 'cancel') cancels++;
    },
    onChange() {}, onDisplay() {},
  });
  await controller.start(plan());
  assert.equal(controller.state.error, 'Accessibility permission denied');
  assert.equal(starts, 0);
  assert.equal(cancels, 0);
  failAuthorization = false;
  await controller.start(plan());
  assert.equal(controller.state.error, 'Microphone permission denied');
  assert.equal(controller.state.microphone, false);
  await controller.start(plan());
  assert.equal(controller.state.phase, 'running');
  await controller.cancel();
  assert.equal(releases, 3);
  assert.equal(cancels, 2);
});

test('desktop palette follows the built-in catalog and Live accepts audio and action destinations', () => {
  assert.deepEqual(Object.keys(desktopNodeTypes), Object.keys(NODE_TYPES).filter(type => type !== 'ChromeTabAudio'));
  for (const [type, sink, port] of [['Kokoro', 'AudioOutput', 'audio'], ['Qwen3TtsStreaming', 'SpeakerOutput', 'stream']]) {
    const graph = { version: GRAPH_VERSION, nodes: [
      graphNode('Button', 'action'), graphNode('Text', 'text'), graphNode('Hold', 'hold'),
      graphNode(type, 'speech'), graphNode(sink, 'output'),
    ], edges: [
      edge('action', 'trigger', 'hold', 'trigger'), edge('text', 'value', 'hold', 'input'),
      edge('hold', 'value', 'speech', 'text'), edge('speech', port, 'output', 'audio'),
    ] };
    assert.equal(planGraph(graph, 'live').graph.nodes.length, graph.nodes.length);
    assert.deepEqual(planGraph(graph, 'live').actions.map(action => action.id), ['action']);
    assert.throws(() => planGraph({ ...graph, edges: [...graph.edges.slice(0, -1), edge('text', 'value', 'output', 'audio')] }, 'live'),
      /cannot connect|incompatible/i);
  }
});

test('desktop saves atomic extraction and imports shared Subgraph bundles with isolated snapshots', t => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-bundle-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const library = new DesktopLibrary(join(dir, 'library.json'));
  const graph = { version: GRAPH_VERSION, nodes: [
    graphNode('Text', 'text'), graphNode('TextFormatter', 'format'),
    graphNode('TextAccumulator', 'history'), graphNode('Display', 'view'),
  ], edges: [
    edge('text', 'value', 'format', 'input1'), edge('format', 'text', 'history', 'append'),
    edge('history', 'text', 'view', 'input1'),
  ] };
  const parent = library.add('Parent', graph);
  const { shared, parent: replacement } = extractSubgraph(graph, ['format', 'history'], 'shared');
  library.extract(parent.id, parent.revision, { id: 'shared', name: 'Shared', graph: shared, replacementGraph: replacement });
  const definition = library.lookup('shared');
  const saved = library.lookup(parent.id);
  const firstRun = planGraph(saved.graph, 'live', library.value.graphs);
  const bundle = JSON.parse(exportEntry(saved, library.value));
  const imported = library.import('Imported', bundle);
  const secondRun = planGraph(imported.graph, 'live', library.value.graphs);
  assert.notEqual(imported.graph.nodes.find(node => node.type === 'Subgraph').subgraphId, definition.id);
  assert.deepEqual(firstRun.graph, secondRun.graph);
  assert.throws(() => library.save(definition.id, definition.revision, { ...shared, edges: [] }), /Cannot disable executable paths/);
  const changed = structuredClone(shared);
  changed.nodes.find(node => node.id === 'format').settings.template = 'Reformatted {1}';
  library.save(definition.id, definition.revision, changed);
  assert.notDeepEqual(planGraph(saved.graph, 'live', library.value.graphs).graph, firstRun.graph);
  assert.deepEqual(planGraph(imported.graph, 'live', library.value.graphs).graph, firstRun.graph);
  bundle.graphs.find(entry => entry.id === bundle.root).graph.nodes.push(graphNode('ChromeTabAudio', 'tab'));
  const before = library.value;
  assert.throws(() => library.import('Incompatible', bundle), /requires the Chrome extension/);
  assert.equal(library.value, before);
});

test('desktop model transport only fetches pinned sources and permits signed delivery redirects', async () => {
  const pinned = 'https://huggingface.co/test/model/resolve/pinned/file.onnx';
  const route = value => `local-voice://desktop/model-asset?source=${encodeURIComponent(value)}`;
  const sources = new Map([[pinned, 3]]);
  const controller = new AbortController(), seen = [];
  let redirect = 'https://cas-bridge.xethub.hf.co/pin?signature=temporary';
  const fetchAsset = async (url, options) => {
    seen.push(url.href);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    return url.href === pinned ? new Response(null, { status: 302, headers: { Location: redirect } }) : new Response('pin');
  };
  const request = (url, options) => fetchPinnedModelAsset(new Request(url, options), sources, controller.signal, fetchAsset);
  assert.equal((await request(route(pinned) + '&other=1')).status, 404);
  assert.equal((await request(route(pinned.replace('/pinned/', '/main/')))).status, 404);
  assert.equal((await request(route(pinned), { method: 'POST' })).status, 404);
  assert.deepEqual(seen, []);
  const response = await request(route(pinned));
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(await response.text(), 'pin');
  assert.deepEqual(seen, [pinned, redirect]);
  redirect = 'https://huggingface.co.untrusted.test/file';
  assert.equal((await request(route(pinned))).status, 502);
  assert.deepEqual(seen, [pinned, 'https://cas-bridge.xethub.hf.co/pin?signature=temporary', pinned]);
});
