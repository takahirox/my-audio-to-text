import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultDesktopGraph, planGraph } from '../desktop/graph.js';
import { DesktopLibrary } from '../desktop/library.js';
import { DesktopSession } from '../desktop/session.js';
import { FocusedApplicationTextOutputNode } from '../desktop/focused-output.js';
import { edge, graphNode, GRAPH_VERSION } from '../extension/graph.js';
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
  const graph = defaultDesktopGraph();
  graph.nodes.push(graphNode('ChromeTabAudio', 'tab'));
  assert.throws(() => library.add('Unsupported', graph), /Unsupported desktop Node: ChromeTabAudio/);
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

test('default desktop wiring inserts only the connected final output', async () => {
  let speech;
  const output = [];
  const connections = plan().graph.edges.filter(({ to }) => to[0] === 'focused-output');
  const pipeline = new Pipeline({ nodes: {
    speech: { outputs: { provisional: TEXT, final: TEXT }, provisionalOutputs: ['provisional'],
      start(context) { speech = context; } },
    'focused-output': new FocusedApplicationTextOutputNode(text => { output.push(text); }),
  }, connections });
  await pipeline.start();
  speech.emit('provisional', 'partial');
  speech.emitOutputs({ provisional: 'another partial', final: 'final text' });
  await pipeline.stop();
  await pipeline.dispose();
  assert.deepEqual(output, ['final text']);
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
  const inserted = [];
  let id;
  const controller = new DesktopSession({
    target: { request: async (action, token, text) => { if (action === 'insert') inserted.push([token, text]); } },
    run: async (action, token) => {
      if (action === 'start') id = token;
      if (action === 'stop') await controller.insert(token, ' final\n');
    },
    onChange() {}, onDisplay() {},
  });
  await controller.start(plan());
  const old = id;
  const draining = controller.stop();
  await controller.start(plan());
  assert.equal(id, old);
  await draining;
  await controller.start(plan());
  assert.notEqual(id, old);
  await assert.rejects(controller.insert(old, 'late'), /no longer authorized/);
  assert.deepEqual(inserted, [[old, ' final\n']]);
  await controller.cancel();
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
