import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextWindowNode } from '../web/text-window-node.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { Pipeline } from '../web/pipeline.js';
import { edge, NODE_TYPES, graphNode, defaultGraph, validateGraph } from '../extension/graph.js';

function buffer(limits = {}) {
  const node = new TextWindowNode(), outputs = [], controller = new AbortController();
  node.start({ signal: controller.signal, emit: (port, text) => outputs.push({ port, text }) });
  node.receiveInputs(limits);
  return { node, outputs, controller, texts: () => outputs.map(o => o.text) };
}
const mockTime = t => t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });

test('TextWindow editor/runtime expose one TEXT output and two optional NUMBER inputs without Settings', () => {
  const node = new TextWindowNode(), definition = NODE_TYPES.TextWindow;
  assert.deepEqual(node.inputs, { text: TEXT, maxChars: NUMBER, maxWaitSeconds: NUMBER });
  assert.deepEqual(node.outputs, { text: TEXT });
  assert.deepEqual(definition.inputs, node.inputs); assert.deepEqual(definition.outputs, node.outputs);
  assert.deepEqual(definition.optionalInputs, ['maxChars', 'maxWaitSeconds']);
  for (const key of ['settings', 'numberSettings', 'textSettings']) assert.equal(definition[key], undefined);
  const graph = defaultGraph(); graph.nodes.push(graphNode('TextWindow', 'window'));
  graph.edges.push(edge('speech', 'final', 'window', 'text'));
  assert.deepEqual(validateGraph(graph), []);
  graph.edges.push(edge('window', 'provisional', 'transcript-preview', 'text'));
  assert.match(validateGraph(graph).join(' '), /Unknown port: window.provisional/);
});

test('defaults batch exact ordered content, including punctuation, whitespace, repeats and crossing fragments', () => {
  const f = buffer();
  const fragments = ['One. Two!。！？', '\t\n', 'same', 'same', 'x'.repeat(1800), 'tail'];
  for (const text of fragments) f.node.receive('text', text);
  assert.deepEqual(f.texts().map(s => s.length), [600, 600, 600]);
  assert.ok(f.node.pending.length > 0);
  f.node.stop(); f.node.stop();
  assert.equal(f.texts().join(''), fragments.join(''));
  assert.equal(f.node.pending, ''); assert.equal(f.node.timer, null);
  assert.ok(f.outputs.every(o => o.port === 'text'));
});

test('2,000-character batches and surrogate-safe remainders preserve all accepted code units', () => {
  const f = buffer({ maxChars: 2000 });
  f.node.receive('text', 'x'.repeat(1999)); f.node.receive('text', '😀' + 'z'.repeat(4000));
  assert.deepEqual(f.texts().map(s => s.length), [1999, 2000, 2000]);
  assert.equal(f.node.pending, 'zz');
  f.node.stop(); assert.equal(f.texts().join(''), 'x'.repeat(1999) + '😀' + 'z'.repeat(4000));
  for (const text of f.texts()) assert.ok(text.length <= 2000 && !/[\uD800-\uDBFF]$/.test(text) && !/^[\uDC00-\uDFFF]/.test(text));
  const g = buffer({ maxChars: 7 });
  const text = '  a😀b😀c\n'.repeat(50);
  g.node.receive('text', text); g.node.stop(); assert.equal(g.texts().join(''), text);
});

test('default deadline starts on first nonempty text, is not extended, and the next window has its own deadline', t => {
  mockTime(t); const f = buffer();
  t.mock.timers.tick(5000); f.node.receive('text', ''); t.mock.timers.tick(5000);
  assert.deepEqual(f.texts(), []); assert.equal(f.node.timer, null);
  f.node.receive('text', 'One.'); t.mock.timers.tick(1400); f.node.receive('text', 'Two!');
  t.mock.timers.tick(99); assert.deepEqual(f.texts(), []);
  t.mock.timers.tick(1); assert.deepEqual(f.texts(), ['One.Two!']);
  f.node.receive('text', 'next'); t.mock.timers.tick(1499); assert.deepEqual(f.texts(), ['One.Two!']);
  t.mock.timers.tick(1); assert.deepEqual(f.texts(), ['One.Two!', 'next']); f.node.dispose();
});

test('fractional-millisecond wait limits round up instead of emitting before their deadline', t => {
  mockTime(t); const f = buffer({ maxWaitSeconds: 0.0015 });
  f.node.receive('text', 'fractional'); t.mock.timers.tick(1); assert.deepEqual(f.texts(), []);
  t.mock.timers.tick(1); assert.deepEqual(f.texts(), ['fractional']); f.node.dispose();
});

test('independent limits update pending text immediately without resetting the first-fragment deadline', t => {
  mockTime(t); const f = buffer();
  f.node.receive('maxWaitSeconds', 2); assert.equal(f.node.maxChars, 600);
  f.node.receive('text', 'abcdefghij'); t.mock.timers.tick(500);
  f.node.receive('maxWaitSeconds', 1); t.mock.timers.tick(499); assert.deepEqual(f.texts(), []);
  f.node.receive('maxChars', 4); assert.deepEqual(f.texts(), ['abcd', 'efgh']); assert.equal(f.node.pending, 'ij');
  assert.equal(f.node.maxWaitSeconds, 1);
  t.mock.timers.tick(999); assert.deepEqual(f.texts(), ['abcd', 'efgh']);
  t.mock.timers.tick(1); assert.deepEqual(f.texts(), ['abcd', 'efgh', 'ij']);
  f.node.receive('text', 'tail'); t.mock.timers.tick(100); f.node.receive('maxWaitSeconds', 0.05);
  assert.deepEqual(f.texts(), ['abcd', 'efgh', 'ij', 'tail']); f.node.dispose();
});

