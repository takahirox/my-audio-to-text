import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, portContract } from '../web/pipeline.js';

const text = portContract('text');
const tick = () => new Promise(resolve => setImmediate(resolve));
const gate = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const connection = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
function source() {
  return { outputs: { text }, start(context) { this.context = context; } };
}
function sink(receive = () => {}) { return { inputs: { text }, receive }; }

test('unknown nodes/ports, incompatible identities, duplicates and cycles fail clearly', () => {
  const nodes = { a: source(), b: sink() };
  for (const [edge, message] of [
    [connection('missing', 'text', 'b', 'text'), /Unknown connection node/],
    [connection('a', 'missing', 'b', 'text'), /Unknown output port/],
    [connection('a', 'text', 'b', 'missing'), /Unknown input port/],
  ]) assert.throws(() => new Pipeline({ nodes, connections: [edge] }), message);
  assert.throws(() => new Pipeline({ nodes: { a: source(), b: {
    inputs: { text: portContract('text') }, receive() {},
  } }, connections: [connection('a', 'text', 'b', 'text')] }), /Incompatible/);
  const edge = connection('a', 'text', 'b', 'text');
  assert.throws(() => new Pipeline({ nodes, connections: [edge, edge] }), /Duplicate/);
  assert.throws(() => new Pipeline({ nodes: { ...nodes, other: source() }, connections: [edge, connection('other', 'text', 'b', 'text')] }), /Only one connection/);
  const both = () => ({ inputs: { text }, outputs: { text }, receive() {} });
  assert.throws(() => new Pipeline({ nodes: { a: both(), b: both() }, connections: [
    connection('a', 'text', 'b', 'text'), connection('b', 'text', 'a', 'text'),
  ] }), /acyclic/);
  assert.throws(() => new Pipeline({ nodes: { a: nodes.a, b: nodes.a } }), /only once/);
});

test('async fan-out schedules independent branches and serializes each node across multiple inputs', async () => {
  const slow = gate(), received = [], blocked = [], a = source();
  const b = { inputs: { original: text, derived: text }, async receive(port, value) {
    blocked.push([port, value]); await slow.promise;
  } };
  const pipeline = new Pipeline({ nodes: { a, b, c: sink((port, value) => received.push(value)) }, connections: [
    connection('a', 'text', 'b', 'original'), connection('a', 'text', 'b', 'derived'),
    connection('a', 'text', 'c', 'text'),
  ] });
  await pipeline.start(); a.context.emit('text', 'one'); a.context.emit('text', 'two');
  assert.deepEqual(received, [], 'delivery must be asynchronous');
  await tick(); assert.deepEqual(received, ['one', 'two']);
  assert.deepEqual(blocked, [['original', 'one']]);
  let stopped = false; const stopping = pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  slow.resolve(); await stopping;
  assert.deepEqual(blocked, [['original', 'one'], ['derived', 'one'], ['original', 'two'], ['derived', 'two']]);
  await pipeline.dispose();
});

test('async start initializes consumers first; graceful stop drains source tails and multiple processor outputs', async () => {
  const trace = [], values = [], flush = gate();
  const a = { outputs: { text }, async start(context) {
    await tick(); trace.push('source start'); context.emit('text', 'initial');
  }, async stop(context) { await tick(); trace.push('source stop'); context.emit('text', 'tail'); } };
  const b = { inputs: { text }, outputs: { preview: text, final: text },
    async start() { await tick(); trace.push('processor start'); },
    async receive(port, value, context) { await tick(); trace.push(value); context.emit('preview', value); },
    async stop(context) { trace.push('processor stop'); await flush.promise; context.emit('final', 'committed'); },
  };
  const c = { inputs: { preview: text, final: text },
    async start() { await tick(); trace.push('sink start'); },
    async receive(port, value) { await tick(); values.push([port, value]); },
    async stop() { await tick(); trace.push('sink stop'); },
  };
  const pipeline = new Pipeline({ nodes: { a, b, c }, connections: [
    connection('a', 'text', 'b', 'text'), connection('b', 'preview', 'c', 'preview'),
    connection('b', 'final', 'c', 'final'),
  ] });
  await pipeline.start();
  assert.deepEqual(trace.slice(0, 3), ['sink start', 'processor start', 'source start']);
  let finished = false;
  const stopPromise = pipeline.stop();
  const stopping = stopPromise.then(() => { finished = true; });
  assert.equal(pipeline.stop(), stopPromise);
  await tick(); await tick(); await tick(); assert.equal(finished, false);
  flush.resolve(); await stopping;
  assert.deepEqual(values, [['preview', 'initial'], ['preview', 'tail'], ['final', 'committed']]);
  assert.ok(trace.indexOf('source stop') < trace.indexOf('tail'));
  assert.ok(trace.indexOf('tail') < trace.indexOf('processor stop'));
  assert.ok(trace.indexOf('processor stop') < trace.indexOf('sink stop'));
  assert.equal(pipeline.state, 'stopped');
  await assert.rejects(pipeline.start(), /fresh/);
  await pipeline.dispose();
});

