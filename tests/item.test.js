import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { document } from './fixtures/dom.js';
import { snapshotPairedText, snapshotPairedTextList, snapshotItem } from '../web/paired-text.js';
import { TEXT, NUMBER, ITEM, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST, compatiblePorts } from '../web/port-contracts.js';
import { Pipeline, portContract } from '../web/pipeline.js';
import { KeyedPairedTextAccumulatorNode } from '../web/keyed-paired-text-accumulator-node.js';
import { KeyedTextPairNode } from '../web/keyed-text-pair-node.js';
import { DisplayNode } from '../web/display-node.js';
import { GraphEditor } from '../extension/graph-editor.js';
import { NODE_TYPES, GRAPH_VERSION, GRAPH_KEY, graphNode, edge, assertGraph, validateGraph, executableGraph, readGraph, saveGraph } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { itemGraph } from './fixtures/item-graph.js';

const pair = (id, first = '', second = '') => ({ id, first, second });
const cells = dom => [...dom.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent));
function fixture(node = new KeyedPairedTextAccumulatorNode()) {
  const out = [], context = { signal: new AbortController().signal, emit: (_, value) => out.push(value) };
  node.start(context);
  return { node, out, context, send: value => node.receive('pair', value, context) };
}
function storage(raw) {
  const values = new Map([[GRAPH_KEY, raw], ['older recovery']]);
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}

test('portable contracts accept exactly one finite ID/two strings or a dense ordered unique-ID array, independently of DOM', () => {
  const input = [pair(-2.5, '', '<script>\n日本語'), pair(1e30, 'B')], copy = snapshotPairedTextList(input);
  assert.deepEqual(copy, input); assert.deepEqual(structuredClone(copy), input); assert.deepEqual(JSON.parse(JSON.stringify(copy)), input);
  input[0].first = 'changed'; input.push(pair(3));
  assert.equal(copy.length, 2); assert.equal(copy[0].first, '');
  assert.ok(Object.isFrozen(copy)); assert.ok(copy.every(Object.isFrozen));
  assert.deepEqual(snapshotPairedTextList([]), []); assert.equal(snapshotItem(''), '');
  for (const value of [null, undefined, [], '', 1, document.createElement('div'), pair(NaN), pair(Infinity), pair('1'),
    { id: 1, first: '' }, pair(1, null), pair(1, '', 2), { ...pair(1), stage: 'final' }, { ...pair(1), html: '' },
    { ...pair(1), [Symbol()]: '' }, { id: 1, get first() { throw Error('Must not read accessor'); }, second: '' },
    Object.defineProperty({ id: 1, first: '' }, 'second', { value: '' })]) assert.throws(() => snapshotPairedText(value), TypeError);
  for (const value of [null, {}, Array(1), [pair(0), pair(-0)], [pair(1), pair(1)], [pair(1), null],
    Object.assign([], { extra: 1 }), new (class extends Array {})(),
    Object.defineProperty([], '0', { get() { throw Error('Must not read accessor'); }, enumerable: true })]) {
    assert.throws(() => snapshotPairedTextList(value), TypeError);
  }
  for (const name of ['paired-text.js', 'keyed-paired-text-accumulator-node.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8'), /document\.|window\.|createElement|innerHTML/);
  }
});

test('small directional compatibility matrix preserves strict concrete contracts and shared identities', () => {
  const contracts = [TEXT, NUMBER, ITEM, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST, portContract('text')];
  for (const output of contracts) for (const input of contracts) {
    assert.equal(compatiblePorts(output, input), output === input || (input === ITEM && [TEXT, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST].includes(output)));
  }
  assert.equal(compatiblePorts(undefined, undefined), false);
});

test('accumulator appends/replaces in arrival order, emits duplicates and empty clears, and owns full independent snapshots', () => {
  const f = fixture(), first = pair(2, 'A'); f.send(first); first.first = 'mutated';
  f.send(pair(1, 'B', 'translated B')); f.send(pair(2, 'final A', 'translation')); f.send(pair(2, 'late earlier stage'));
  f.send(pair(2)); f.send(pair(2));
  assert.deepEqual(f.out, [[], [pair(2, 'A')], [pair(2, 'A'), pair(1, 'B', 'translated B')],
    [pair(2, 'final A', 'translation'), pair(1, 'B', 'translated B')], [pair(2, 'late earlier stage'), pair(1, 'B', 'translated B')],
    [pair(2), pair(1, 'B', 'translated B')], [pair(2), pair(1, 'B', 'translated B')]]);
  assert.notEqual(f.out[1][0], f.out[2][0]); assert.ok(f.out.every(Object.isFrozen));
  const count = f.out.length;
  assert.throws(() => f.send({ ...pair(3), extra: '' }), TypeError);
  assert.throws(() => f.node.receiveInputs({ pair: pair(3), text: '' }, f.context), TypeError);
  assert.equal(f.out.length, count); assert.equal(f.node.pairs.has(3), false);
});

