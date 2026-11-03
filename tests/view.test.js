import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { document } from './fixtures/dom.js';
import { snapshotView } from '../web/view.js';
import { ViewBuilderNode } from '../web/view-builder-node.js';
import { DisplayNode } from '../web/display-node.js';
import { Pipeline } from '../web/pipeline.js';
import { NumberNode } from '../web/number-node.js';
import { NUMBER, TEXT, VIEW, DOM } from '../web/port-contracts.js';
import { NODE_TYPES, nodeDefinition, assertGraph, GRAPH_VERSION, graphNode, edge, validateGraph, graphWarnings, executableGraph } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { viewGraph } from './fixtures/view-graph.js';

function fixture(connectedInputs = ['id', 'input1', 'input2'], node = new ViewBuilderNode()) {
  const out = [], controller = new AbortController();
  const context = { signal: controller.signal, connectedInputs, emit: (port, value) => { assert.equal(port, 'view'); out.push(value); } };
  node.start(context);
  return { node, out, context, controller, send: values => node.receiveInputs(values, context) };
}
const rows = (...values) => ({ rows: values });
const row = (id, ...cells) => ({ id, cells });

test('VIEW is small data, cloneable/JSON-safe, owned and deeply immutable; IDs are optional and numeric', () => {
  const input = rows({ cells: ['', '<script>\n& 日本語'] }, row(-2.5, 'left', 'right'), row(1e30, ''));
  const view = snapshotView(input);
  assert.deepEqual(view, input);
  assert.deepEqual(structuredClone(view), input); assert.deepEqual(JSON.parse(JSON.stringify(view)), input);
  input.rows[0].cells[0] = 'changed'; input.rows.push({ cells: ['extra'] });
  assert.equal(view.rows.length, 3); assert.equal(view.rows[0].cells[0], '');
  for (const item of [view, view.rows, ...view.rows, ...view.rows.map(row => row.cells)]) assert.ok(Object.isFrozen(item));
  for (const invalid of [null, '', document.createElement('div'), { rows: [], render() {} }, { rows: [], style: {} },
    { rows: new Map() }, { rows: Array(1) }, { rows: new (class extends Array { map() { throw Error('Callback must not run'); } })() },
    rows({ cells: [] }), rows({ cells: ['ok', null] }),
    rows({ cells: [document.createElement('div')] }), rows({ cells: ['ok'], html: '' }), rows({ cells: ['ok'], id: '1' }),
    rows(row(NaN, '')), rows(row(Infinity, '')), rows(row(0, ''), row(-0, '')),
    { get rows() { throw Error('Accessor must not run'); } }, Object.defineProperty({}, 'rows', { value: [] })]) assert.throws(() => snapshotView(invalid), TypeError);
  assert.deepEqual(snapshotView(rows()), rows());
});