for (const phase of ['start', 'receive', 'stop']) {
  test(`dispose interrupts pending ${phase}, skips queued inputs and suppresses delayed output`, async () => {
    const held = gate(), values = [], calls = [], a = source();
    const b = { inputs: { text }, outputs: { text },
      async start(context) { this.context = context; if (phase === 'start') await held.promise; },
      async receive(port, value, context) {
        calls.push(value); if (phase === 'receive') await held.promise;
        context.emit('text', value);
      },
      async stop(context) { if (phase === 'stop') await held.promise; context.emit('text', 'tail'); },
      dispose() { calls.push('disposed'); },
    };
    const pipeline = new Pipeline({ nodes: { a, b, c: sink((port, value) => values.push(value)) }, connections: [
      connection('a', 'text', 'b', 'text'), connection('b', 'text', 'c', 'text'),
    ] });
    const starting = pipeline.start();
    // Handle cancellation rejection before triggering it.
    const started = starting.catch(error => error);
    await tick();
    if (phase !== 'start') { await starting; a.context.emit('text', 'one'); a.context.emit('text', 'two'); }
    await tick();
    const stopping = phase === 'stop' ? pipeline.stop() : Promise.resolve();
    await tick(); const before = values.slice();
    await pipeline.dispose(); await stopping;
    if (phase === 'start') assert.equal((await started).name, 'AbortError');
    held.resolve(); b.context.emit('text', 'stale callback'); await tick();
    assert.deepEqual(values, before);
    assert.ok(b.context.signal.aborted);
    if (phase === 'receive') assert.deepEqual(calls, ['one', 'disposed']);
  });
}

test('failed branch reports once and leaves independent branches deliverable/drainable', async () => {
  const a = source(), errors = [], values = [];
  const pipeline = new Pipeline({ nodes: { a, broken: sink(async () => { throw new Error('I/O failed'); }),
    healthy: sink((port, value) => values.push(value)),
  }, onError: (error, id) => { errors.push([error.message, id]); }, connections: [
    connection('a', 'text', 'broken', 'text'), connection('a', 'text', 'healthy', 'text'),
  ] });
  await pipeline.start(); a.context.emit('text', 'one'); a.context.emit('text', 'two'); await tick();
  assert.deepEqual(values, ['one', 'two']); assert.deepEqual(errors, [['Node broken: I/O failed', 'broken']]);
  await assert.rejects(pipeline.stop(), AggregateError); assert.equal(pipeline.state, 'stopped');
  await pipeline.dispose();
});

test('startup failure releases partially initialized resources and dispose cleans all nodes despite failure', async () => {
  const released = [], errors = [];
  const pipeline = new Pipeline({ nodes: {
    source: { start() { throw new Error('load failure'); }, dispose() { released.push('source'); } },
    sink: { dispose() { released.push('sink'); } },
  }, onError: error => errors.push(error.message) });
  await assert.rejects(pipeline.start(), /load failure/);
  assert.deepEqual(released.sort(), ['sink', 'source']);
  assert.deepEqual(errors, ['Node source: load failure']);
  const cleanup = new Pipeline({ nodes: {
    a: { dispose() { throw new Error('cleanup failure'); } },
    b: { dispose() { released.push('b'); } },
  } });
  await assert.rejects(cleanup.dispose(), AggregateError); assert.ok(released.includes('b'));
});

