import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/port-contracts.js';
import { TextAccumulatorNode, TextFormatterNode, parseTemplate } from '../web/text-nodes.js';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph } from '../extension/graph.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const context = () => ({ signal: new AbortController().signal });

test('accumulator preserves exact segments, duplicates and empty strings; reset, Stop and Cancel retain committed history', () => {
  const states = [], node = new TextAccumulatorNode(), c = { ...context(), emit: (port, text) => { assert.equal(port, 'text'); states.push(text); } };
  assert.deepEqual(node.inputs, { append: TEXT });
  node.start(c);
  const accepted = [];
  for (const text of ['', 'same', 'same', '', '  raw\n\t', '']) {
    node.receive('append', text, c); accepted.push(text);
    assert.equal(states.at(-1), accepted.join('\n'));
  }
  const before = states.length;
  for (const values of [{ preview: 'invalid' }, { append: null }, { append: 'valid', preview: 'invalid' }]) assert.throws(() => node.receiveInputs(values, c), /TEXT/);
  assert.equal(Object.hasOwn(node, 'preview'), false); assert.equal(states.length, before);
  node.receive('append', 'late', { ...c, signal: AbortSignal.abort() }); assert.equal(states.length, before);
  node.stop(c); assert.equal(states.length, before); assert.equal(node.text, accepted.join('\n'));
  assert.equal(node.cancel(), accepted.join('\n')); node.dispose(); assert.equal(states.length, before);
  node.receive('append', 'after cancel', c); assert.equal(states.length, before);
  node.start(c); assert.equal(states.at(-1), ''); assert.equal(node.count, 0);
});

test('Pipeline grouped/separate append delivery and generic formatter fan-out retain exact snapshots', async () => {
  let emit, group; const snapshots = [], display = [];
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { final: TEXT, provisional: TEXT }, start(c) { emit = c.emit; group = c.emitOutputs; } }, accumulator: new TextAccumulatorNode(),
    live: new TextSink(text => display.push(text)), formatter: new TextFormatterNode({ template: 'Transcript: {1}' }),
    consumer: { inputs: { text: TEXT }, receive(_, value) { snapshots.push(value); } },
  }, connections: [edge('source', 'final', 'accumulator', 'append'),
    edge('accumulator', 'text', 'live', 'content'), edge('accumulator', 'text', 'formatter', 'input1'), edge('formatter', 'text', 'consumer', 'text')] });
  await pipeline.start(); await tick(); snapshots.length = 0; display.length = 0;
  group({ provisional: '', final: 'A' }); emit('provisional', 'tail'); emit('final', 'A'); emit('final', '');
  await pipeline.stop();
  assert.deepEqual(display, ['A', 'A\nA', 'A\nA\n']);
  assert.deepEqual(snapshots, display.map(s => 'Transcript: ' + s));
  await pipeline.dispose(); const before = display.length; emit('final', 'stale'); await tick(); assert.equal(display.length, before);
});

test('long append-only transcripts retain all text and old immutable snapshots without item-array copies', t => {
  const node = new TextAccumulatorNode(), old = []; let latest;
  const c = { ...context(), emit: (_, text) => { latest = text; if (node.count === 100) old.push(text); } };
  node.start(c); const start = performance.now();
  for (let i = 0; i < 20000; i++) node.receive('append', 'same '.repeat(20), c);
  const elapsed = performance.now() - start;
  assert.equal(node.count, 20000); assert.equal(latest, Array(20000).fill('same '.repeat(20)).join('\n'));
  assert.equal(old[0], Array(100).fill('same '.repeat(20)).join('\n'));
  t.diagnostic(`20,000 appends / ${latest.length} UTF-16 units: ${elapsed.toFixed(1)} ms (Node snapshot construction; excludes DOM/consumer flattening)`);
});

