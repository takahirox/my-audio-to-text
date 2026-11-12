import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, readLiveGraph, entryGraph, entryError, exportEntry, exportDraft, validateLibrary, saveLiveGraphData } from '../extension/graph-library.js';
import { defaultGraph, graphNode, edge, GRAPH_KEY, readGraph, saveGraph } from '../extension/graph.js';

function storage(source = null) {
  const values = new Map(source === null ? [] : [[GRAPH_KEY, source]]);
  return { values, fail: false, getItem: key => values.get(key) ?? null, setItem(key, value) { if (this.fail) throw Error('Storage quota exceeded'); values.set(key, value); } };
}
function locks() {
  let pending = Promise.resolve();
  return { request(name, action) { const result = pending.then(action); pending = result.catch(() => {}); return result; } };
}
async function fixture(source) {
  const s = storage(source), lock = locks(), store = new GraphLibrary(s, lock);
  const { library } = await openLibrary(s, lock);
  return { s, lock, store, library };
}
const entry = (library, id = library.assignments.live) => library.graphs.find(e => e.id === id);

test('migration is lossless, idempotent and serialized across simultaneous opens; legacy JSON stays byte-for-byte', async () => {
  const graph = defaultGraph(); graph.nodes[0].position = { x: 123.5, y: 987.25 };
  const raw = '  ' + JSON.stringify(graph, null, 3) + '\n', s = storage(raw), lock = locks();
  const opened = await Promise.all(Array.from({ length: 8 }, () => openLibrary(s, lock)));
  for (const { library, warning } of opened) {
    assert.equal(warning, ''); assert.equal(library.graphs.length, 1);
    assert.deepEqual(entry(library).graph, graph); assert.equal(entry(library).source, raw);
    assert.equal(library.assignments.live, 'legacy-graph'); assert.equal(library.assignments.webVoice, null);
  }
  const saved = s.getItem(LIBRARY_KEY);
  await openLibrary(s, lock); assert.equal(s.getItem(LIBRARY_KEY), saved); assert.equal(s.getItem(GRAPH_KEY), raw);
  assert.deepEqual(readLiveGraph(s).graph, graph);
});

test('fresh installation creates only a named Live default; no Web voice assignment', async () => {
  const { library, s } = await fixture();
  assert.equal(entry(library).name, 'Live transcription'); assert.deepEqual(entry(library).graph, defaultGraph());
  assert.equal(library.assignments.webVoice, null); assert.equal(s.getItem(GRAPH_KEY), null);
});

test('invalid draft export preserves current edits while saved legacy recovery stays byte-for-byte', async () => {
  const raw = '  ' + JSON.stringify(defaultGraph()) + '\n';
  const { library } = await fixture(raw), saved = entry(library);
  const draft = entryGraph(saved, library);
  draft.nodes.push({ id: 'shared', type: 'Subgraph', subgraphId: 'deleted', settings: {}, position: { x: 0, y: 0 } });
  draft.nodes[0].position.x = 321;
  assert.deepEqual(JSON.parse(exportDraft(saved, draft, library)), draft);
  assert.equal(saved.source, raw);
  const invalidSaved = { ...saved, graph: { version: 999 } };
  assert.equal(exportEntry(invalidSaved, library), raw);
  assert.deepEqual(JSON.parse(exportDraft(invalidSaved, draft, library)), draft);
});

for (const raw of ['{broken JSON', '{"version":999,"nodes":[],"edges":[]}', JSON.stringify({ ...defaultGraph(), nodes: [{ id: 'bad', type: 'Unsupported' }] })]) test(`corrupt legacy remains recoverable: ${raw.slice(0, 28)}`, async () => {
  const { library, s, store } = await fixture(raw);
  assert.ok(entryError(entry(library))); assert.equal(exportEntry(entry(library)), raw);
  assert.throws(() => readLiveGraph(s));
  await assert.rejects(store.save(entry(library).id, entry(library).revision, defaultGraph()), /original has been kept/);
  await store.create({ name: 'Recovery' });
  const next = readLibrary(s), recovery = next.graphs.at(-1);
  await store.assign('live', recovery.id, next.revision);
  assert.deepEqual(readLiveGraph(s).graph, defaultGraph()); assert.equal(s.getItem(GRAPH_KEY), raw);
  assert.equal(exportEntry(entry(readLibrary(s), 'legacy-graph')), raw);
});

test('failed or interrupted migration returns a deterministic fallback and later retries exactly once', async () => {
  const raw = JSON.stringify(defaultGraph()), s = storage(raw), lock = locks(); s.fail = true;
  for (let i = 0; i < 2; i++) {
    const result = await openLibrary(s, lock);
    assert.match(result.warning, /could not be committed/); assert.equal(entry(result.library).id, 'legacy-graph');
    assert.equal(s.getItem(LIBRARY_KEY), null); assert.equal(s.getItem(GRAPH_KEY), raw);
  }
  s.fail = false; const result = await openLibrary(s, lock);
  assert.equal(result.library.graphs.length, 1); assert.equal(result.warning, '');
});

