import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { HoldNode } from '../web/hold-node.js';
import { TextFormatterNode } from '../web/text-nodes.js';
import { TEXT } from '../web/port-contracts.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const edge = (a, b, c, d) => ({ from: [a, b], to: [c, d] });

function feedback({ onPath = false, leased = true, nested = false } = {}) {
  let source; const jobs = [], seen = [];
  const hold = new HoldNode();
  const nodes = {
    source: { outputs: { text: TEXT }, start(c) { source = c; } }, hold,
    formatter: new TextFormatterNode({ inputCount: 2, template: '{1}/{2}' }),
    update: { inputs: { text: TEXT }, outputs: { text: TEXT }, receive(_, text, c) { c.emit('text', text); } },
    async: { inputs: { text: TEXT }, outputs: { text: TEXT }, receive(_, text, c) { jobs.push({ text, original: c, work: leased ? c.defer() : { context: c } }); } },
    sink: { inputs: { text: TEXT }, receive(_, text) { seen.push(text); } },
  };
  const connections = [edge('source', 'text', 'formatter', 'input2'), edge('hold', 'value', 'formatter', 'input1'),
    edge('formatter', 'text', nested ? 'second' : 'update', nested ? 'input2' : 'text'), edge('update', 'text', 'async', 'text'),
    edge('async', 'text', 'sink', 'text'), edge(onPath ? 'async' : 'update', 'text', 'hold', 'input')];
  if (nested) {
    nodes.other = new HoldNode(); nodes.second = new TextFormatterNode({ inputCount: 2, template: '{1}|{2}' });
    connections.push(edge('other', 'value', 'second', 'input1'), edge('second', 'text', 'update', 'text'));
  }
  return { pipeline: new Pipeline({ nodes, connections }), hold, jobs, seen, send: text => source.emit('text', text) };
}

for (const nested of [false, true]) test(`deferred work on the feedback path retains its obligation (${nested})`, async t => {
  const f = feedback({ onPath: true, nested }); t.after(() => f.pipeline.dispose()); await f.pipeline.start();
  f.send('A'); f.send('B'); await tick(); assert.equal(f.jobs.length, 1); assert.equal(f.hold.value, '');
  const first = f.jobs[0].work;
  assert.equal(first.context.signal, f.jobs[0].original.signal);
  first.context.emit('text', 'S1'); await tick(); assert.equal(f.hold.value, 'S1'); assert.equal(f.jobs.length, 1);
  first.complete(); await tick(); assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[1].text, nested ? '|S1/B' : 'S1/B');
  f.jobs[1].work.context.emit('text', 'S2'); f.jobs[1].work.complete(); await f.pipeline.stop();
  assert.deepEqual(f.seen, ['S1', 'S2']); assert.deepEqual(f.pipeline.errors, []);
});

test('completing owned feedback work without storing state remains an error', async t => {
  const f = feedback({ onPath: true }); t.after(() => f.pipeline.dispose()); await f.pipeline.start();
  f.send('A'); f.send('B'); await tick(); f.jobs[0].work.complete();
  await assert.rejects(f.pipeline.stop(), /without storing feedback/); assert.equal(f.jobs.length, 1);
});

test('an independent branch needs explicit ownership for late output', async t => {
  const f = feedback({ leased: false }); t.after(() => f.pipeline.dispose()); await f.pipeline.start();
  f.send('A'); f.send('B'); await tick(); assert.equal(f.hold.value, '/A/B');
  f.jobs[0].work.context.emit('text', 'unowned');
  assert.match(f.pipeline.errors[0].message, /use context.defer/); assert.deepEqual(f.seen, []);
  await assert.rejects(f.pipeline.stop());
});

test('Stop owns deferred output even without a custom stop hook; completed contexts cannot emit or create work', async t => {
  const f = feedback(); t.after(() => f.pipeline.dispose()); await f.pipeline.start();
  f.send('A'); f.send('B'); await tick(); assert.equal(f.jobs.length, 2);
  assert.throws(() => f.jobs[0].original.defer(), /live receive/);
  let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  for (const { work, text } of f.jobs) { work.context.emit('text', text); work.complete(); work.complete(); }
  await stopping; assert.deepEqual(f.seen, ['/A', '/A/B']);
  assert.equal(f.pipeline.entries.get('async').work.size, 0);
});

test('emitting through completed work fails visibly while live; abort retires work and suppresses late output', async t => {
  const f = feedback(); t.after(() => f.pipeline.dispose()); await f.pipeline.start();
  f.send('A'); await tick(); f.jobs[0].work.complete(); f.jobs[0].work.context.emit('text', 'late');
  assert.match(f.pipeline.errors[0].message, /Async work emitted after completion/);
  assert.deepEqual(f.seen, []); await f.pipeline.cancel();
  const next = feedback(); t.after(() => next.pipeline.dispose()); await next.pipeline.start(); next.send('B'); await tick();
  await next.pipeline.cancel(); next.jobs[0].work.context.emit('text', 'canceled'); next.jobs[0].work.complete();
  assert.deepEqual(next.seen, []); assert.deepEqual(next.pipeline.errors, []);
  assert.equal(next.pipeline.entries.get('async').work.size, 0);
});