for (const close of ['stop', 'cancel', 'dispose', 'abort']) test(`accumulator and Display ${close} retain state, reject late work and clear on restart`, () => {
  const f = fixture(), out = [], display = new DisplayNode(dom => out.push(dom)); display.start(f.context);
  f.send(pair(1, 'kept')); display.receive('input', f.out.at(-1), f.context);
  if (close === 'abort') {
    // The same lifecycle rule applies to an aborted context even without close.
    const aborted = { ...f.context, signal: AbortSignal.abort() };
    f.node.receive('pair', pair(2), aborted); display.receive('input', '', aborted);
  } else { f.node[close](); display[close](); f.send(pair(2)); display.receive('input', '', f.context); }
  assert.deepEqual(f.out.at(-1), [pair(1, 'kept')]); assert.deepEqual(cells(out.at(-1)), [['kept', '']]);
  const next = fixture(f.node); display.start(next.context);
  f.send(pair(3)); display.receive('input', 'stale', f.context);
  assert.deepEqual(next.out, [[]]); assert.equal(out.at(-1).childNodes.length, 0);
});

test('Display has one ITEM input, renders literal TEXT/pair/list and never accumulates or mutates values', () => {
  const out = [], node = new DisplayNode(dom => out.push(dom)), context = { signal: new AbortController().signal };
  assert.deepEqual(node.inputs, { input: ITEM }); assert.deepEqual(node.outputs, {});
  node.start(context); const input = [pair(1, '<img src=x onerror=alert(1)>\n&', ''), pair(2, 'B', '<script>')];
  const original = structuredClone(input); node.receive('input', input, context);
  assert.deepEqual(cells(out.at(-1)), input.map(p => [p.first, p.second]));
  assert.equal(out.at(-1).querySelector('img,script'), null); assert.deepEqual(input, original);
  out.at(-1).querySelector('td').textContent = 'mutated DOM';
  node.receive('input', pair(2, 'only B'), context); assert.deepEqual(cells(out.at(-1)), [['only B', '']]);
  node.receive('input', '<b>latest</b>\ntext', context); assert.equal(out.at(-1).firstChild.textContent, '<b>latest</b>\ntext');
  assert.equal(out.at(-1).querySelector('b,table'), null);
  node.receive('input', '', context); assert.equal(out.at(-1).firstChild.textContent, '');
  node.receive('input', [], context); assert.equal(out.at(-1).childNodes.length, 0);
  assert.equal(Object.hasOwn(node, 'pairs'), false); assert.equal(Object.hasOwn(node, 'rows'), false);
  for (const invalid of [1, {}, { rows: [] }, document.createElement('div')]) assert.throws(() => node.receive('input', invalid, context), TypeError);
  assert.throws(() => node.receive('view', { rows: [] }, context), TypeError);
});

for (const reverse of [false, true]) test(`arbitrary output names/types, immutable fan-out and type validation before queued dispatch (${reverse})`, async () => {
  for (const [contract, value] of [[TEXT, 'literal'], [KEYED_PAIRED_TEXT, pair(1, 'A')], [KEYED_PAIRED_TEXT_LIST, [pair(1, 'A')]], [ITEM, pair(2)]]) {
    let source; const received = [], outputs = [];
    const connections = [edge('any', 'arbitrary', 'observer', 'value'), edge('any', 'arbitrary', 'display', 'input')];
    const pipeline = new Pipeline({ nodes: {
      any: { outputs: { arbitrary: contract }, start(c) { source = c; } },
      observer: { inputs: { value: ITEM }, receive(_, v) { received.push(v); if (typeof v === 'object') assert.throws(() => { v.id = 10; }, TypeError); } },
      display: new DisplayNode(dom => outputs.push(dom)),
    }, connections: reverse ? connections.reverse() : connections });
    await pipeline.start(); source.emit('arbitrary', value);
    if (Array.isArray(value)) value[0].first = 'caller mutation'; else if (typeof value === 'object') value.first = 'caller mutation';
    await pipeline.stop(); assert.deepEqual(pipeline.errors, []); assert.equal(received.length, 1);
    assert.doesNotMatch(outputs.at(-1).firstChild.textContent, /caller mutation/); await pipeline.dispose();
  }
  for (const contract of [NUMBER, portContract('other')]) assert.throws(() => new Pipeline({ nodes: {
    any: { outputs: { arbitrary: contract } }, display: new DisplayNode(),
  }, connections: [edge('any', 'arbitrary', 'display', 'input')] }), /Incompatible/);
});