test('accumulator palette/save/reload/runtime uses primitive contracts without a display dependency', () => {
  const graph = { version: defaultGraph().version, nodes: [graphNode('Text', 'source'), graphNode('TextAccumulator', 'acc'), graphNode('FocusedInputTextOutputNode', 'consumer')],
    edges: [edge('source', 'value', 'acc', 'append'), edge('acc', 'text', 'consumer', 'text')] };
  assert.deepEqual(validateGraph(graph), []); assert.deepEqual(assertGraph(graph), graph);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem() {} };
  saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
});

test('formatter has bounded substitutions, literal labels/newlines, escaping and missing values', () => {
  const output = [], node = new TextFormatterNode({ template: 'Source: {1}\n{{{2}}}\nMissing:{4}' }), c = { ...context(), emit: (port, text) => output.push(text) };
  node.receiveInputs({ input1: '<img src=x onerror=alert(1)>', input2: '{1}' }, c);
  assert.deepEqual(output, ['Source: <img src=x onerror=alert(1)>\n{{1}}\nMissing:']);
  node.receive('input1', '', c); assert.equal(output.at(-1), 'Source: \n{{1}}\nMissing:');
  for (const template of ['{0}', '{5}', '{input1}', '{1.x}', '{1', '}', 'a'.repeat(2049)]) assert.throws(() => parseTemplate(template));
  assert.throws(() => node.receive('input2', null, c), /TEXT/);
});

test('direct grouped formatter update emits once; separate branches emit latest values without waiting or matching', async () => {
  let a, b; const result = [], formatter = new TextFormatterNode({ template: '{1}|{2}|{3}' });
  const pipeline = new Pipeline({ nodes: {
    a: { outputs: { one: TEXT, two: TEXT }, start(c) { a = c.emitOutputs; } },
    b: { outputs: { text: TEXT }, start(c) { b = c.emit; } }, formatter,
    sink: new TextSink(state => { result.push(state); }),
  }, connections: [edge('a', 'one', 'formatter', 'input1'), edge('a', 'two', 'formatter', 'input3'), edge('b', 'text', 'formatter', 'input2'), edge('formatter', 'text', 'sink', 'content')] });
  await pipeline.start(); a({ one: 'A', two: 'grouped' }); await tick(); assert.deepEqual(result, ['', 'A||grouped']);
  b('text', 'B'); await tick(); assert.deepEqual(result, ['', 'A||grouped', 'A|B|grouped']);
  a({ one: 'C' }); await pipeline.stop(); assert.deepEqual(result, ['', 'A||grouped', 'A|B|grouped', 'C|B|']); await pipeline.dispose();
});

test('formatter instances have independent counts above four, safe multi-digit references and literal data', () => {
  const a = new TextFormatterNode({ inputCount: 12, template: '{12}\n{5}|{{{1}}}' });
  const b = new TextFormatterNode({ inputCount: 1 });
  const output = [], c = { ...context(), emit: (_, value) => output.push(value) };
  a.receiveInputs({ input12: '<script>{5}</script>', input5: 'five', input1: '{12}' }, c);
  assert.equal(output[0], '<script>{5}</script>\nfive|{{12}}');
  assert.deepEqual(Object.keys(b.inputs), ['input1']); assert.equal(Object.keys(a.inputs).length, 12);
  for (const inputCount of [0, -1, 2.5, null, '5', Infinity]) assert.throws(() => new TextFormatterNode({ inputCount }), /positive whole number/);
  assert.throws(() => new TextFormatterNode({ inputCount: 5, template: '{6}' }), /not configured.*Add inputs/);
  assert.throws(() => a.receive('input13', 'bad', c), /TEXT/);
  assert.throws(() => parseTemplate('{01}', 12), /literal braces/);
});

class TextSink {
  inputs = { content: TEXT }; outputs = {};
  constructor(callback) { this.callback = callback; }
  start() { this.callback(''); }
  receive(_, text, context) { if (!context.signal.aborted) this.callback(text); }
}
