import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { domText } from './fixtures/dom.js';
import { KeyedTextCoalesceNode } from '../web/keyed-text-coalesce-node.js';
import { NUMBER, TEXT } from '../web/port-contracts.js';
import { NumberNode } from '../web/number-node.js';
import { Pipeline } from '../web/pipeline.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { GraphEditor } from '../extension/graph-editor.js';
import { NODE_TYPES, GRAPH_VERSION, graphNode, edge, validateGraph, graphWarnings, executableGraph, saveGraph, readGraph } from '../extension/graph.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(node = new KeyedTextCoalesceNode()) {
  const out = [], controller = new AbortController();
  const context = { signal: controller.signal, emitOutputs: values => out.push(values) };
  node.start(context);
  return { node, out, context, controller, send: values => node.receiveInputs(values, context) };
}

test('primitive ports, no Settings, generic Help and runtime contract agree', () => {
  const node = new KeyedTextCoalesceNode(), definition = NODE_TYPES.KeyedTextCoalesce;
  assert.deepEqual(node.inputs, { id1: NUMBER, input1: TEXT, id2: NUMBER, input2: TEXT });
  assert.deepEqual(node.outputs, { id: NUMBER, text: TEXT });
  assert.deepEqual(definition.inputs, node.inputs); assert.deepEqual(definition.outputs, node.outputs);
  assert.deepEqual(graphNode('KeyedTextCoalesce', 'select').settings, {});
  for (const key of ['settings', 'numberSettings', 'textSettings']) assert.equal(definition[key], undefined);
  assert.match(definition.help, /Number.value/); assert.match(definition.help, /independent/);
  assert.match(readFileSync(new URL('../scripts/build-extension.py', import.meta.url), 'utf8'), /"keyed-text-coalesce-node.js"/);
});

for (const order of [[1, 2], [2, 1]]) test(`priority, absent/empty, duplicates and whitespace (${order})`, () => {
  const { send, out } = fixture();
  for (const n of order) send({ [`id${n}`]: 10, [`input${n}`]: n === 1 ? 'preferred' : 'backup' });
  assert.deepEqual(out, order[0] === 1 ? [{ id: 10, text: 'preferred' }, { id: 10, text: 'preferred' }]
    : [{ id: 10, text: 'backup' }, { id: 10, text: 'preferred' }]);
  for (const [values, text] of [
    [{ input1: 'preferred' }, 'preferred'], [{ input2: '' }, 'preferred'],
    [{ input2: 'latest backup' }, 'preferred'], [{ input1: '' }, 'latest backup'],
    [{ input1: '' }, 'latest backup'], [{ input2: '' }, ''], [{ input2: '' }, ''],
    [{ input1: ' \n' }, ' \n'], [{ input2: 'backup again' }, ' \n'], [{ input1: '' }, 'backup again'],
  ]) {
    const count = out.length; send(values);
    assert.equal(out.length, count + 1); assert.deepEqual(out.at(-1), { id: 10, text });
  }
  send({ id1: 11, input1: '' }); assert.deepEqual(out.at(-1), { id: 11, text: '' });
});

test('interleaved keys retain both branches separately; ID-only changes never replay or blank', () => {
  const { send, out } = fixture();
  for (const values of [
    { id2: 10, input2: 'backup 10' }, { id2: 11, input2: 'backup 11' },
    { id1: 10, input1: 'preferred 10' }, { input2: 'new backup 11' },
    { id1: 11, input1: 'preferred 11' }, { id1: 10, input1: '' },
    { id2: 10, input2: 'new backup 10' }, { id2: 11, input2: '' }, { id1: 11, input1: '' },
  ]) send(values);
  assert.deepEqual(out, [
    { id: 10, text: 'backup 10' }, { id: 11, text: 'backup 11' },
    { id: 10, text: 'preferred 10' }, { id: 11, text: 'new backup 11' },
    { id: 11, text: 'preferred 11' }, { id: 10, text: 'backup 10' },
    { id: 10, text: 'new backup 10' }, { id: 11, text: 'preferred 11' }, { id: 11, text: '' },
  ]);
  const count = out.length;
  for (const id of [11, 12, 10]) send({ id1: id, id2: id });
  assert.equal(out.length, count);
  send({ input1: '' }); assert.deepEqual(out.at(-1), { id: 10, text: 'new backup 10' });
});