test('unknown emissions fail once, even when the error observer throws', async () => {
  const a = source();
  const pipeline = new Pipeline({ nodes: { a }, onError() { throw new Error('observer failure'); } });
  await pipeline.start();
  a.context.emit('unknown', 'one'); a.context.emit('unknown', 'two');
  assert.equal(pipeline.errors.length, 1);
  assert.match(pipeline.errors[0].message, /Unknown output port: a.unknown/);
  await assert.rejects(pipeline.stop(), AggregateError);
  await pipeline.dispose();
});

for (const hook of ['start', 'stop']) {
  test(`dispose from inside ${hook} cannot revive pipeline state`, async () => {
    let pipeline;
    pipeline = new Pipeline({ nodes: { a: {
      [hook]() { void pipeline.dispose(); },
    } } });
    if (hook === 'start') await assert.rejects(pipeline.start(), { name: 'AbortError' });
    else { await pipeline.start(); await pipeline.stop(); }
    assert.equal(pipeline.state, 'disposed');
  });
}

test('group snapshots correlate identical consecutive values for async receivers and independent fan-out', async () => {
  const held = gate(), grouped = [], other = [], plain = [], legacy = [];
  const producer = { outputs: { original: text, translated: text }, start(context) { this.context = context; },
    stop(context) { context.emitOutputs({ original: 'tail', translated: 'final tail' }); } };
  const paired = { inputs: { source: text, result: text }, async receiveInputs(values) {
    grouped.push(values); if (grouped.length === 1) await held.promise;
  } };
  const mirror = { inputs: paired.inputs, receiveInputs(values) { other.push(values); } };
  const ordinary = { inputs: paired.inputs, async receive(port, value) { legacy.push([port, value]); await tick(); } };
  const pipeline = new Pipeline({ nodes: { producer, paired, mirror, ordinary, plain: sink((port, value) => plain.push(value)) }, connections: [
    ...['paired', 'mirror', 'ordinary'].flatMap(target => [connection('producer', 'original', target, 'source'), connection('producer', 'translated', target, 'result')]),
    connection('producer', 'translated', 'plain', 'text'),
  ] });
  await pipeline.start();
  const values = { original: 'same', translated: 'first' };
  producer.context.emitOutputs(values); values.translated = 'mutated';
  producer.context.emitOutputs({ original: 'same', translated: 'second' });
  await tick();
  assert.deepEqual(grouped, [{ source: 'same', result: 'first' }]);
  assert.deepEqual(other, [{ source: 'same', result: 'first' }, { source: 'same', result: 'second' }]);
  assert.deepEqual(plain, ['first', 'second']);
  let stopped = false; const stopping = pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  held.resolve(); await stopping;
  assert.deepEqual(grouped, [...other]);
  assert.deepEqual(grouped, [{ source: 'same', result: 'first' }, { source: 'same', result: 'second' }, { source: 'tail', result: 'final tail' }]);
  assert.ok(grouped.every(Object.isFrozen));
  assert.deepEqual(plain, ['first', 'second', 'final tail']);
  assert.deepEqual(legacy, grouped.flatMap(values => Object.entries(values)));
  await pipeline.dispose();
});

test('separate emit calls stay separate and async completions publish in completion order', async () => {
  const first = gate(), second = gate(), values = [], producer = {
    outputs: { original: text, translated: text }, start(context) { this.context = context; },
  };
  const pipeline = new Pipeline({ nodes: { producer, receiver: {
    inputs: { source: text, result: text }, receiveInputs(group) { values.push(group); },
  } }, connections: [connection('producer', 'original', 'receiver', 'source'), connection('producer', 'translated', 'receiver', 'result')] });
  await pipeline.start();
  producer.context.emit('original', 'same'); producer.context.emit('translated', 'unpaired');
  const tasks = [first, second].map((held, index) => held.promise.then(() => producer.context.emitOutputs({ original: 'same', translated: String(index) })));
  second.resolve(); await tasks[1]; first.resolve(); await tasks[0];
  await pipeline.stop();
  assert.deepEqual(values, [{ source: 'same' }, { result: 'unpaired' }, { source: 'same', result: '1' }, { source: 'same', result: '0' }]);
  await pipeline.dispose();
});