test('legacy builder is portable, reviewed sink has only VIEW input, ordinary registration/packaging and no Settings', () => {
  const builder = new ViewBuilderNode(), display = new DisplayNode(undefined, { legacyView: true });
  assert.deepEqual(builder.inputs, { id: NUMBER, input1: TEXT, input2: TEXT });
  assert.deepEqual(builder.outputs, { view: VIEW }); assert.deepEqual(display.inputs, { view: VIEW }); assert.deepEqual(display.outputs, {});
  for (const [type, node] of [['ViewBuilder', builder], ['Display', display]]) {
    assert.deepEqual((type === 'Display' ? nodeDefinition({ type, legacyView: true }) : NODE_TYPES[type]).inputs, node.inputs); assert.deepEqual(NODE_TYPES[type].outputs, node.outputs);
    assert.deepEqual(graphNode(type, type).settings, {});
    for (const setting of ['settings', 'numberSettings', 'textSettings']) assert.equal(NODE_TYPES[type][setting], undefined);
  }
  for (const name of ['view.js', 'view-builder-node.js']) assert.doesNotMatch(readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8'), /document\.|window\.|createElement|innerHTML/);
  const bundle = readFileSync(new URL('../scripts/build-extension.py', import.meta.url), 'utf8');
  for (const name of ['view.js', 'view-builder-node.js', 'display-node.js']) assert.ok(bundle.includes(`"${name}"`));
});

test('plain latest values invent no IDs; one or both text inputs use the same VIEW', () => {
  for (const port of ['input1', 'input2']) {
    const f = fixture([port]); assert.deepEqual(f.out, [rows()]);
    for (const text of ['<script>\n&', '', 'same', 'same']) {
      f.send({ [port]: text }); assert.deepEqual(f.out.at(-1), rows({ cells: [text] }));
    }
    assert.equal(f.node.rows.size, 0); assert.equal(f.out.length, 5);
  }
  const f = fixture(['input1', 'input2']); f.send({ input1: 'left', input2: 'right' }); f.send({ input1: '' });
  assert.deepEqual(f.out.at(-1), rows({ cells: ['', 'right'] }));
  f.node.receiveInputs({ input1: 'new' }, { ...f.context, groupInputs: ['input1', 'input2'] });
  assert.deepEqual(f.out.at(-1), rows({ cells: ['new', ''] }));
});

test('first-seen numeric keys, text-first, ID-first, independent same-key patches and grouped omissions', () => {
  const f = fixture();
  f.send({ input1: 'superseded' }); f.send({ input1: '', input2: 'waiting' }); assert.equal(f.out.length, 1);
  f.send({ id: -2.5 }); assert.deepEqual(f.out.at(-1), rows(row(-2.5, '', 'waiting')));
  f.send({ id: 1e30 }); f.send({ id: 0 }); assert.equal(f.out.length, 2, 'ID-only events do not replay');
  f.send({ input1: 'B' }); f.send({ id: -2.5, input1: 'A' });
  assert.deepEqual(f.out.at(-1), rows(row(-2.5, 'A', 'waiting'), row(0, 'B', '')));
  f.send({ input2: '' }); f.send({ input2: '' });
  assert.deepEqual(f.out.at(-1), rows(row(-2.5, 'A', ''), row(0, 'B', '')));
  const before = f.out.length, grouped = { ...f.context, groupInputs: ['id', 'input1', 'input2'] };
  f.node.receiveInputs({ input1: 'unidentified' }, grouped); assert.equal(f.out.length, before);
  f.send({ id: 1e30 });
  assert.deepEqual(f.out.at(-1), rows(row(-2.5, 'A', ''), row(0, 'B', ''), row(1e30, 'unidentified', '')));
  f.node.receiveInputs({ input2: 'right', id: -2.5 }, grouped);
  assert.deepEqual(f.out.at(-1), rows(row(-2.5, '', 'right'), row(0, 'B', ''), row(1e30, 'unidentified', '')));
  f.send({ id: -0, input1: 'zero' }); assert.equal(f.out.at(-1).rows.length, 3);
  assert.deepEqual(f.out[1], rows(row(-2.5, '', 'waiting')), 'earlier snapshot remains independent');
});

test('whole input validation precedes mutations and rejects invalid finite numeric IDs', () => {
  const f = fixture(); f.send({ id: 1, input1: 'valid' }); const count = f.out.length;
  for (const id of [NaN, Infinity, -Infinity, '1', null, undefined]) assert.throws(() => f.send({ input2: 'bad', id }), /finite number/);
  assert.throws(() => f.send({ id: 2, input1: null }), /TEXT/); assert.throws(() => f.send({ other: '' }), /Unknown/);
  f.send({ input2: 'still one' }); assert.equal(f.out.length, count + 1);
  assert.deepEqual(f.out.at(-1), rows(row(1, 'valid', 'still one')));
});

for (const close of ['stop', 'cancel', 'dispose', 'abort']) test(`builder ${close} rejects late work, Start resets history and pending data`, () => {
  const f = fixture(); f.send({ id: 1, input1: 'old' });
  f.node.receiveInputs({ input1: 'waiting' }, { ...f.context, groupInputs: ['id', 'input1'] });
  if (close === 'abort') f.controller.abort(); else f.node[close]();
  f.send({ id: 1, input1: 'late' }); assert.equal(f.out.length, 2);
  const next = fixture(['id', 'input1', 'input2'], f.node); f.send({ id: 1, input1: 'old context' });
  next.send({ id: 1 }); assert.deepEqual(next.out, [rows()]);
  next.send({ input1: '' }); assert.deepEqual(next.out.at(-1), rows(row(1, '', '')));
});

test('same Display renders one-cell and multi-cell snapshots literally, independently and with no keyed state', () => {
  const out = [], node = new DisplayNode(dom => out.push(dom), { legacyView: true }), context = { signal: new AbortController().signal };
  node.start(context);
  node.receive('view', rows({ cells: ['<img src=x onerror=alert(1)>\n&'] }), context);
  assert.equal(out.at(-1).firstChild.textContent, '<img src=x onerror=alert(1)>\n&');
  assert.equal(out.at(-1).querySelector('img'), null); assert.equal(out.at(-1).firstChild.style.whiteSpace, 'pre-wrap');
  node.receiveInputs({ view: rows(row(10, 'L\n2', ''), row(11, 'B', '<script>')) }, context);
  assert.deepEqual([...out.at(-1).querySelectorAll('td')].map(cell => cell.textContent), ['L\n2', '', 'B', '<script>']);
  assert.equal(out.at(-1).querySelector('table').getAttribute('aria-label'), 'Text rows');
  assert.equal(out.at(-1).querySelector('td').getAttribute('aria-label'), 'Text 1: L\n2');
  out.at(-1).querySelector('td').textContent = 'mutated DOM';
  node.receive('view', rows(row(11, 'only B', 'new')), context);
  assert.equal(out.at(-1).querySelectorAll('tr').length, 1, 'snapshot removes absent rows without hidden history');
  assert.equal(Object.hasOwn(node, 'rows'), false); assert.equal(Object.hasOwn(node, 'id'), false);
  node.receive('view', rows({ cells: ['plain row'] }, { cells: ['one', 'two', 'three'] }), context);
  assert.equal(out.at(-1).querySelectorAll('tr').length, 2);
  assert.equal(out.at(-1).querySelectorAll('td').length, 4);
  assert.equal(out.at(-1).querySelector('td').colSpan, 3);
  for (const value of ['<b>not a VIEW</b>', rows({ cells: [] })]) assert.throws(() => node.receive('view', value, context), TypeError);
  assert.throws(() => node.receiveInputs({ view: rows(), id: 2 }, context), /only view/);
  node.receive('view', rows(), context); assert.equal(out.at(-1).childNodes.length, 0);
});

for (const close of ['stop', 'cancel', 'dispose', 'abort']) test(`Display ${close} retains last rendering; Start clears and rejects old contexts`, () => {
  const out = [], node = new DisplayNode(dom => out.push(dom), { legacyView: true }), controller = new AbortController();
  const c = { signal: controller.signal }; node.start(c); node.receive('view', rows({ cells: ['kept'] }), c);
  if (close === 'abort') controller.abort(); else node[close]();
  node.receive('view', rows(), c); assert.equal(out.length, 2); assert.equal(out.at(-1).firstChild.textContent, 'kept');
  const fresh = { signal: new AbortController().signal }; node.start(fresh); node.receive('view', rows({ cells: ['stale'] }), c);
  assert.equal(out.length, 3); assert.equal(out.at(-1).childNodes.length, 0);
});

for (const reverse of [false, true]) test(`independent NUMBER/TEXT producers, atomic delivery and immutable VIEW fan-out (${reverse})`, async () => {
  let text; const snapshots = [], rendered = [], second = [];
  const connections = [edge('key', 'value', 'builder', 'id'), edge('text', 'arbitrary', 'builder', 'input1'),
    edge('builder', 'view', 'observer', 'any'), edge('builder', 'view', 'host', 'view'), edge('builder', 'view', 'other', 'view')];
  const pipeline = new Pipeline({ nodes: {
    key: new NumberNode({ value: 1 }), text: { outputs: { arbitrary: TEXT }, start(c) { text = c; } }, builder: new ViewBuilderNode(),
    observer: { inputs: { any: VIEW }, receive(_, view) { assert.throws(() => { view.rows.push({ cells: ['mutation'] }); }, TypeError); snapshots.push(view); } },
    host: new DisplayNode(dom => rendered.push(dom), { legacyView: true }), other: new DisplayNode(dom => second.push(dom), { legacyView: true }),
  }, connections: reverse ? connections.reverse() : connections });
  await pipeline.start(); text.emit('arbitrary', 'same'); text.emit('arbitrary', 'same'); text.emit('arbitrary', ''); await pipeline.stop();
  assert.deepEqual(snapshots, [rows(), rows(row(1, 'same')), rows(row(1, 'same')), rows(row(1, ''))]);
  assert.deepEqual(pipeline.errors, []); assert.equal(rendered.at(-1).firstChild.textContent, '');
  assert.notEqual(rendered.at(-1), second.at(-1)); await pipeline.dispose();
});

test('any VIEW producer/name can render; mismatched TEXT/NUMBER/DOM contracts cannot connect', async () => {
  const out = []; let emitter;
  const pipeline = new Pipeline({ nodes: { arbitrary: { outputs: { other: VIEW }, start(c) { emitter = c; } }, sink: new DisplayNode(dom => out.push(dom), { legacyView: true }) }, connections: [edge('arbitrary', 'other', 'sink', 'view')] });
  await pipeline.start(); emitter.emit('other', rows({ cells: ['arbitrary'] })); await pipeline.stop();
  assert.equal(out.at(-1).firstChild.textContent, 'arbitrary'); assert.deepEqual(pipeline.errors, []); await pipeline.dispose();
  for (const contract of [TEXT, NUMBER, DOM]) assert.throws(() => new Pipeline({ nodes: { arbitrary: { outputs: { other: contract } }, sink: new DisplayNode(undefined, { legacyView: true }) }, connections: [edge('arbitrary', 'other', 'sink', 'view')] }), /Incompatible/);
});

test('unfinished builders remain saveable, require text for execution and use the production plain path', async () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('ViewBuilder', 'builder'), { ...graphNode('Display', 'display'), legacyView: true }], edges: [edge('builder', 'view', 'display', 'view')] };
  assert.deepEqual(validateGraph(graph), []); assert.match(graphWarnings(graph).join(), /builder needs at least one TEXT/);
  assert.equal(executableGraph(graph).nodes.length, 0);
  graph.nodes[0].settings.value = 'plain'; graph.edges.push(edge('text', 'value', 'builder', 'input2'));
  assert.deepEqual(graphWarnings(graph), []); assert.equal(executableGraph(graph).nodes.length, 3);
  const out = [], { pipeline } = buildGraph(graph, { onDisplay: (_, dom) => out.push(dom) });
  await pipeline.start(); await pipeline.stop(); assert.equal(out.at(-1).firstChild.textContent, 'plain'); await pipeline.dispose();
});

test('historical VIEW graph has a reviewed compatible executable fixture and contains no processing DOM edges', () => {
  const graph = JSON.parse(readFileSync(new URL('../docs/evidence/view-196.json', import.meta.url), 'utf8'));
  let draft; assert.throws(() => assertGraph(graph), error => { draft = error.recoveryGraph; return /requires review/.test(error.message); });
  assert.deepEqual(draft, viewGraph()); assert.deepEqual(graphWarnings(draft), []);
  assert.deepEqual(executableGraph(draft), draft);
  assert.equal(graph.nodes.find(node => node.id === 'display').legacyView, undefined);
  for (const route of graph.edges) {
    const source = graph.nodes.find(node => node.id === route.from[0]);
    assert.notEqual(NODE_TYPES[source.type].outputs[route.from[1]], DOM);
  }
});