test('latest text before first ID waits per branch, including empty; completed text is never reassigned', () => {
  const { send, out } = fixture();
  send({ input1: 'superseded', input2: 'backup' }); send({ input1: '' });
  assert.deepEqual(out, []);
  send({ id2: 11 }); send({ id1: 10 });
  assert.deepEqual(out, [{ id: 11, text: 'backup' }, { id: 10, text: '' }]);
  send({ id1: 11 }); send({ id2: 12 }); assert.equal(out.length, 2);
  send({ input1: '' }); assert.deepEqual(out.at(-1), { id: 11, text: 'backup' });
});

test('whole grouped deliveries apply before selection, in any property order and once per key', () => {
  const { node, context, send, out } = fixture();
  const grouped = { ...context, groupInputs: ['id1', 'input1', 'id2', 'input2'] };
  node.receiveInputs({ input2: 'backup', input1: 'preferred', id2: 10, id1: 10 }, grouped);
  node.receiveInputs({ input1: '', id1: 10, input2: 'new backup', id2: 10 }, grouped);
  assert.deepEqual(out, [{ id: 10, text: 'preferred' }, { id: 10, text: 'new backup' }]);
  node.receiveInputs({ id1: 10, input1: 'ten', id2: 11, input2: 'eleven' }, grouped);
  assert.deepEqual(out.slice(-2), [{ id: 10, text: 'ten' }, { id: 11, text: 'eleven' }]);
  // Missing text is not an empty text event; an ID-only group stays silent.
  node.receiveInputs({ id1: 12, id2: 12 }, grouped); assert.equal(out.length, 4);
  // A missing grouped key must not assign unidentified text to an old key.
  node.receiveInputs({ input1: 'waiting' }, grouped); assert.equal(out.length, 4);
  send({ id1: 13 }); assert.deepEqual(out.at(-1), { id: 13, text: 'waiting' });
});

test('finite numeric keys and atomic validation preserve existing state on invalid delivery', () => {
  const { send, out, node, context } = fixture();
  for (const id of [-2.5, 1e30, 0, -0]) send({ id2: id, input2: `${id}` });
  assert.equal(node.branches[1].values.size, 3);
  for (const id of [NaN, Infinity, -Infinity, '1', null, undefined]) {
    for (const port of ['id1', 'id2']) assert.throws(() => send({ input1: 'bad', [port]: id }), /finite number/);
  }
  assert.throws(() => send({ id1: 9, input2: null }), /TEXT/);
  assert.throws(() => node.receive('other', '', context), /Unknown/);
  assert.equal(out.length, 4);
  send({ id1: -0, input1: '' }); assert.deepEqual(out.at(-1), { id: 0, text: '0' });
  assert.equal(node.branches[0].values.size, 1, 'invalid text was never buffered');
});

for (const close of ['stop', 'cancel', 'dispose', 'abort']) test(`${close} rejects late updates and fresh Start clears all session state`, () => {
  const f = fixture();
  f.send({ id2: 10, input2: 'old backup' }); f.send({ input1: 'old pending' });
  if (close === 'abort') f.controller.abort(); else f.node[close]();
  f.send({ id1: 10, input1: 'late' }); assert.equal(f.out.length, 1);
  const fresh = fixture(f.node);
  f.send({ id1: 10, input1: 'old context' }); assert.equal(fresh.out.length, 0);
  fresh.send({ id1: 10 }); assert.equal(fresh.out.length, 0);
  fresh.send({ input1: '' }); assert.deepEqual(fresh.out, [{ id: 10, text: '' }]);
});