test('CRUD, per-graph edits, portable duplicate/import/export and stable independent assignments', async () => {
  const { s, store, library } = await fixture(); const first = entry(library), original = structuredClone(first);
  await store.duplicate(first.id);
  let current = readLibrary(s), copy = current.graphs.at(-1);
  assert.notEqual(copy.id, first.id); assert.equal(copy.name, first.name + ' copy'); assert.deepEqual(copy.graph, first.graph);
  const graph = entryGraph(copy); graph.nodes[0].position.x += 10;
  current = await store.save(copy.id, copy.revision, graph); copy = current.graphs.at(-1);
  assert.deepEqual(entry(current), original);
  current = await store.rename(copy.id, 'Meeting Notes', 'A purpose', copy.revision); copy = current.graphs.at(-1);
  assert.equal(copy.name, 'Meeting Notes'); assert.equal(copy.id, readLibrary(s).graphs.at(-1).id);
  const portable = JSON.parse(exportEntry(copy)); assert.deepEqual(portable, graph); assert.equal(portable.version, 15); assert.equal(portable.id, undefined);
  current = await store.create({ name: 'Imported', graph: portable }, current.revision);
  assert.notEqual(current.graphs.at(-1).id, copy.id); assert.deepEqual(current.graphs.at(-1).graph, graph);
  current = await store.assign('webVoice', copy.id, current.revision);
  current = await store.assign('live', current.graphs.at(-1).id, current.revision);
  assert.equal(readLiveGraph(s).id, current.assignments.live); assert.equal(current.assignments.webVoice, copy.id);
  current = await store.delete(first.id, current.revision); assert.equal(current.graphs.length, 2);
});

test('invalid imports and failed writes leave the whole library and original sources untouched', async () => {
  const { s, store } = await fixture(JSON.stringify(defaultGraph()));
  const before = s.getItem(LIBRARY_KEY);
  for (const graph of [{ version: 999 }, { ...defaultGraph(), nodes: [{ type: 'made-up', id: 'no' }] }, { ...defaultGraph(), edges: [edge('audio', 'missing', 'speech', 'audio')] }]) {
    await assert.rejects(async () => store.create({ graph })); assert.equal(s.getItem(LIBRARY_KEY), before);
  }
  s.fail = true; await assert.rejects(store.create(), /quota/); assert.equal(s.getItem(LIBRARY_KEY), before);
});

test('revisions reject stale edits to the same graph; independent concurrent graph edits survive', async () => {
  const { store, s, library, lock } = await fixture();
  await store.duplicate(entry(library).id); const current = readLibrary(s), a = current.graphs[0], b = current.graphs[1];
  const second = new GraphLibrary(s, lock);
  const ga = entryGraph(a), gb = entryGraph(b); ga.nodes[0].position.x += 11; gb.nodes[0].position.x += 22;
  await Promise.all([store.save(a.id, a.revision, ga), second.save(b.id, b.revision, gb)]);
  assert.deepEqual(entry(readLibrary(s), a.id).graph, ga); assert.deepEqual(entry(readLibrary(s), b.id).graph, gb);
  const before = s.getItem(LIBRARY_KEY);
  await assert.rejects(second.save(a.id, a.revision, defaultGraph()), /reload the latest.*draft has been kept/);
  await assert.rejects(second.assign('live', b.id, current.revision), /changed/);
  await assert.rejects(second.rename(b.id, 'Stale', '', b.revision), /changed/);
  assert.equal(s.getItem(LIBRARY_KEY), before); assert.equal(ga.nodes[0].position.x, 31);
});

test('deleting a default clears it explicitly; last usable graph and invalid choices remain protected', async () => {
  const { store, s, library } = await fixture(), a = entry(library);
  await assert.rejects(store.delete(a.id), /Keep at least one usable/);
  await store.create({ graph: { version: 15, nodes: [graphNode('Text', 'parked')], edges: [] } });
  let current = readLibrary(s), b = current.graphs.at(-1);
  await assert.rejects(store.assign('live', b.id), /executable path/);
  await assert.rejects(store.assign('live', 'missing'));
  await assert.rejects(store.assign('invalid-target', a.id));
  current = await store.assign('webVoice', b.id);
  current = await store.delete(b.id);
  assert.equal(current.assignments.webVoice, null);
  assert.equal(current.graphs.length, 1);
});

test('a corrupt graph cannot break browsing, replace a valid entry, or overwrite its corrupt source', async () => {
  const { s, store, library } = await fixture(); await store.duplicate(entry(library).id);
  const current = readLibrary(s), bad = current.graphs.at(-1); bad.graph.version = 999;
  s.setItem(LIBRARY_KEY, JSON.stringify(current));
  assert.equal(readLibrary(s).graphs.length, 2); assert.deepEqual(readLiveGraph(s).graph, defaultGraph());
  assert.match(entryError(bad), /version/); assert.equal(JSON.parse(exportEntry(bad)).version, 999);
  const before = s.getItem(LIBRARY_KEY);
  await assert.rejects(store.save(bad.id, bad.revision, defaultGraph()), /original/);
  await assert.rejects(store.duplicate(bad.id)); assert.equal(s.getItem(LIBRARY_KEY), before);
});

