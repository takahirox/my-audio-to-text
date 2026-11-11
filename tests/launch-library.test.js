import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLibrary, openLibrary, readLibrary, LIBRARY_KEY, readSelectedGraph, saveLiveGraphData } from '../extension/graph-library.js';
import { launchLibrary } from '../extension/launch-library.js';
import { graphNode, edge, GRAPH_KEY } from '../extension/graph.js';
import { extractSubgraph } from '../extension/subgraphs.js';

async function fixture() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let pending = Promise.resolve();
  const locks = { request(name, work) { const next = pending.then(work); pending = next.catch(() => {}); return next; } };
  const store = new GraphLibrary(storage, locks); await openLibrary(storage, locks);
  return { storage, store, locks, launch: (op, id) => launchLibrary(storage, op, id, locks) };
}
const simple = () => ({ version: 15, nodes: [graphNode('Text', 'source'), graphNode('Display', 'display')], edges: [edge('source', 'value', 'display', 'input1')] });
const voice = () => ({ version: 15, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')], edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] });

test('existing live assignment is the stable default; running selections never change it', async () => {
  const f = await fixture();
  const next = await f.store.create({ name: 'Second', graph: simple() }), id = next.graphs.at(-1).id;
  const original = await f.launch('live-list'); assert.equal(original.defaultId, 'default-live');
  await f.launch('live-check', id); assert.equal(readLibrary(f.storage).assignments.live, 'default-live');
  await f.launch('live-default', id); assert.equal((await f.launch('live-list')).defaultId, id);
  const snapshot = readSelectedGraph(f.storage, id);
  await f.store.rename(id, 'New name', '', snapshot.revision);
  assert.equal(snapshot.name, 'Second'); assert.equal(readSelectedGraph(f.storage, id).name, 'New name');
  assert.equal((await f.launch('live-list')).defaultId, id);
});

test('dangling, deleted and invalid defaults never silently choose among multiple runnable graphs', async () => {
  const f = await fixture();
  const next = await f.store.create({ graph: simple() }), id = next.graphs.at(-1).id;
  await f.store.change(library => { library.assignments.live = 'missing'; });
  assert.equal((await f.launch('live-list')).defaultId, null);
  await assert.rejects(f.launch('live-check', 'missing'), /no longer exists/);
  await assert.rejects(f.launch('live-default', 'missing'), /missing/);
  await f.store.assign('live', id); await f.store.delete(id);
  assert.equal(readLibrary(f.storage).assignments.live, null);
  assert.equal((await f.launch('live-list')).defaultId, 'default-live', 'exactly one runnable graph may become the default');
  const broken = await f.store.create({ graph: simple() }), bad = broken.graphs.at(-1);
  await f.store.assign('live', bad.id);
  await f.store.save(bad.id, bad.revision, { version: 15, nodes: [graphNode('Text', 'parked')], edges: [] });
  assert.equal((await f.launch('live-list')).defaultId, 'default-live');
  assert.ok(!(await f.launch('live-list')).graphs.some(entry => entry.id === bad.id));
  await assert.rejects(f.launch('live-check', bad.id), /No executable path/);
});

test('Web choices retain their independent default, require compatibility, and never enable microphone consent', async () => {
  const f = await fixture();
  const next = await f.store.create({ graph: voice() }), id = next.graphs.at(-1).id;
  assert.deepEqual((await f.launch('web-list')).graphs.map(entry => entry.id), [id]);
  assert.equal((await f.launch('web-list')).defaultId, null);
  await assert.rejects(f.launch('web-default', 'default-live'), /cannot run/);
  await f.launch('web-default', id);
  assert.equal((await f.launch('web-list')).defaultId, id);
  assert.equal(readLibrary(f.storage).assignments.live, 'default-live');
  assert.equal(f.storage.getItem('web-voice-typing-v1'), null);
});

test('corrupt sources and missing subgraph definitions are excluded; legacy conflicts block launches without overwriting data', async () => {
  const f = await fixture();
  await f.store.create({ graph: simple() });
  const saved = readLibrary(f.storage), bad = saved.graphs.at(-1);
  bad.graph.nodes[0].type = 'Subgraph';
  f.storage.setItem(LIBRARY_KEY, JSON.stringify(saved));
  assert.ok(!(await f.launch('live-list')).graphs.some(entry => entry.id === bad.id));
  await assert.rejects(f.launch('live-check', bad.id), /Missing or invalid subgraph/);
  const before = f.storage.getItem(LIBRARY_KEY);
  f.storage.setItem(GRAPH_KEY, '{changed legacy');
  await assert.rejects(f.launch('live-list'), /Recover/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
});


test('default compatibility saves can repair an incomplete graph while launch validation stays strict', async () => {
  const f = await fixture();
  await saveLiveGraphData(f.storage, { version: 15, nodes: [graphNode('Text', 'draft')], edges: [] }, f.locks);
  await assert.rejects(f.launch('live-check', 'default-live'), /No executable path/);
  await saveLiveGraphData(f.storage, simple(), f.locks);
  assert.equal(await f.launch('live-check', 'default-live'), 'default-live');
});


test('launch choices resolve shared definitions, exclude definitions, and retain detached selected-parent snapshots', async () => {
  const f = await fixture(), graph = simple();
  const formatter = graphNode('TextFormatter', 'format'); formatter.settings.template = 'Before: {1}';
  graph.nodes.push(formatter);
  graph.edges = [edge('source', 'value', 'format', 'input1'), edge('format', 'text', 'display', 'input1')];
  const extracted = extractSubgraph(graph, ['format'], 'shared');
  await f.store.create({ id: 'shared', name: 'Shared', kind: 'subgraph', graph: extracted.shared });
  const saved = await f.store.create({ name: 'Parent', graph: extracted.parent }), parent = saved.graphs.at(-1);
  assert.deepEqual((await f.launch('live-list')).graphs.map(entry => entry.id), ['default-live', parent.id]);
  assert.equal(await f.launch('live-check', parent.id), parent.id);
  await f.launch('live-default', parent.id);
  await assert.rejects(f.launch('live-check', 'shared'), /Choose a parent graph/);
  await assert.rejects(f.launch('live-default', 'shared'), /cannot run/);
  const snapshot = readSelectedGraph(f.storage, parent.id);
  assert.ok(snapshot.graph.nodes.every(node => node.type !== 'Subgraph'));
  const definition = readLibrary(f.storage).graphs.find(entry => entry.id === 'shared');
  definition.graph.nodes[0].settings.template = 'After: {1}';
  await f.store.save(definition.id, definition.revision, definition.graph);
  assert.equal(snapshot.graph.nodes.find(node => node.type === 'TextFormatter').settings.template, 'Before: {1}');
  assert.equal(readSelectedGraph(f.storage, parent.id).graph.nodes.find(node => node.type === 'TextFormatter').settings.template, 'After: {1}');
  assert.equal((await f.launch('live-list')).defaultId, parent.id);
  assert.deepEqual(readLibrary(f.storage).graphs.find(entry => entry.id === parent.id), parent);
  await f.store.change(current => { current.assignments.live = 'shared'; current.graphs = current.graphs.filter(entry => entry.id !== 'default-live'); });
  assert.equal((await f.launch('live-list')).defaultId, parent.id, 'sole viable parent replaces an invalid definition default');
});

test('Web launch choices resolve shared ASR through the same compatibility boundary as the page mic', async () => {
  const f = await fixture(), extracted = extractSubgraph(voice(), ['asr'], 'shared-asr');
  await f.store.create({ id: 'shared-asr', name: 'Shared ASR', kind: 'subgraph', graph: extracted.shared });
  const saved = await f.store.create({ name: 'Web parent', graph: extracted.parent }), id = saved.graphs.at(-1).id;
  assert.deepEqual((await f.launch('web-list')).graphs.map(entry => entry.id), [id]);
  await f.launch('web-default', id);
  assert.equal((await f.launch('web-list')).defaultId, id);
  await assert.rejects(f.launch('web-default', 'shared-asr'), /cannot run/);
  await f.store.change(current => { current.graphs = current.graphs.filter(entry => entry.id !== 'shared-asr'); });
  assert.deepEqual((await f.launch('web-list')).graphs, []);
  assert.equal((await f.launch('web-list')).defaultId, null);
  assert.ok(!(await f.launch('live-list')).graphs.some(entry => entry.id === id));
  await assert.rejects(f.launch('live-check', id), /Missing or invalid subgraph/);
});
