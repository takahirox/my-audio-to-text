import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { KeyedTextPairNode } from '../web/keyed-text-pair-node.js';
import { NUMBER, TEXT, KEYED_PAIRED_TEXT } from '../web/port-contracts.js';
import { NumberNode } from '../web/number-node.js';
import { Pipeline } from '../web/pipeline.js';
import { NODE_TYPES, graphNode, edge, graphWarnings, executableGraph, GRAPH_VERSION } from '../extension/graph.js';

function fixture(node = new KeyedTextPairNode()) {
  const out = [], controller = new AbortController();
  const context = { signal: controller.signal, emitOutputs: value => { assert.deepEqual(Object.keys(value), ['pair']); const { pair } = value; assert.ok(Object.isFrozen(pair)); out.push({ id: pair.id, input1: pair.first, input2: pair.second }); } };
  node.start(context);
  return { node, out, context, controller, send: v => node.receiveInputs(v, context) };
}
test('generic primitive contracts, no settings, registered in the extension bundle', () => {
  const node = new KeyedTextPairNode();
  assert.deepEqual(node.inputs, { id1: NUMBER, input1: TEXT, id2: NUMBER, input2: TEXT });
  assert.deepEqual(node.outputs, { pair: KEYED_PAIRED_TEXT });
  assert.deepEqual(NODE_TYPES.KeyedTextPair.inputs, node.inputs);
  assert.deepEqual(NODE_TYPES.KeyedTextPair.outputs, node.outputs);
  assert.deepEqual(graphNode('KeyedTextPair', 'pair').settings, {});
  for (const field of ['settings', 'numberSettings', 'textSettings']) assert.equal(NODE_TYPES.KeyedTextPair[field], undefined);
  const source = readFileSync(new URL('../web/keyed-text-pair-node.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /document|window|DOM|provisional|Settings/);
  assert.match(readFileSync(new URL('../scripts/build-extension.py', import.meta.url), 'utf8'), /"keyed-text-pair-node.js"/);
});
test('separate branches, text-first, ID-first, ID-only, same-ID, empty, duplicates and late translation', () => {
  const { send, out } = fixture();
  send({ input2: 'superseded' }); send({ input2: '' });
  send({ id1: 1 }); assert.equal(out.length, 0, 'left ID cannot identify right text');
  send({ input1: 'A' }); send({ id1: 2 }); send({ input1: 'B' });
  send({ id2: 1 }); send({ input2: 'translated A' });
  send({ id2: 2 }); send({ id2: 1 }); send({ id1: 1 });
  assert.equal(out.length, 4, 'ID-only events never replay old text');
  send({ input1: '' }); send({ input2: '' }); send({ input2: '' });
  assert.deepEqual(out, [
    { id: 1, input1: 'A', input2: '' }, { id: 2, input1: 'B', input2: '' },
    { id: 1, input1: 'A', input2: '' }, { id: 1, input1: 'A', input2: 'translated A' },
    { id: 1, input1: '', input2: 'translated A' }, { id: 1, input1: '', input2: '' }, { id: 1, input1: '', input2: '' },
  ]);
});
test('atomic groups apply both branches before one complete snapshot per key, regardless of property order', () => {
  const { node, context, send, out } = fixture();
  const c = { ...context, groupInputs: ['id1', 'input1', 'id2', 'input2'] };
  node.receiveInputs({ input2: 'right', input1: 'left', id2: 1, id1: 1 }, c);
  assert.deepEqual(out, [{ id: 1, input1: 'left', input2: 'right' }]);
  node.receiveInputs({ id1: 1, input1: '', id2: 2, input2: 'two' }, c);
  assert.deepEqual(out.slice(-2), [{ id: 1, input1: '', input2: 'right' }, { id: 2, input1: '', input2: 'two' }]);
  node.receiveInputs({ input1: 'unidentified' }, c); assert.equal(out.length, 3);
  send({ id1: 3 }); assert.deepEqual(out.at(-1), { id: 3, input1: 'unidentified', input2: '' });
});
test('finite numeric Map keys and whole-delivery validation', () => {
  const { send, out, node, context } = fixture();
  for (const id of [-2.5, 1e30, 0, -0]) send({ id1: id, input1: `${id}` });
  assert.equal(node.branches[0].values.size, 3);
  for (const id of [NaN, Infinity, -Infinity, '1', null, undefined]) for (const port of ['id1', 'id2']) {
    assert.throws(() => send({ input2: 'invalid', [port]: id }), /finite number/);
  }
  assert.throws(() => send({ id1: 10, input2: null }), /TEXT/);
  assert.throws(() => node.receive('other', '', context), /Unknown/);
  send({ input1: 'still zero' }); assert.deepEqual(out.at(-1), { id: 0, input1: 'still zero', input2: '' });
  send({ id2: 1 }); assert.equal(out.length, 5, 'invalid text was never buffered');
});
for (const close of ['stop', 'cancel', 'dispose', 'abort']) test(`${close} rejects stale work and Start resets values and pending text`, () => {
  const f = fixture(); f.send({ id1: 1, input1: 'old' }); f.send({ input2: 'pending' });
  if (close === 'abort') f.controller.abort(); else f.node[close]();
  f.send({ id2: 1, input2: 'late' }); assert.equal(f.out.length, 1);
  const fresh = fixture(f.node); f.send({ id1: 1, input1: 'stale context' });
  fresh.send({ id2: 1 }); assert.equal(fresh.out.length, 0);
  fresh.send({ input2: '' }); assert.deepEqual(fresh.out, [{ id: 1, input1: '', input2: '' }]);
});
for (const reverse of [false, true]) test(`independent NUMBER/TEXT sources and grouped snapshot fan-out (${reverse})`, async () => {
  const out = [], plain = []; let left, right;
  const connections = [edge('key1', 'value', 'pair', 'id1'), edge('key2', 'value', 'pair', 'id2'),
    edge('left', 'arbitrary', 'pair', 'input1'), edge('right', 'other', 'pair', 'input2'),
    edge('pair', 'pair', 'sink', 'pair'), edge('pair', 'pair', 'plain', 'pair')];
  const pipeline = new Pipeline({ nodes: {
    key1: new NumberNode({ value: 1 }), key2: new NumberNode({ value: 2 }),
    left: { outputs: { arbitrary: TEXT }, start(c) { left = c; } },
    right: { outputs: { other: TEXT }, start(c) { right = c; } }, pair: new KeyedTextPairNode(),
    sink: { inputs: { pair: KEYED_PAIRED_TEXT }, receiveInputs(v) { assert.ok(Object.isFrozen(v.pair)); out.push({ id: v.pair.id, input1: v.pair.first, input2: v.pair.second }); } },
    plain: { inputs: { pair: KEYED_PAIRED_TEXT }, receive(_, v) { plain.push(v.first); } },
  }, connections: reverse ? connections.reverse() : connections });
  await pipeline.start(); right.emit('other', 'R2'); left.emit('arbitrary', 'L1');
  await new Promise(resolve => setImmediate(resolve));
  pipeline.entries.get('key2').context.emit('value', 1); right.emit('other', 'R1');
  await pipeline.stop();
  assert.deepEqual(out, [{ id: 2, input1: '', input2: 'R2' }, { id: 1, input1: 'L1', input2: '' }, { id: 1, input1: 'L1', input2: 'R1' }]);
  assert.deepEqual(plain, ['', 'L1', 'L1']); assert.deepEqual(pipeline.errors, []); await pipeline.dispose();
});
test('unfinished branches stay saveable; either complete branch is executable', () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Number', 'id'), graphNode('Text', 'text'), graphNode('KeyedTextPair', 'pair'), graphNode('Display', 'display')],
    edges: [edge('id', 'value', 'pair', 'id1'), edge('pair', 'pair', 'display', 'input')] };
  assert.match(graphWarnings(graph).join(), /pair needs an ID\/TEXT pair/);
  assert.equal(executableGraph(graph).nodes.length, 0);
  graph.edges.push(edge('text', 'value', 'pair', 'input1'));
  assert.equal(executableGraph(graph).nodes.length, 4);
  graph.edges = graph.edges.map(r => r.to[0] === 'pair' ? { ...r, to: ['pair', r.to[1] === 'id1' ? 'id2' : 'input2'] } : r);
  assert.equal(executableGraph(graph).nodes.length, 4);
});