test('duplicate graph IDs, malformed metadata and unsupported versions fail closed without overwrites', async () => {
  const { s, lock, library } = await fixture();
  for (const corrupt of [ { ...library, graphs: [...library.graphs, library.graphs[0]] }, { ...library, assignments: { live: 42, webVoice: null } }, { ...library, version: 99 } ]) {
    const raw = JSON.stringify(corrupt); s.setItem(LIBRARY_KEY, raw);
    assert.throws(() => validateLibrary(corrupt)); await assert.rejects(openLibrary(s, lock)); assert.equal(s.getItem(LIBRARY_KEY), raw);
  }
});

test('legacy edits after migration block saving/Live until explicitly recovered as a new entry', async () => {
  const { s, store, library } = await fixture(JSON.stringify(defaultGraph())), original = entry(library);
  const changed = defaultGraph(); changed.nodes[0].position.x = 999;
  const raw = JSON.stringify(changed); s.setItem(GRAPH_KEY, raw);
  assert.throws(() => readLiveGraph(s), /legacy graph changed/);
  await assert.rejects(store.save(original.id, original.revision, defaultGraph()), /Legacy graph changed/);
  await store.recoverLegacy(library.revision); const current = readLibrary(s);
  assert.equal(current.graphs.length, 2); assert.deepEqual(current.graphs.at(-1).graph, changed);
  assert.deepEqual(entry(current), original); assert.equal(current.assignments.live, original.id); assert.equal(s.getItem(GRAPH_KEY), raw);
  await store.recoverLegacy(current.revision); assert.equal(readLibrary(s).graphs.length, 2);
});

test('legacy readGraph/saveGraph never silently read or overwrite a library selection', async () => {
  const { s } = await fixture(); const before = s.getItem(LIBRARY_KEY);
  assert.throws(() => readGraph(s), /explicit graph ID/); assert.throws(() => saveGraph(s, defaultGraph()), /graph ID and revision/);
  assert.equal(s.getItem(LIBRARY_KEY), before);
});

test('hosts without Web Locks remain read-only', async () => {
  const s = storage(), result = await openLibrary(s, null), store = new GraphLibrary(s, null);
  assert.match(result.warning, /Web Locks/); assert.equal(s.getItem(LIBRARY_KEY), null);
  await assert.rejects(store.create(), /Web Locks/);
});

test('last usable unassigned graph cannot be deleted while another entry needs recovery', async () => {
  const { store, s } = await fixture('{broken');
  await store.create({ graph: defaultGraph() });
  const current = readLibrary(s), valid = current.graphs.at(-1);
  await assert.rejects(store.delete(valid.id, current.revision), /Keep at least one usable/);
  assert.equal(readLibrary(s).graphs.length, 2);
});

test('a draft loaded before a failed migration cannot overwrite a newly migrated legacy edit', async () => {
  const s = storage(JSON.stringify(defaultGraph())), lock = locks(); s.fail = true;
  const fallback = await openLibrary(s, lock), draft = entry(fallback.library);
  const changed = defaultGraph(); changed.nodes[0].position.x = 666; s.values.set(GRAPH_KEY, JSON.stringify(changed));
  s.fail = false; await openLibrary(s, lock);
  await assert.rejects(new GraphLibrary(s, lock).save(draft.id, draft.revision, draft.graph), /changed/);
  assert.deepEqual(readLiveGraph(s).graph, changed);
});

test('migration retains pre-numbered version-15 Display ports without canonicalizing the source', async () => {
  const graph = { version: 15, nodes: [graphNode('Text', 'text'), { ...graphNode('Display', 'display'), settings: {} }], edges: [edge('text', 'value', 'display', 'input')] };
  const raw = JSON.stringify(graph), { library, s } = await fixture(raw);
  assert.deepEqual(entry(library).graph, graph); assert.equal(entry(library).graph.version, 15);
  assert.equal(readLiveGraph(s).graph.edges[0].to[1], 'input1');
  assert.equal(s.getItem(GRAPH_KEY), raw); assert.equal(entry(readLibrary(s)).graph.edges[0].to[1], 'input');
});

test('explicit Live compatibility saves can initialize an unopened library without editing its legacy key', async () => {
  const s = storage(), lock = locks(), graph = defaultGraph(); graph.nodes[0].position.x = 321;
  await saveLiveGraphData(s, graph, lock);
  assert.deepEqual(readLiveGraph(s).graph, graph); assert.equal(s.getItem(GRAPH_KEY), null);
  assert.equal(readLibrary(s).graphs.length, 1);
});

test('an invalidated extension messaging context cannot report a committed graph save as failed', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage() { throw Error('Extension context invalidated'); } } } });
  try {
    const { s, store } = await fixture();
    const next = await store.create({ name: 'Committed graph' });
    assert.equal(next.graphs.at(-1).name, 'Committed graph');
    assert.equal(readLibrary(s).revision, next.revision);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else delete globalThis.chrome;
  }
});
