import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph, GRAPH_KEY, GRAPH_VERSION, NODE_TYPES, nodeDefinition } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { DisplayNode } from '../web/display-node.js';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, NUMBER, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST, ITEM } from '../web/port-contracts.js';
import { domText } from './fixtures/dom.js';

const storage = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) }; };
const removed = ['ViewBuilder', 'TextDisplay', 'LiveTextDisplay', 'TextToDOM', 'PairedTextToDOM', 'KeyedDOMAccumulator', 'DOMAccumulator', 'DOMCombiner', 'TranscriptView', 'TranslationView'];

test('default/reset and explicit translated history graphs use only current contracts and exact runtime ports', async () => {
  for (const enabled of [false, true]) for (const direction of ['ja-en', 'en-ja']) {
    const graph = defaultGraph({ enabled, direction });
    assert.deepEqual(validateGraph(graph), []);
    assert.deepEqual(NODE_TYPES.KeyedTextPair.outputs, { pair: KEYED_PAIRED_TEXT });
    assert.deepEqual(NODE_TYPES.Display.inputs, { input: ITEM });
    const store = storage(); saveGraph(store, graph); const raw = store.getItem(GRAPH_KEY);
    assert.deepEqual(readGraph(store), graph); assert.equal(store.getItem(GRAPH_KEY), raw);
    const built = buildGraph(graph, {}); assert.ok(built.pipeline instanceof Pipeline);
    assert.ok(built.pipeline.entries.get('transcript').node instanceof DisplayNode);
    assert.deepEqual(built.description, graph);
    for (const node of graph.nodes) {
      assert.deepEqual(built.pipeline.entries.get(node.id).inputs, nodeDefinition(node).inputs);
      assert.deepEqual(built.pipeline.entries.get(node.id).outputs, NODE_TYPES[node.type].outputs);
    }
    assert.equal(graph.nodes.some(node => node.id === 'translation'), enabled);
    await built.pipeline.dispose();
  }
});

test('new storage uses current transcription default without importing legacy preferences', () => {
  const store = storage(); store.setItem('opus-mt-translation-preferences', '{"enabled":true}');
  assert.deepEqual(readGraph(store), defaultGraph());
});

for (const type of removed) test(`removed ${type} is unsupported in validation, editor metadata and runtime; Reset is explicit`, () => {
  assert.equal(Object.hasOwn(NODE_TYPES, type), false);
  assert.throws(() => graphNode(type, 'old'), /Unknown Node type/);
  const graph = defaultGraph(); graph.nodes.push({ id: 'old', type, settings: {}, position: { x: 1, y: 1 } });
  const raw = JSON.stringify(graph, null, 2), store = storage(); store.setItem(GRAPH_KEY, raw);
  assert.throws(() => readGraph(store), error => /Unknown Node type/.test(error.message) && /Reset draft or import/.test(error.message) && !error.recoveryGraph);
  assert.equal(store.getItem(GRAPH_KEY), raw);
  assert.throws(() => buildGraph(graph), /Unknown Node type/);
  saveGraph(store, defaultGraph()); assert.deepEqual(readGraph(store), defaultGraph());
});

for (const output of ['id', 'input1', 'input2']) test(`removed KeyedTextPair.${output} fails visibly without rewiring or modifying storage`, () => {
  const graph = defaultGraph(); graph.edges.push(edge('pair', output, 'transcript', 'input'));
  const store = storage(), raw = JSON.stringify(graph); store.setItem(GRAPH_KEY, raw);
  assert.throws(() => readGraph(store), /Unknown port: pair/); assert.equal(store.getItem(GRAPH_KEY), raw);
  assert.throws(() => saveGraph(store, graph), /Unknown port: pair/);
  assert.equal(store.getItem(GRAPH_KEY), raw);
});