for (const reverse of [false, true]) test(`Pipeline preserves atomic selection, fan-out and Stop (${reverse})`, async () => {
  let source; const grouped = [], plain = [];
  const connections = [edge('source', 'key', 'select', 'id1'), edge('source', 'preferred', 'select', 'input1'),
    edge('source', 'key', 'select', 'id2'), edge('source', 'backup', 'select', 'input2'),
    edge('select', 'text', 'grouped', 'text'), edge('select', 'id', 'grouped', 'id'), edge('select', 'text', 'plain', 'text')];
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { key: NUMBER, preferred: TEXT, backup: TEXT }, start(c) { source = c; } },
    select: new KeyedTextCoalesceNode(),
    grouped: { inputs: { id: NUMBER, text: TEXT }, receiveInputs(v) { grouped.push(v); assert.ok(Object.isFrozen(v)); } },
    plain: { inputs: { text: TEXT }, receive(_, v) { plain.push(v); } },
  }, connections: reverse ? connections.reverse() : connections });
  await pipeline.start();
  source.emitOutputs({ backup: 'backup', preferred: 'preferred', key: 10 });
  source.emitOutputs({ preferred: '', backup: 'latest', key: 10 });
  source.emit('key', 11); source.emit('backup', 'eleven');
  await pipeline.stop();
  assert.deepEqual(grouped, [{ id: 10, text: 'preferred' }, { id: 10, text: 'latest' }, { id: 11, text: 'eleven' }]);
  assert.deepEqual(plain, grouped.map(v => v.text)); assert.deepEqual(pipeline.errors, []);
  source.emitOutputs({ key: 12, preferred: 'late' }); await tick(); assert.equal(grouped.length, 3);
  await pipeline.dispose();
});

test('Pipeline Cancel discards queued unidentified text and rejects late source emissions', async () => {
  let source;
  const canceled = [];
  const cancelPipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(c) { source = c; } }, select: new KeyedTextCoalesceNode(),
    sink: { inputs: { text: TEXT }, receive(_, v) { canceled.push(v); } },
  }, connections: [edge('source', 'text', 'select', 'input1'), edge('select', 'text', 'sink', 'text')] });
  await cancelPipeline.start(); source.emit('text', 'queued'); await cancelPipeline.cancel();
  source.emit('text', 'late'); await tick(); assert.deepEqual(canceled, []);
});

test('independent Number and TEXT producers keep different active keys through delayed and reversed updates', async () => {
  const out = []; let preferred, backup;
  const pipeline = new Pipeline({ nodes: {
    key1: new NumberNode({ value: 10 }), key2: new NumberNode({ value: 11 }),
    preferred: { outputs: { arbitraryText: TEXT }, start(c) { preferred = c; } },
    backup: { outputs: { otherText: TEXT }, start(c) { backup = c; } },
    select: new KeyedTextCoalesceNode(),
    sink: { inputs: { id: NUMBER, text: TEXT }, receiveInputs(v) { out.push(v); } },
  }, connections: [edge('key1', 'value', 'select', 'id1'), edge('key2', 'value', 'select', 'id2'),
    edge('preferred', 'arbitraryText', 'select', 'input1'), edge('backup', 'otherText', 'select', 'input2'),
    edge('select', 'id', 'sink', 'id'), edge('select', 'text', 'sink', 'text')] });
  await pipeline.start();
  backup.emit('otherText', 'backup 11'); preferred.emit('arbitraryText', 'preferred 10');
  await tick();
  pipeline.entries.get('key2').context.emit('value', 10);
  backup.emit('otherText', 'backup 10'); preferred.emit('arbitraryText', '');
  await tick();
  pipeline.entries.get('key1').context.emit('value', 11);
  preferred.emit('arbitraryText', 'preferred 11'); backup.emit('otherText', 'latest backup 10');
  await pipeline.stop();
  assert.deepEqual(out, [{ id: 11, text: 'backup 11' }, { id: 10, text: 'preferred 10' },
    { id: 10, text: 'preferred 10' }, { id: 10, text: 'backup 10' },
    { id: 11, text: 'preferred 11' }, { id: 10, text: 'latest backup 10' }]);
  assert.deepEqual(pipeline.errors, []); await pipeline.dispose();
});