test('wait updates can extend a deadline from the original arrival and shorten an already elapsed deadline', t => {
  mockTime(t); const f = buffer({ maxWaitSeconds: 1 });
  f.node.receive('text', 'a'); t.mock.timers.tick(500); f.node.receive('maxWaitSeconds', 2);
  t.mock.timers.tick(1499); assert.deepEqual(f.texts(), []);
  t.mock.timers.tick(1); assert.deepEqual(f.texts(), ['a']);
  f.node.receive('text', 'b'); t.mock.timers.tick(100); f.node.receive('maxWaitSeconds', 0.05);
  assert.deepEqual(f.texts(), ['a', 'b']); f.node.dispose();
});

test('grouped thresholds are validated atomically, applied before text, and omitted inputs retain their last values', t => {
  mockTime(t); const f = buffer();
  f.node.receiveInputs({ text: 'abcdefg', maxWaitSeconds: 0.1, maxChars: 3 });
  assert.deepEqual(f.texts(), ['abc', 'def']); assert.equal(f.node.pending, 'g');
  f.node.receiveInputs({ text: 'hi' }); assert.deepEqual(f.texts(), ['abc', 'def', 'ghi']);
  f.node.receiveInputs({ text: 'j' }); t.mock.timers.tick(100); assert.equal(f.texts().at(-1), 'j');
  assert.throws(() => f.node.receiveInputs({ maxChars: 2, maxWaitSeconds: 0, text: 'lost?' }), /maxWaitSeconds/);
  assert.equal(f.node.maxChars, 3); assert.equal(f.node.pending, ''); f.node.dispose();
});

test('invalid values fail visibly without coercion, changing limits or accepting partial text', () => {
  const f = buffer();
  for (const value of [undefined, null, '2000', true, NaN, Infinity, -1, 0, 1, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.node.receive('maxChars', value), /maxChars.*NUMBER/);
  }
  for (const value of [undefined, null, '1.5', true, NaN, Infinity, -1, 0, 2147483.648]) {
    assert.throws(() => f.node.receive('maxWaitSeconds', value), /maxWaitSeconds.*NUMBER/);
  }
  assert.equal(f.node.maxChars, 600); assert.equal(f.node.maxWaitSeconds, 1.5);
  assert.throws(() => f.node.receive('text', null), /TEXT/);
  assert.throws(() => f.node.receive('bad', 'x'), /Unknown TextWindow input/);
  assert.throws(() => f.node.receive('text', 'x'.repeat(32769)), /32,768/);
  assert.deepEqual(f.texts(), []); assert.equal(f.node.pending, ''); f.node.dispose();
});

for (const operation of ['stop', 'dispose', 'abort']) test(`${operation} clears timers and rejects late text and numeric deliveries`, t => {
  mockTime(t); const f = buffer({ maxWaitSeconds: 0.1 });
  f.node.receive('text', 'tail');
  if (operation === 'abort') f.controller.abort(); else f.node[operation]();
  f.node.receive('text', 'late'); f.node.receive('maxChars', 2); f.node.stop();
  t.mock.timers.tick(1000);
  assert.deepEqual(f.texts(), operation === 'stop' ? ['tail'] : []);
  assert.equal(f.node.pending, ''); assert.equal(f.node.timer, null);
});

test('Pipeline reports invalid thresholds while independent branches continue', async () => {
  const outputs = [], errors = [];
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT, number: NUMBER } }, window: new TextWindowNode(),
    sink: { inputs: { text: TEXT }, receive(_, text) { outputs.push(text); } },
  }, connections: [edge('source', 'text', 'window', 'text'), edge('source', 'number', 'window', 'maxChars'), edge('source', 'text', 'sink', 'text')], onError: e => errors.push(e.message) });
  await pipeline.start(); const source = pipeline.entries.get('source').context;
  source.emit('number', '2000'); source.emit('text', 'peer'); await new Promise(r => setImmediate(r));
  assert.match(errors.join(' '), /maxChars.*NUMBER/); assert.deepEqual(outputs, ['peer']); await pipeline.dispose();
});

test('superseded and late timer callbacks cannot emit after updates, Stop or Cancel', t => {
  const callbacks = [];
  t.mock.method(globalThis, 'setTimeout', callback => { callbacks.push(callback); return callbacks.length; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const f = buffer(); f.node.receive('text', 'tail'); const old = callbacks.at(-1);
  f.node.receive('maxWaitSeconds', 2); old(); assert.deepEqual(f.texts(), []);
  const latest = callbacks.at(-1); f.node.stop(); latest(); old(); assert.deepEqual(f.texts(), ['tail']);
  const g = buffer(); g.node.receive('text', 'discard'); const canceled = callbacks.at(-1);
  g.controller.abort(); canceled(); assert.deepEqual(g.texts(), []);
});

test('connected threshold sources that never emit use both defaults without blocking text', async () => {
  const window = new TextWindowNode(), outputs = [];
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT, limit: NUMBER }, start(c) { c.emit('text', 'x'.repeat(601)); } }, window,
    sink: { inputs: { text: TEXT }, receive(_, text) { outputs.push(text); } },
  }, connections: [edge('source', 'text', 'window', 'text'), edge('source', 'limit', 'window', 'maxChars'), edge('source', 'limit', 'window', 'maxWaitSeconds'), edge('window', 'text', 'sink', 'text')] });
  await pipeline.start(); await new Promise(r => setImmediate(r));
  assert.deepEqual(outputs.map(s => s.length), [600]); assert.equal(window.maxWaitSeconds, 1.5); assert.equal(window.pending, 'x');
  await pipeline.stop(); assert.deepEqual(outputs.map(s => s.length), [600, 1]); await pipeline.dispose();
});
