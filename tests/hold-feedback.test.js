import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, MAX_SAMPLED_PENDING, MAX_SAMPLED_CHARS, SAMPLED_TIMEOUT_MS } from '../web/pipeline.js';
import { HoldNode } from '../web/hold-node.js';
import { TextFormatterNode } from '../web/text-nodes.js';
import { TextWindowNode } from '../web/text-window-node.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { edge, graphNode, validateGraph, executableGraph, saveGraph, readGraph, GRAPH_VERSION } from '../extension/graph.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fixture({ receive, reverse = false, window = false, startupError = false } = {}) {
  let sourceContext, unrelated;
  const held = new HoldNode(), requests = [], outputs = [], gates = [];
  const formatter = new TextFormatterNode({ inputCount: 2, template: 'Previous:{1}\nNew:{2}' });
  const nodes = {
    source: { outputs: { text: TEXT }, start(c) { sourceContext = c; } },
    held, formatter,
    update: { inputs: { text: TEXT }, outputs: { text: TEXT }, start(c) { unrelated = c; }, async receive(_, text, c) {
      requests.push(text);
      if (receive) return receive(text, c);
      const gate = deferred(); gates.push(gate); await gate.promise;
      c.emit('text', 'S' + requests.length);
    } },
    display: { inputs: { text: TEXT }, receive(_, text) { outputs.push(text); } },
  };
  const connections = [edge('source', 'text', window ? 'window' : 'formatter', window ? 'text' : 'input2'),
    edge('held', 'value', 'formatter', 'input1'), edge('formatter', 'text', 'update', 'text'),
    edge('update', 'text', 'held', 'input'), edge('update', 'text', 'display', 'text')];
  if (window) { nodes.window = new TextWindowNode(); connections.push(edge('window', 'text', 'formatter', 'input2')); }
  if (startupError) {
    nodes.broken = { inputs: { text: TEXT }, start() { throw Error('Independent startup failure'); }, receive() {} };
    connections.push(edge('update', 'text', 'broken', 'text'));
  }
  if (reverse) connections.reverse();
  const pipeline = new Pipeline({ nodes, connections });
  return { pipeline, held, requests, outputs, gates, send: text => sourceContext.emit('text', text), unrelated: text => unrelated.emit('text', text) };
}

for (const reverse of [false, true]) test(`FIFO A/B/C waits for completed feedback; one format per window (reversed edges: ${reverse})`, async () => {
  const f = fixture({ reverse }); await f.pipeline.start();
  assert.equal(f.held.value, '');
  f.send('A'); f.send('B'); f.send('C'); await tick();
  assert.deepEqual(f.requests, ['Previous:\nNew:A']);
  f.gates[0].resolve(); await tick();
  assert.deepEqual(f.requests, ['Previous:\nNew:A', 'Previous:S1\nNew:B']);
  f.gates[1].resolve(); await tick();
  assert.equal(f.requests[2], 'Previous:S2\nNew:C');
  const stopping = f.pipeline.stop(); await tick();
  assert.equal(f.pipeline.state, 'stopping');
  f.gates[2].resolve(); await stopping;
  assert.deepEqual(f.outputs, ['S1', 'S2', 'S3']); assert.equal(f.held.value, 'S3');
  await f.pipeline.dispose();
});

test('unchanged results complete each request; held updates alone never trigger a formatter', async () => {
  const f = fixture({ receive: (_, c) => c.emit('text', 'same') }); await f.pipeline.start();
  f.unrelated('seed'); await tick(); assert.equal(f.held.value, 'seed'); assert.deepEqual(f.requests, []);
  f.send('A'); f.send('B'); f.send('C'); await f.pipeline.stop();
  assert.deepEqual(f.requests, ['Previous:seed\nNew:A', 'Previous:same\nNew:B', 'Previous:same\nNew:C']);
  assert.deepEqual(f.outputs, ['seed', 'same', 'same', 'same']); await f.pipeline.dispose();
});

for (const reverse of [false, true]) test(`independent state and trigger sources have deterministic delivery order (${reverse})`, async () => {
  let c; const seen = [], hold = new HoldNode();
  const routes = [edge('source', 'held', 'hold', 'input'), edge('source', 'next', 'formatter', 'input2'), edge('hold', 'value', 'formatter', 'input1'), edge('formatter', 'text', 'sink', 'text')];
  if (reverse) routes.reverse();
  const p = new Pipeline({ nodes: { source: { outputs: { held: TEXT, next: TEXT }, start(context) { c = context; } }, hold,
    formatter: new TextFormatterNode({ inputCount: 2, template: '{1}/{2}' }), sink: { inputs: { text: TEXT }, receive(_, s) { seen.push(s); } } }, connections: routes });
  await p.start();
  c.emit('next', 'first'); await tick(); assert.deepEqual(seen, ['/first']);
  c.emit('held', 'state'); await tick(); assert.equal(seen.length, 1);
  c.emit('next', 'second'); await tick(); assert.equal(seen.at(-1), 'state/second');
  c.emitOutputs({ next: 'group', held: 'atomic' }); await p.stop();
  assert.equal(seen.at(-1), 'atomic/group'); await p.dispose();
});