function savedGraph() {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Number', 'key'), graphNode('Text', 'preferred'), graphNode('Text', 'backup'),
    graphNode('KeyedTextCoalesce', 'select'), graphNode('PairedTextToDOM', 'pair'), graphNode('TextToDOM', 'plain'),
    graphNode('LiveTextDisplay', 'paired-display'), graphNode('LiveTextDisplay', 'plain-display')], edges: [
    edge('key', 'value', 'select', 'id1'), edge('preferred', 'value', 'select', 'input1'),
    edge('key', 'value', 'select', 'id2'), edge('backup', 'value', 'select', 'input2'),
    edge('select', 'id', 'pair', 'id'), edge('select', 'text', 'pair', 'input1'),
    edge('select', 'text', 'plain', 'text'), edge('pair', 'dom', 'paired-display', 'dom'), edge('plain', 'dom', 'plain-display', 'dom'),
  ] };
  graph.nodes[0].settings.value = -2.5; graph.nodes[1].settings.value = ''; graph.nodes[2].settings.value = 'backup';
  return graph;
}

test('real editor connects independent Number/TEXT, saves/reloads and builds executable fan-out', async () => {
  const graph = savedGraph(), routes = graph.edges.splice(0, 4);
  const editor = Object.assign(Object.create(GraphEditor.prototype), { draft: graph, draw() {}, canvas: { querySelector() {} } });
  for (const route of routes.reverse()) {
    const [id, port] = route.from, type = graph.nodes.find(n => n.id === id).type;
    editor.selected = { id, port, contract: NODE_TYPES[type].outputs[port] };
    editor.connect(...route.to, NODE_TYPES.KeyedTextCoalesce.inputs[route.to[1]]);
  }
  assert.deepEqual(validateGraph(graph), []); assert.deepEqual(graphWarnings(graph), []);
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  saveGraph(storage, graph); const loaded = readGraph(storage);
  assert.deepEqual(loaded, graph); assert.deepEqual(executableGraph(loaded), graph);
  const out = [], built = buildGraph(loaded, { onDisplay: (id, dom) => out.push([id, domText(dom)]) });
  await built.pipeline.start(); await built.pipeline.stop();
  assert.ok(built.pipeline.entries.get('select').node instanceof KeyedTextCoalesceNode);
  assert.deepEqual(built.pipeline.errors, []);
  assert.equal(out.filter(([id]) => id === 'plain-display').at(-1)[1], 'backup');
  assert.equal(out.filter(([id]) => id === 'paired-display').at(-1)[1], 'backup\n');
  await built.pipeline.dispose();
});

test('incomplete drafts stay saveable; either complete branch can execute independently', () => {
  const graph = savedGraph();
  graph.edges = graph.edges.filter(route => route.to[0] !== 'select' || route.to[1] === 'id1');
  assert.deepEqual(validateGraph(graph), []);
  assert.match(graphWarnings(graph).join(), /select needs an ID\/TEXT pair/);
  assert.ok(!executableGraph(graph).nodes.some(n => n.id === 'select'));
  graph.edges.push(edge('preferred', 'value', 'select', 'input1'));
  assert.ok(executableGraph(graph).nodes.some(n => n.id === 'select'));
  graph.edges = graph.edges.filter(route => route.to[0] !== 'select');
  graph.edges.push(edge('key', 'value', 'select', 'id2'), edge('backup', 'value', 'select', 'input2'));
  assert.ok(executableGraph(graph).nodes.some(n => n.id === 'select'));
});