for (const mode of ['throw', 'fail', 'dispose']) test(`group ${mode} skips queued groups and preserves healthy branches when possible`, async () => {
  const held = gate(), calls = [], independent = [], producer = {
    outputs: { a: text, b: text }, start(context) { this.context = context; },
  };
  const receiver = { inputs: { a: text, b: text }, async receiveInputs(values, context) {
    calls.push(values); await held.promise;
    if (mode === 'throw') throw Error('receiver failure');
    if (mode === 'fail') context.fail(Error('receiver failure'));
  } };
  const pipeline = new Pipeline({ nodes: { producer, receiver, independent: sink((port, value) => independent.push(value)) }, connections: [
    connection('producer', 'a', 'receiver', 'a'), connection('producer', 'b', 'receiver', 'b'), connection('producer', 'b', 'independent', 'text'),
  ] });
  await pipeline.start(); producer.context.emitOutputs({ a: 'same', b: 'one' }); producer.context.emitOutputs({ a: 'same', b: 'two' });
  await tick();
  if (mode === 'dispose') await pipeline.dispose();
  held.resolve(); await tick();
  producer.context.emitOutputs({ a: 'late', b: 'three' });
  if (mode === 'dispose') { await tick(); assert.deepEqual(independent, ['one', 'two']); }
  else { await assert.rejects(pipeline.stop(), AggregateError); assert.deepEqual(independent, ['one', 'two', 'three']); }
  assert.deepEqual(calls, [{ a: 'same', b: 'one' }]);
  await pipeline.dispose();
});

test('invalid group fails before any output is delivered', async () => {
  const producer = source(), values = [];
  const pipeline = new Pipeline({ nodes: { producer, sink: sink((port, value) => values.push(value)) }, connections: [connection('producer', 'text', 'sink', 'text')] });
  await pipeline.start(); producer.context.emitOutputs({ text: 'must not leak', unknown: 'invalid' });
  await assert.rejects(pipeline.stop(), AggregateError);
  assert.deepEqual(values, []); assert.equal(pipeline.errors.length, 1);
  await pipeline.dispose();
});

for (const mode of ['fail', 'dispose']) test(`ordinary receive stops remaining group inputs on ${mode}`, async () => {
  const producer = { outputs: { a: text, b: text }, start(context) { this.context = context; } }, calls = [];
  let pipeline;
  pipeline = new Pipeline({ nodes: { producer, sink: {
    inputs: { a: text, b: text }, async receive(port, value, context) {
      calls.push([port, value]);
      if (mode === 'fail') context.fail(Error('first input failed'));
      else await pipeline.dispose();
    },
  } }, connections: [connection('producer', 'a', 'sink', 'a'), connection('producer', 'b', 'sink', 'b')] });
  await pipeline.start(); producer.context.emitOutputs({ a: 'one', b: 'two' });
  await tick();
  assert.deepEqual(calls, [['a', 'one']]);
  if (mode === 'fail') await assert.rejects(pipeline.stop(), AggregateError);
  await pipeline.dispose();
});


test('explicit groups carry only direct producer input names; independent emits never inherit group context', async () => {
  let a, b; const deliveries = [];
  const pipeline = new Pipeline({ nodes: {
    a: { outputs: { one: text, two: text }, start(c) { a = c; } },
    b: { outputs: { one: text }, start(c) { b = c; } },
    sink: { inputs: { first: text, second: text, independent: text }, receiveInputs(values, c) {
      deliveries.push({ values, group: c.groupInputs });
      if (c.groupInputs) assert.ok(Object.isFrozen(c.groupInputs));
    } },
  }, connections: [
    { from: ['a', 'one'], to: ['sink', 'first'] }, { from: ['a', 'two'], to: ['sink', 'second'] },
    { from: ['b', 'one'], to: ['sink', 'independent'] },
  ] });
  await pipeline.start(); a.emitOutputs({ one: 'source', two: 'text' });
  b.emitOutputs({ one: 'unrelated' }); a.emitOutputs({ one: 'failed source' });
  a.emit('two', 'ordinary'); await pipeline.stop(); await pipeline.dispose();
  assert.deepEqual(deliveries, [
    { values: { first: 'source', second: 'text' }, group: ['first', 'second'] },
    { values: { independent: 'unrelated' }, group: ['independent'] },
    { values: { first: 'failed source' }, group: ['first', 'second'] },
    { values: { second: 'ordinary' }, group: undefined },
  ]);
});