test('runtime rejects values contradicting declared concrete types without any fan-out delivery', async () => {
  for (const [contract, value] of [[TEXT, pair(1)], [KEYED_PAIRED_TEXT, 'text'], [KEYED_PAIRED_TEXT_LIST, [pair(1), pair(1)]], [ITEM, { arbitrary: 1 }]]) {
    let source; const received = [];
    const pipeline = new Pipeline({ nodes: {
      any: { outputs: { value: contract }, start(c) { source = c; } }, sink: { inputs: { input: ITEM }, receive(_, v) { received.push(v); } },
    }, connections: [edge('any', 'value', 'sink', 'input')] });
    await pipeline.start(); source.emit('value', value); await assert.rejects(pipeline.stop(), /failed while draining/);
    assert.equal(pipeline.errors.length, 1); assert.deepEqual(received, []); await pipeline.dispose();
  }
});

test('editor, saved validation and executable selection accept concrete ITEM streams, enforce one edge and reject unrelated types', async () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Number', 'number'), graphNode('KeyedTextPair', 'pair'), graphNode('KeyedPairedTextAccumulator', 'history'), graphNode('Display', 'display')], edges: [] };
  const editor = Object.assign(Object.create(GraphEditor.prototype), { draft: graph, draw() {}, canvas: { querySelector() {} } });
  for (const [source, port] of [['text', 'value'], ['pair', 'pair'], ['history', 'pairs'], ['text', 'value']]) {
    editor.selected = { id: source, port, contract: NODE_TYPES[graph.nodes.find(n => n.id === source).type].outputs[port] };
    editor.connect('display', 'input', ITEM);
    assert.deepEqual(graph.edges, [edge(source, port, 'display', 'input')]); assert.deepEqual(validateGraph(graph), []);
    const store = storage(null); saveGraph(store, graph); assert.deepEqual(readGraph(store), graph);
  }
  assert.deepEqual(executableGraph(graph).nodes.map(n => n.id), ['text', 'display']);
  for (const [source, port] of [['number', 'value']]) {
    const invalid = { ...graph, edges: [edge(source, port, 'display', 'input')] };
    assert.match(validateGraph(invalid).join(), /Incompatible/); assert.throws(() => executableGraph(invalid), /Incompatible/);
    assert.throws(() => saveGraph(storage(null), invalid), /Incompatible/);
    editor.selected = { id: source, port, contract: NODE_TYPES[graph.nodes.find(n => n.id === source).type].outputs[port] };
    editor.connect('display', 'input', ITEM); assert.deepEqual(graph.edges, [edge('text', 'value', 'display', 'input')]);
  }
  assert.match(validateGraph({ ...graph, edges: [edge('text', 'value', 'history', 'pair')] }).join(), /Incompatible/);
  assert.match(validateGraph({ ...graph, edges: [edge('text', 'value', 'display', 'input'), edge('pair', 'pair', 'display', 'input')] }).join(), /Only one/);
  graph.nodes[0].settings.value = 'direct'; const out = [], built = buildGraph(graph, { onDisplay: (_, dom) => out.push(dom) });
  await built.pipeline.start(); await built.pipeline.stop(); assert.equal(out.at(-1).firstChild.textContent, 'direct'); await built.pipeline.dispose();
});

test('pair snapshots remain independent across same-ID changes; new accumulator has strict concrete contracts and ordinary packaging', () => {
  const out = [], node = new KeyedTextPairNode(), context = { signal: new AbortController().signal, emitOutputs: v => out.push(v) };
  node.start(context); node.receiveInputs({ id1: 1, input1: 'A' }, context); node.receiveInputs({ id2: 1, input2: 'translated' }, context);
  assert.deepEqual(out[0].pair, pair(1, 'A')); assert.deepEqual(out[1].pair, pair(1, 'A', 'translated'));
  assert.notEqual(out[0].pair, out[1].pair);
  for (const [type, instance] of [['KeyedPairedTextAccumulator', new KeyedPairedTextAccumulatorNode()], ['Display', new DisplayNode()]]) {
    assert.deepEqual(NODE_TYPES[type].inputs, instance.inputs); assert.deepEqual(NODE_TYPES[type].outputs, instance.outputs);
    assert.deepEqual(graphNode(type, type).settings, {});
  }
  const bundle = readFileSync(new URL('../scripts/build-extension.py', import.meta.url), 'utf8');
  for (const name of ['paired-text.js', 'keyed-paired-text-accumulator-node.js', 'display-node.js']) assert.ok(bundle.includes(`"${name}"`));
});

test('importable ITEM graph matches the exact independently keyed ASR/translation fixture', () => {
  const graph = JSON.parse(readFileSync(new URL('../docs/evidence/item-198.json', import.meta.url), 'utf8'));
  assert.deepEqual(graph, itemGraph()); assert.deepEqual(executableGraph(graph), graph);
  assert.deepEqual(assertGraph(graph), graph);
});