test('Display.view and legacy mode, obsolete graph versions and malformed storage require explicit recovery', () => {
  for (const edit of [g => g.edges.at(-1).to[1] = 'view', g => g.nodes.at(-1).legacyView = true, g => g.version = 14]) {
    const graph = defaultGraph(); edit(graph); const store = storage(), raw = JSON.stringify(graph); store.setItem(GRAPH_KEY, raw);
    assert.throws(() => readGraph(store), /Invalid saved graph/); assert.equal(store.getItem(GRAPH_KEY), raw);
    assert.throws(() => buildGraph(graph));
  }
  const store = storage(); store.setItem(GRAPH_KEY, '{broken'); assert.throws(() => readGraph(store), /saved graph has been kept/);
  saveGraph(store, defaultGraph()); assert.deepEqual(readGraph(store), defaultGraph());
});

for (const [name, edit, pattern] of [
  ['unknown type', g => g.nodes[0].type = 'toString', /Unknown Node/],
  ['duplicate ID', g => g.nodes[1].id = 'audio', /Duplicate Node/],
  ['bad port', g => g.edges[0].from[1] = 'toString', /Unknown port/],
  ['incompatible type', g => g.edges[0].from = ['speech', 'final'], /Incompatible/],
  ['cycle', g => g.edges.push(edge('speech', 'final', 'speech', 'audio')), /acyclic/],
  ['duplicate edge', g => g.edges.push(g.edges[0]), /Duplicate edge/],
  ['multiple incoming edges', g => g.edges.push(edge('speech', 'provisional', 'translation', 'text')), /Only one connection/],
  ['missing source', g => g.nodes.shift(), /Unknown edge Node/],
  ['position', g => g.nodes[0].position.x = Infinity, /Invalid position/],
  ['settings', g => g.nodes[2].settings.model = 'remote', /Unknown setting/],
  ['malformed edge', g => g.edges.push({ from: null }), /Malformed/],
]) test(`schema rejects ${name} before persistence or constructing Workers`, () => {
  const graph = defaultGraph({ enabled: true }); edit(graph);
  assert.match(validateGraph(graph).join('\n'), pattern);
  assert.throws(() => assertGraph(graph), pattern); assert.throws(() => buildGraph(graph), pattern);
});

test('every supported concrete TEXT/pair/list producer can reach Display by type, with no source restrictions', () => {
  for (const [type, definition] of Object.entries(NODE_TYPES)) for (const [port, contract] of Object.entries(definition.outputs)) {
    const graph = { version: GRAPH_VERSION, nodes: [graphNode(type, 'source'), graphNode('Display', 'sink')], edges: [edge('source', port, 'sink', 'input')] };
    if ([TEXT, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST].includes(contract)) assert.deepEqual(validateGraph(graph), []);
    else assert.match(validateGraph(graph).join(), /Incompatible/);
  }
  assert.equal(NODE_TYPES.Number.outputs.value, NUMBER);
});

test('TEXT processors retain literal rendering and fan-out without audio or ASR', async () => {
  const source = graphNode('Text', 'literal'); source.settings.value = '<script>\n日本語';
  const graph = { version: GRAPH_VERSION, nodes: [source, graphNode('TextFormatter', 'format'), graphNode('TextAccumulator', 'acc'), graphNode('Display', 'direct'), graphNode('Display', 'processed')],
    edges: [edge('literal', 'value', 'direct', 'input'), edge('literal', 'value', 'format', 'input1'), edge('format', 'text', 'acc', 'append'), edge('acc', 'text', 'processed', 'input')] };
  const seen = {}, built = buildGraph(graph, { onDisplay(id, dom) { seen[id] = domText(dom); assert.equal(dom.querySelector('script'), null); } });
  await built.pipeline.start(); await built.pipeline.stop(); assert.equal(seen.direct, source.settings.value); assert.equal(seen.processed, source.settings.value);
  assert.deepEqual(built.pipeline.errors, []); await built.pipeline.dispose();
});

test('obsolete implementations are absent from packaging and disk', () => {
  const bundle = readFileSync('scripts/build-extension.py', 'utf8');
  for (const file of ['dom-nodes.js', 'view.js', 'view-builder-node.js', 'text-display-node.js']) {
    assert.equal(existsSync(`web/${file}`), false); assert.ok(!bundle.includes(`"${file}"`));
  }
});