for (const kind of ['throw', 'fail', 'missing']) test(`failed or missing causal completion stops queued work explicitly (${kind})`, async () => {
  const f = fixture({ receive: (_, c) => { if (kind === 'throw') throw Error('GPU lost'); if (kind === 'fail') c.fail(Error('request failed')); } });
  await f.pipeline.start(); f.send('A'); f.send('B');
  await assert.rejects(f.pipeline.stop(), /Pipeline failed/);
  assert.equal(f.requests.length, 1); assert.equal(f.held.value, '');
  assert.ok(f.pipeline.entries.get('formatter').failed); await f.pipeline.dispose();
});

test('unrelated TEXT cannot complete a pending update or let B sample early', async () => {
  const f = fixture(); await f.pipeline.start(); f.send('A'); f.send('B'); await tick();
  f.unrelated('unrelated'); await tick(); assert.equal(f.requests.length, 1);
  f.gates[0].resolve(); await tick(); assert.equal(f.requests[1], 'Previous:S1\nNew:B');
  f.gates[1].resolve(); await f.pipeline.stop(); await f.pipeline.dispose();
});

test('detached output does not masquerade as an awaited completion', async () => {
  let late;
  const f = fixture({ receive: (_, c) => { late = () => c.emit('text', 'late'); } });
  await f.pipeline.start(); f.send('A'); f.send('B'); await tick(); late();
  await assert.rejects(f.pipeline.stop()); assert.deepEqual(f.outputs, []); assert.equal(f.requests.length, 1);
  await f.pipeline.dispose();
});

for (const mode of ['cancel', 'dispose']) test(`${mode} interrupts in-flight work and rejects queued windows; fresh Start has empty state`, async () => {
  const f = fixture(); await f.pipeline.start(); f.send('A'); f.send('B'); await tick();
  await f.pipeline[mode](); f.gates[0].resolve(); await tick();
  assert.deepEqual(f.outputs, []); assert.equal(f.requests.length, 1); assert.equal(f.held.value, '');
  await assert.rejects(f.pipeline.start(), /fresh/);
  const next = fixture({ receive: (_, c) => c.emit('text', 'new') }); await next.pipeline.start(); next.send('C'); await next.pipeline.stop();
  assert.deepEqual(next.requests, ['Previous:\nNew:C']); await next.pipeline.dispose();
});

test('Stop flushes TextWindow tail and drains accepted asynchronous work; Cancel drops the tail', async () => {
  for (const cancel of [false, true]) {
    const f = fixture({ window: true, receive: async (_, c) => { await tick(); c.emit('text', 'done'); } });
    await f.pipeline.start(); f.send('tail'); await tick(); assert.equal(f.requests.length, 0);
    await (cancel ? f.pipeline.cancel() : f.pipeline.stop());
    assert.deepEqual(f.outputs, cancel ? [] : ['done']); await f.pipeline.dispose();
  }
});

for (const mode of ['count', 'chars']) test(`sampled queue has an explicit ${mode} bound`, async () => {
  const f = fixture(); await f.pipeline.start(); f.send('A'); await tick();
  if (mode === 'count') for (let i = 1; i <= MAX_SAMPLED_PENDING; i++) f.send('B');
  else f.send('x'.repeat(MAX_SAMPLED_CHARS));
  await tick(); assert.ok(f.pipeline.errors.some(e => /backlog exceeded/.test(e.message)));
  f.gates[0].resolve(); await assert.rejects(f.pipeline.stop()); assert.equal(f.requests.length, 1);
  await f.pipeline.dispose();
});

test('unsettled receive has bounded waiting, with no fabricated result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.pipeline.start(); f.send('A'); f.send('B'); await tick();
  t.mock.timers.tick(SAMPLED_TIMEOUT_MS); await tick();
  assert.ok(f.pipeline.errors.some(e => /timed out/.test(e.message)));
  await assert.rejects(f.pipeline.stop(), /timed out/);
  await f.pipeline.cancel(); f.gates[0].resolve(); await tick(); assert.deepEqual(f.outputs, []);
});

