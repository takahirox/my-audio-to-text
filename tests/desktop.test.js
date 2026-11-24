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

test('focused output receives committed generic TEXT through a deterministic formatter in order', async () => {
  let context;
  const output = [];
  const pipeline = new Pipeline({ nodes: {
    producer: { outputs: { text: TEXT }, start(value) { context = value; },
    },
    formatter: new TextFormatterNode({ template: ' {1}\n', inputCount: 1 }),
    target: new FocusedApplicationTextOutputNode(text => { output.push(text); }),
  }, connections: [edge('producer', 'text', 'formatter', 'input1'), edge('formatter', 'text', 'target', 'text')] });
  await pipeline.start();
  context.emitOutputs({ text: 'partial' }, { provisional: true });
  context.emit('text', '東京🙂');
  context.emit('text', '東京🙂');
  await pipeline.stop();
  await pipeline.dispose();
  assert.deepEqual(output, [' 東京🙂\n', ' 東京🙂\n']);
});

test('formatter previews stay out of focused output when independent producers commit', async () => {
  let first, second;
  const output = [], live = [];
  const pipeline = new Pipeline({ nodes: {
    first: { outputs: { preview: TEXT, final: TEXT }, provisionalOutputs: ['preview'], start(context) { first = context; } },
    second: { outputs: { final: TEXT }, start(context) { second = context; } },
    formatter: new TextFormatterNode({ template: '{1}|{2}|{3}', inputCount: 3 }),
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
  assert.deepEqual(output, ['|confirmed text|', '|confirmed text|first final', '|another final|first final']);
  assert.deepEqual(live, ['unfinished hypothesis||', ...output]);
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

test('target invalidation discards queued output and cannot overlap cleanup with a new session', async () => {
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
  const canceled = controller.cancel('Focus changed', id);
  await assert.rejects(controller.insert(id, 'stale'), /no longer authorized/);
  await controller.start(plan());
  assert.equal(controller.state.phase, 'canceling');
  complete();
  await first;
  await assert.rejects(second, /no longer authorized/);
  await canceled;
  assert.equal(controller.state.error, 'Focus changed');
  assert.deepEqual(writes, ['in flight']);
});

test('bind failure and microphone denial fail visibly, then a new Start succeeds', async () => {
  let starts = 0, releases = 0;
  let failBind = true;
  const controller = new DesktopSession({
    target: { request: async action => {
      if (action === 'bind' && failBind) throw Error('Protected field');
      if (action === 'release') releases++;
    } },
    run: async action => {
      if (action === 'start' && ++starts === 1) throw Error('Microphone permission denied');
    },
    onChange() {}, onDisplay() {},
  });
  await controller.start(plan());
  assert.equal(controller.state.error, 'Protected field');
  assert.equal(starts, 0);
  failBind = false;
  await controller.start(plan());
  assert.equal(controller.state.error, 'Microphone permission denied');
  assert.equal(controller.state.microphone, false);
  await controller.start(plan());
  assert.equal(controller.state.phase, 'running');
  await controller.cancel();
  assert.equal(releases, 3);
});
