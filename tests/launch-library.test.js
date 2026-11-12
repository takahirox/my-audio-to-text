import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLibrary, openLibrary, readLibrary, LIBRARY_KEY, readSelectedGraph, saveLiveGraphData } from '../extension/graph-library.js';
import { launchLibrary } from '../extension/launch-library.js';
import { graphNode, edge, GRAPH_KEY } from '../extension/graph.js';
import { extractSubgraph } from '../extension/subgraphs.js';

async function fixture() {
  const values = new Map(); let writes = 0;
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { writes++; values.set(key, value); } };
  let pending = Promise.resolve();
  const locks = { request(name, work) { const next = pending.then(work); pending = next.catch(() => {}); return next; } };
  const store = new GraphLibrary(storage, locks); await openLibrary(storage, locks);
  return { storage, store, locks, get writes() { return writes; }, launch: (op, id) => launchLibrary(storage, op, id, locks) };
}
const simple = () => ({ version: 15, nodes: [graphNode('Text', 'source'), graphNode('Display', 'display')], edges: [edge('source', 'value', 'display', 'input1')] });
const voice = () => ({ version: 15, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')], edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] });

test('valid last selection survives rename and reorder; checking a window never changes it', async () => {
  const f = await fixture();
  const next = await f.store.create({ name: 'Second', graph: simple() }), id = next.graphs.at(-1).id;
  const original = await f.launch('live-list'); assert.equal(original.defaultId, 'default-live');
  await f.launch('live-check', id); assert.equal(readLibrary(f.storage).assignments.live, 'default-live');
  await f.launch('live-open', id); assert.equal((await f.launch('live-list')).defaultId, id);
  const snapshot = readSelectedGraph(f.storage, id);
  await f.store.rename(id, 'New name', '', snapshot.revision);
  assert.equal(snapshot.name, 'Second'); assert.equal(readSelectedGraph(f.storage, id).name, 'New name');
  assert.equal((await f.launch('live-list')).defaultId, id);
});

test('missing, deleted and invalid selections fall back to the first runnable name', async () => {
  const f = await fixture();
  const next = await f.store.create({ name: 'A', graph: simple() }), id = next.graphs.at(-1).id;
  await f.store.change(library => { library.assignments.live = 'missing'; });
  assert.equal((await f.launch('live-list')).defaultId, id);
  assert.equal(readLibrary(f.storage).assignments.live, id);
  await assert.rejects(f.launch('live-check', 'missing'), /no longer exists/);
  await assert.rejects(f.launch('live-open', 'missing'), /missing/);
  await f.store.assign('live', id); await f.store.delete(id);
  assert.equal(readLibrary(f.storage).assignments.live, null);
  assert.equal((await f.launch('live-list')).defaultId, 'default-live', 'the remaining runnable graph becomes the selection');
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
  await f.launch('live-open', parent.id);
  await assert.rejects(f.launch('live-check', 'shared'), /Choose a parent graph/);
  await assert.rejects(f.launch('live-open', 'shared'), /cannot run/);
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


test('first-name fallback and Open use Japanese numeric ordering with stable ID ties, independently of storage order', async () => {
  const f = await fixture();
  for (const [id, name] of [['z', 'Same'], ['b', 'い'], ['a', 'あ'], ['n10', 'Graph 10'], ['n2', 'Graph 2'], ['a-tie', 'Same']]) {
    await f.store.create({ id, name, graph: simple() });
  }
  await f.store.change(current => { current.assignments.live = null; });
  const state = await f.launch('live-list');
  assert.deepEqual(state.graphs.map(entry => entry.id), ['n2', 'n10', 'default-live', 'a-tie', 'z', 'a', 'b']);
  assert.equal(state.defaultId, 'n2');
  assert.equal(readLibrary(f.storage).assignments.live, 'n2');
  // A new host reading persisted storage retains the selection after reordering.
  await f.launch('live-open', 'b');
  const entry = readLibrary(f.storage).graphs.find(entry => entry.id === 'b');
  await f.store.rename('b', '0 now first', '', entry.revision);
  assert.equal((await launchLibrary(f.storage, 'live-list', undefined, f.locks)).defaultId, 'b');
  await f.store.delete('b');
  assert.equal((await f.launch('live-list')).defaultId, 'n2');
  await f.store.change(current => { current.graphs = current.graphs.filter(entry => ['a', 'b'].includes(entry.id)); current.assignments.live = null; });
  assert.equal((await f.launch('live-list')).defaultId, 'a');
});

test('ordinary refreshes, checks and repeated Open do not revise or notify storage; concurrent fallback writes once', async () => {
  const f = await fixture();
  await f.store.create({ id: 'a', name: 'A', graph: simple() });
  await f.store.change(current => { current.assignments.live = null; });
  const before = f.writes;
  await Promise.all(Array.from({ length: 12 }, () => f.launch('live-list')));
  assert.equal(f.writes, before + 1);
  const saved = f.storage.getItem(LIBRARY_KEY), writes = f.writes;
  await Promise.all([f.launch('live-list'), f.launch('live-open', 'a'), f.launch('live-check', 'a')]);
  assert.equal(f.writes, writes);
  assert.equal(f.storage.getItem(LIBRARY_KEY), saved);
});

test('fallback rechecks under the lock so a concurrent explicit selection or rename wins', async () => {
  for (const action of ['select', 'rename', 'delete', 'invalidate']) {
    const f = await fixture();
    await f.store.create({ id: 'a', name: 'A', graph: simple() });
    await f.store.create({ id: 'b', name: 'B', graph: simple() });
    await f.store.change(current => { current.assignments.live = null; });
    const request = f.locks.request.bind(f.locks); let calls = 0, concurrent;
    f.locks.request = (name, work) => {
      if (++calls === 2) {
        // Queue an editor/selection change after launch's initial read, before
        // its selection transaction obtains the lock.
        concurrent = f.store.change(current => {
          if (action === 'select') current.assignments.live = 'b';
          if (action === 'rename') current.graphs.find(entry => entry.id === 'b').name = '0 first';
          if (action === 'delete') current.graphs = current.graphs.filter(entry => entry.id !== 'a');
          if (action === 'invalidate') current.graphs.find(entry => entry.id === 'a').graph = null;
        });
      }
      return request(name, work);
    };
    const state = await f.launch('live-list'); await concurrent;
    assert.equal(state.defaultId, 'b', action);
    assert.equal(readLibrary(f.storage).assignments.live, 'b', action);
  }
});

test('explicit stale/invalid selections and failed commits never substitute or persist another graph', async () => {
  const f = await fixture();
  await f.store.create({ id: 'a', name: 'A', graph: simple() });
  const before = f.storage.getItem(LIBRARY_KEY);
  await assert.rejects(f.launch('live-open', 'missing'), /Graph Library/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  f.storage.setItem = () => { throw Error('storage full'); };
  await assert.rejects(f.launch('live-open', 'a'), /storage full/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  // Fallback must also surface a failed commit rather than claim a selection.
  const other = await fixture();
  await other.store.change(current => { current.assignments.live = null; });
  const unselected = other.storage.getItem(LIBRARY_KEY);
  other.storage.setItem = f.storage.setItem;
  await assert.rejects(other.launch('live-list'), /storage full/);
  assert.equal(other.storage.getItem(LIBRARY_KEY), unselected);
});

test('an explicit Open choice deleted before the selection lock is acquired fails without fallback', async () => {
  const f = await fixture();
  await f.store.create({ id: 'chosen', name: 'A chosen', graph: simple() });
  const request = f.locks.request.bind(f.locks); let calls = 0, deleted;
  f.locks.request = (name, work) => {
    if (++calls === 2) deleted = f.store.delete('chosen');
    return request(name, work);
  };
  await assert.rejects(f.launch('live-open', 'chosen'), /missing/); await deleted;
  assert.equal(readLibrary(f.storage).assignments.live, 'default-live');
});

test('no runnable graphs return an empty list without inventing a selection or writing on refresh', async () => {
  const f = await fixture();
  await f.store.change(current => { current.assignments.live = 'missing'; current.graphs[0].graph = null; });
  const before = f.storage.getItem(LIBRARY_KEY), writes = f.writes;
  assert.deepEqual(await f.launch('live-list'), { graphs: [], defaultId: null });
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  assert.equal(f.writes, writes);
});