test('event cycles and wrong primitive connections remain rejected; only non-emitting reads break cycles', async () => {
  const node = () => ({ inputs: { text: TEXT }, outputs: { text: TEXT }, receive() {} });
  assert.throws(() => new Pipeline({ nodes: { a: node(), b: node() }, connections: [edge('a', 'text', 'b', 'text'), edge('b', 'text', 'a', 'text')] }), /acyclic/);
  assert.throws(() => new Pipeline({ nodes: { a: { outputs: { n: NUMBER } }, h: new HoldNode() }, connections: [edge('a', 'n', 'h', 'input')] }), /Incompatible/);
  const g = { version: GRAPH_VERSION, nodes: ['Text', 'Hold', 'TextFormatter', 'MeetingSummaryLfm2', 'Display'].map((type, i) => graphNode(type, 'n' + i)), edges: [
    edge('n0', 'value', 'n2', 'input2'), edge('n1', 'value', 'n2', 'input1'), edge('n2', 'text', 'n3', 'text'), edge('n3', 'summary', 'n1', 'input'), edge('n3', 'summary', 'n4', 'input')] };
  assert.deepEqual(validateGraph(g), []); assert.equal(executableGraph(g).nodes.length, 5);
  const storage = new Map(), adapter = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  saveGraph(adapter, g); assert.deepEqual(readGraph(adapter), g);
  g.edges.push(edge('n2', 'text', 'n2', 'input3')); assert.match(validateGraph(g).join(' '), /acyclic/);
});

test('an independent startup failure does not deactivate held state on a viable feedback path', async () => {
  const f = fixture({ startupError: true, receive: (_, c) => c.emit('text', 'ok') });
  await f.pipeline.start(); assert.equal(f.pipeline.entries.get('held').active, true);
  f.send('A'); f.send('B'); await assert.rejects(f.pipeline.stop(), /Independent startup failure/);
  // A failed independent branch remains visible without canceling feedback.
  assert.equal(f.pipeline.entries.get('held').node.readOutput('value'), 'ok');
  assert.equal(f.requests.length, 2);
  await f.pipeline.dispose();
});

test('nested sampled consumers retain causal completion across both state boundaries', async () => {
  let send; const requests = [];
  const nodes = {
    source: { outputs: { text: TEXT }, start(c) { send = text => c.emit('text', text); } },
    one: new HoldNode(), two: new HoldNode(),
    first: new TextFormatterNode({ inputCount: 2, template: '{1}/{2}' }),
    second: new TextFormatterNode({ inputCount: 2, template: '{1}|{2}' }),
    update: { inputs: { text: TEXT }, outputs: { text: TEXT }, async receive(_, text, c) {
      requests.push(text); await tick(); c.emit('text', 'S' + requests.length);
    } },
    sink: { inputs: { text: TEXT }, receive() {} },
  };
  const p = new Pipeline({ nodes, connections: [edge('source', 'text', 'first', 'input2'), edge('one', 'value', 'first', 'input1'),
    edge('first', 'text', 'second', 'input2'), edge('two', 'value', 'second', 'input1'), edge('second', 'text', 'update', 'text'),
    edge('update', 'text', 'one', 'input'), edge('update', 'text', 'two', 'input'), edge('update', 'text', 'sink', 'text')] });
  await p.start(); send('A'); send('B'); await p.stop();
  assert.deepEqual(requests, ['|/A', 'S1|S1/B']); assert.deepEqual(p.errors, []); await p.dispose();
});

test('a readable state boundary cannot emit events or legitimize a separate emitting cycle', async () => {
  const a = { inputs: { text: TEXT, held: TEXT }, outputs: { text: TEXT }, receive() {} };
  const b = { inputs: { text: TEXT }, outputs: { text: TEXT }, receive() {} };
  assert.throws(() => new Pipeline({ nodes: { a, b, h: new HoldNode() }, connections: [
    edge('h', 'value', 'a', 'held'), edge('a', 'text', 'h', 'input'), edge('a', 'text', 'b', 'text'), edge('b', 'text', 'a', 'text'),
  ] }), /acyclic/);
  const hold = new HoldNode();
  hold.start = c => c.emit('value', 'must not circulate');
  const p = new Pipeline({ nodes: { hold, sink: { inputs: { text: TEXT }, receive() { throw Error('must not deliver'); } } }, connections: [edge('hold', 'value', 'sink', 'text')] });
  await assert.rejects(p.start(), /output port/); assert.equal(p.errors.length, 1); await p.dispose();
});
