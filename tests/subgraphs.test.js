import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domText } from './fixtures/dom.js';
import { graphNode, defaultGraph, edge, assertGraph, nodeDefinition, executableGraph } from '../extension/graph.js';
import { extractSubgraph, assertSubgraph, assertExtractionPorts, resolveSubgraphs, references } from '../extension/subgraphs.js';
import { GraphLibrary, openLibrary, readLibrary, entryGraph, entryError, exportEntry, resolvedEntryGraph, readLiveGraph, LIBRARY_KEY } from '../extension/graph-library.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { webVoiceGraph, webVoiceChoices } from '../extension/web-voice-graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { GraphEditor } from '../extension/graph-editor.js';

async function fixture() {
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let tail = Promise.resolve();
  const locks = { request: (_, action) => { const next = tail.then(action); tail = next.catch(() => {}); return next; } };
  const store = new GraphLibrary(storage, locks);
  await openLibrary(storage, locks);
  return { storage, store, current: () => readLibrary(storage) };
}
function parent(source = 'ChromeTabAudio', sink = 'Display') {
  return { version: 15, nodes: [graphNode(source, 'audio'), graphNode('Text', 'language'), graphNode('SpeechToTextWhisper', 'asr'), graphNode(sink, 'output')],
    edges: [edge('audio', 'audio', 'asr', 'audio'), edge('language', 'value', 'asr', 'language'), edge('asr', 'final', 'output', sink === 'Display' ? 'input1' : 'text')] };
}
async function sharedFixture() {
  const f = await fixture(), source = parent(); source.nodes[1].settings.value = 'en';
  const extracted = extractSubgraph(source, ['language', 'asr'], 'shared-asr');
  await f.store.create({ id: 'shared-asr', name: 'Shared ASR', kind: 'subgraph', graph: extracted.shared });
  let library = await f.store.create({ name: 'Tab parent', graph: extracted.parent });
  const tab = library.graphs.at(-1).id;
  const micGraph = structuredClone(extracted.parent); micGraph.nodes[0].type = 'MicrophoneAudio'; micGraph.nodes[1] = graphNode('FocusedInputTextOutputNode', 'output');
  micGraph.edges.at(-1).to[1] = 'text';
  library = await f.store.create({ name: 'Mic parent', graph: micGraph });
  return { ...f, extracted, tab, mic: library.graphs.at(-1).id };
}
const find = (library, id) => library.graphs.find(entry => entry.id === id);

function formatterChain() {
  return { version: 15, nodes: [graphNode('Text', 'text'), graphNode('TextFormatter', 'first'), graphNode('TextFormatter', 'second'), graphNode('Display', 'output')],
    edges: [edge('text', 'value', 'first', 'input1'), edge('first', 'text', 'second', 'input1'), edge('second', 'text', 'output', 'input1')] };
}

test('reviewed extraction preserves connected identities and endpoints, including same-type alternatives', () => {
  const { shared } = extractSubgraph(formatterChain(), ['first', 'second'], 'formatters');
  const inferred = structuredClone(shared.interface);
  for (const side of ['inputs', 'outputs']) {
    for (const mutate of [
      graph => graph.interface[side].pop(),
      graph => { graph.interface[side][0].id = 'replacement'; },
      graph => { graph.interface[side][0].node = side === 'inputs' ? 'second' : 'first'; },
      graph => { graph.interface[side][0].port = 'missing'; }
    ]) {
      const draft = structuredClone(shared); mutate(draft);
      assert.throws(() => assertExtractionPorts(draft, inferred), /Keep connected.*to preserve parent connections/);
    }
  }
  shared.interface.inputs[0].name = 'Transcript';
  shared.interface.outputs[0].name = 'Formatted';
  shared.interface.inputs.push({ id: 'optional', name: 'Optional context', node: 'first', port: 'input2' });
  shared.interface.outputs.push({ id: 'preview', name: 'Intermediate text', node: 'first', port: 'text' });
  assert.doesNotThrow(() => assertSubgraph(assertExtractionPorts(shared, inferred)));
  shared.interface.inputs.at(-1).port = 'input3';
  shared.interface.outputs.pop();
  assert.doesNotThrow(() => assertSubgraph(assertExtractionPorts(shared, inferred)));
});

test('extraction preserves every edge and node value with zero or multiple boundary ports', () => {
  for (const withBoundary of [false, true]) {
    const graph = formatterChain();
    if (withBoundary) {
      graph.nodes.find(node => node.id === 'output').settings.inputCount = 2;
      graph.nodes.push(graphNode('Text', 'context'), graphNode('Display', 'fanout'));
      graph.edges.push(edge('context', 'value', 'first', 'input2'), edge('first', 'text', 'output', 'input2'), edge('second', 'text', 'fanout', 'input1'));
    } else graph.edges = [edge('first', 'text', 'second', 'input1')];
    const original = structuredClone(graph);
    const { shared, parent, instance } = extractSubgraph(graph, ['first', 'second'], 'shared');
    assert.deepEqual(graph, original);
    assert.deepEqual(shared.nodes, graph.nodes.filter(node => ['first', 'second'].includes(node.id)));
    assert.deepEqual(shared.edges, [edge('first', 'text', 'second', 'input1')]);
    assert.equal(shared.interface.inputs.length, withBoundary ? 2 : 0);
    assert.equal(shared.interface.outputs.length, withBoundary ? 2 : 0);
    // Expand the remapped boundary using its interface and compare exact wires.
    const endpoint = (value, side) => {
      if (value[0] !== instance.id) return value;
      const port = shared.interface[side].find(port => port.id === value[1]);
      return [port.node, port.port];
    };
    const restored = [...shared.edges, ...parent.edges.map(route => ({ from: endpoint(route.from, 'outputs'), to: endpoint(route.to, 'inputs') }))];
    assert.deepEqual(restored.map(JSON.stringify).sort(), graph.edges.map(JSON.stringify).sort());
    assert.doesNotThrow(() => resolveSubgraphs(parent, [{ id: 'shared', kind: 'subgraph', graph: shared }]));
  }
});

test('rejected extraction writes nothing and the same identity can be retried after repairing reviewed ports', async () => {
  const f = await fixture(), extracted = extractSubgraph(formatterChain(), ['first', 'second'], 'formatters');
  const output = extracted.shared.interface.outputs.pop(), before = f.storage.getItem(LIBRARY_KEY);
  const definition = { id: 'formatters', name: 'Formatters', kind: 'subgraph', graph: extracted.shared, replacementGraph: extracted.parent };
  await assert.rejects(f.store.create(definition), /Unknown port: subgraph.out1/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  extracted.shared.interface.outputs.push(output);
  const saved = await f.store.create(definition);
  assert.equal(saved.graphs.filter(entry => entry.id === 'formatters').length, 1);
  assert.equal(executableGraph(resolveSubgraphs(extracted.parent, saved.graphs)).nodes.length, 4);
});

test('extraction checks its original parent revision after a queued concurrent save acquires the storage lock', async () => {
  const f = await fixture();
  const created = await f.store.create({ name: 'Parent', graph: formatterChain() }), source = created.graphs.at(-1);
  const extracted = extractSubgraph(source.graph, ['first', 'second'], 'formatters');
  const updated = structuredClone(source.graph); updated.nodes.find(node => node.id === 'text').settings.value = 'Saved concurrently';
  const saving = f.store.save(source.id, source.revision, updated);
  const extracting = f.store.create({ id: 'formatters', name: 'Formatters', kind: 'subgraph', graph: extracted.shared,
    replacementGraph: extracted.parent, replacementSource: { id: source.id, revision: source.revision } });
  const [saved] = await Promise.all([saving, assert.rejects(extracting, /Parent graph changed while Create Subgraph was open/)]);
  assert.equal(f.storage.getItem(LIBRARY_KEY), JSON.stringify(saved));
  assert.equal(find(f.current(), source.id).graph.nodes.find(node => node.id === 'text').settings.value, 'Saved concurrently');
  assert.equal(find(f.current(), 'formatters'), undefined);
});

test('extraction commits the definition and revision-checked parent in one write; failed writes and validation are atomic', async () => {
  const f = await fixture();
  const created = await f.store.create({ name: 'Parent', graph: formatterChain() }), source = created.graphs.at(-1);
  const extracted = extractSubgraph(source.graph, ['first', 'second'], 'formatters');
  const definition = { id: 'formatters', name: 'Formatters', kind: 'subgraph', graph: extracted.shared,
    replacementGraph: extracted.parent, replacementSource: { id: source.id, revision: source.revision } };
  const before = f.storage.getItem(LIBRARY_KEY), writes = [], set = f.storage.setItem;
  f.storage.setItem = () => { throw Error('Storage full'); };
  await assert.rejects(f.store.create(definition), /Storage full/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  f.storage.setItem = (key, value) => { writes.push(value); set(key, value); };
  const invalid = structuredClone(definition); invalid.graph.interface.outputs = [];
  await assert.rejects(f.store.create(invalid), /Unknown port/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  assert.equal(writes.length, 0);
  const saved = await f.store.create(definition);
  assert.equal(writes.length, 1);
  const published = JSON.parse(writes[0]), parent = find(published, source.id);
  assert.deepEqual(parent.graph, extracted.parent);
  assert.notEqual(parent.revision, source.revision);
  assert.deepEqual(find(published, 'formatters').graph, extracted.shared);
  assert.deepEqual(f.current(), saved);
});

test('unchanged exposed contracts cannot silently disable complete or partial parent paths', async () => {
  const f = await fixture(), extracted = extractSubgraph(formatterChain(), ['first', 'second'], 'formatters');
  await f.store.create({ id: 'formatters', name: 'Formatters', kind: 'subgraph', graph: extracted.shared });
  await f.store.create({ name: 'Complete parent', graph: extracted.parent });
  const partial = structuredClone(extracted.parent);
  // This parent remains runnable after the shared path breaks, with the same
  // source and sink active; comparing only node counts would miss lost wiring.
  partial.nodes.find(node => node.id === 'output').settings.inputCount = 2;
  partial.edges.push(edge('text', 'value', 'output', 'input2'));
  await f.store.create({ name: 'Partial parent', graph: partial });
  const library = f.current(), shared = find(library, 'formatters'), draft = entryGraph(shared);
  draft.edges = [];
  const before = f.storage.getItem(LIBRARY_KEY);
  const editor = Object.assign(Object.create(GraphEditor.prototype), { kind: 'subgraph', graphId: shared.id, definitions: library.graphs, draft });
  assert.match(editor.diagnostics(true), /Cannot disable executable paths.*Complete parent, Partial parent.*Restore the internal connections.*Duplicate this subgraph/);
  await assert.rejects(f.store.save(shared.id, shared.revision, draft), /Cannot disable executable paths.*Complete parent, Partial parent/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  // Reordering internals changes expansion IDs but leaves the boundary runnable.
  const repaired = entryGraph(shared); repaired.nodes.reverse();
  await f.store.save(shared.id, shared.revision, repaired);
});

for (const assigned of [true, false]) test(`shared saves preserve Web voice compatibility with unchanged ports (legacy default: ${assigned})`, async () => {
  const f = await fixture(), graph = parent('MicrophoneAudio', 'FocusedInputTextOutputNode');
  graph.nodes.push(graphNode('TextFormatter', 'format'));
  graph.edges.at(-1).to = ['format', 'input1'];
  graph.edges.push(edge('format', 'text', 'output', 'text'));
  const extracted = extractSubgraph(graph, ['format'], 'shared-formatter');
  await f.store.create({ id: 'shared-formatter', name: 'Shared formatter', kind: 'subgraph', graph: extracted.shared });
  let library = await f.store.create({ name: 'Web parent', graph: extracted.parent });
  const parentId = library.graphs.at(-1).id;
  if (assigned) library = await f.store.assign('webVoice', parentId, library.revision);
  assert.deepEqual(webVoiceChoices(library).map(entry => entry.id), [parentId]);
  const shared = find(library, 'shared-formatter'), draft = entryGraph(shared);
  // The external IDs and TEXT types stay identical, and the path still runs
  // generically; only the Web dictation semantics become unsafe.
  draft.nodes = [graphNode('TextAccumulator', 'accumulate')];
  draft.interface.inputs[0].node = 'accumulate'; draft.interface.inputs[0].port = 'append';
  draft.interface.outputs[0].node = 'accumulate';
  const candidate = { ...library, graphs: library.graphs.map(entry => entry.id === shared.id ? { ...entry, graph: draft } : entry) };
  assert.equal(executableGraph(resolvedEntryGraph(find(candidate, parentId), candidate)).nodes.length, graph.nodes.length);
  assert.deepEqual(webVoiceChoices(candidate), []);
  const before = f.storage.getItem(LIBRARY_KEY);
  const editor = Object.assign(Object.create(GraphEditor.prototype), { kind: 'subgraph', graphId: shared.id, definitions: library.graphs, draft });
  assert.match(editor.diagnostics(true), /Cannot break Web voice paths.*Web parent:.*TextAccumulator.*Duplicate this subgraph/);
  await assert.rejects(f.store.save(shared.id, shared.revision, draft), /Cannot break Web voice paths.*Web parent:.*TextAccumulator.*Duplicate this subgraph/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  assert.deepEqual(webVoiceChoices(f.current()).map(entry => entry.id), [parentId]);
  const repaired = entryGraph(shared); repaired.nodes[0].settings.template = 'Updated: {1}';
  const saved = await f.store.save(shared.id, shared.revision, repaired);
  assert.deepEqual(find(saved, parentId), find(library, parentId));
  assert.equal(webVoiceChoices(saved)[0].graph.nodes.find(node => node.type === 'TextFormatter').settings.template, 'Updated: {1}');
});

test('shared Live-only paths can use cumulative processing without Web voice restrictions', async () => {
  const f = await fixture(), extracted = extractSubgraph(formatterChain(), ['first'], 'formatter');
  await f.store.create({ id: 'formatter', name: 'Formatter', kind: 'subgraph', graph: extracted.shared });
  await f.store.create({ name: 'Live parent', graph: extracted.parent });
  const shared = find(f.current(), 'formatter'), draft = entryGraph(shared);
  draft.nodes = [graphNode('TextAccumulator', 'accumulate')];
  draft.interface.inputs[0].node = 'accumulate'; draft.interface.inputs[0].port = 'append';
  draft.interface.outputs[0].node = 'accumulate';
  const saved = await f.store.save(shared.id, shared.revision, draft);
  assert.equal(find(saved, shared.id).graph.nodes[0].type, 'TextAccumulator');
});

test('extraction infers stable typed boundary ports, preserves fan-out, settings and internal grouped edges', () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('Display', 'second'));
  graph.edges.push(edge('speech', 'final', 'second', 'input1'));
  const original = structuredClone(graph), { shared, parent, instance } = extractSubgraph(graph, ['speech', 'coalesce'], 'asr');
  assert.deepEqual(graph, original);
  assert.equal(shared.interface.inputs.length, 1); assert.equal(shared.interface.outputs.length, 3);
  const definition = { id: 'asr', kind: 'subgraph', name: 'ASR', graph: shared };
  const contract = nodeDefinition(instance, parent, [definition]);
  assert.equal(contract.inputs.in1, nodeDefinition(graph.nodes[0], graph).outputs.audio);
  assert.deepEqual(Object.keys(instance).sort(), ['id', 'position', 'settings', 'subgraphId', 'type']);
  const flat = resolveSubgraphs(parent, [definition]);
  assert.equal(flat.nodes.length, graph.nodes.length); assert.equal(flat.edges.length, graph.edges.length);
  const asr = flat.nodes.find(node => node.type === 'SpeechToTextReazonSpeech');
  assert.equal(flat.edges.filter(route => route.from[0] === asr.id && route.from[1] === 'final').length, 2);
  assert.deepEqual(assertGraph(flat), flat);
});

test('extraction rejects disconnected groups, concrete capture/output nodes and nested instances', () => {
  const graph = defaultGraph();
  assert.throws(() => extractSubgraph(graph, ['speech', 'history'], 'x'), /connected group/);
  assert.throws(() => extractSubgraph(graph, ['audio', 'speech'], 'x'), /concrete audio inputs/);
  assert.throws(() => extractSubgraph(graph, ['history', 'transcript'], 'x'), /output destinations/);
  const shared = extractSubgraph(graph, ['speech'], 'x').shared;
  const nested = { ...shared, nodes: [{ id: 'nested', type: 'Subgraph', subgraphId: 'x', settings: {}, position: { x: 0, y: 0 } }] };
  assert.throws(() => assertSubgraph(nested), /Nested or circular/);
});

test('two unchanged parents automatically resolve the latest saved settings; running snapshots stay detached', async () => {
  const f = await sharedFixture(), library = f.current(), before = library.graphs.filter(entry => [f.tab, f.mic].includes(entry.id));
  const snapshot = resolvedEntryGraph(find(library, f.tab), library);
  const shared = find(library, 'shared-asr'), draft = entryGraph(shared); draft.nodes[0].settings.value = 'ja';
  await f.store.save(shared.id, shared.revision, draft);
  const current = f.current();
  assert.deepEqual(current.graphs.filter(entry => [f.tab, f.mic].includes(entry.id)), before);
  for (const id of [f.tab, f.mic]) assert.equal(resolvedEntryGraph(find(current, id), current).nodes.find(node => node.type === 'Text').settings.value, 'ja');
  assert.equal(snapshot.nodes.find(node => node.type === 'Text').settings.value, 'en');
  await f.store.assign('live', f.tab, current.revision);
  assert.equal(readLiveGraph(f.storage).graph.nodes.find(node => node.type === 'Text').settings.value, 'ja');
  assert.equal(webVoiceGraph(resolvedEntryGraph(find(f.current(), f.mic), f.current())).nodes.find(node => node.type === 'Text').settings.value, 'ja');
});

test('port labels and graph renaming retain identity; incompatible removal/type/addition lists parents and writes nothing', async () => {
  const f = await sharedFixture(); let shared = find(f.current(), 'shared-asr');
  const draft = entryGraph(shared); draft.interface.inputs[0].name = 'Audio samples';
  await f.store.save(shared.id, shared.revision, draft);
  shared = find(f.current(), shared.id);
  await f.store.rename(shared.id, 'Renamed ASR', '', shared.revision);
  shared = find(f.current(), shared.id);
  for (const change of [graph => graph.interface.outputs.pop(), graph => { graph.interface.outputs[0].port = 'finalId'; }, graph => graph.interface.outputs.push({ id: 'new', name: 'IDs', node: 'asr', port: 'finalId' })]) {
    const next = entryGraph(shared); change(next); const before = f.storage.getItem(LIBRARY_KEY);
    await assert.rejects(f.store.save(shared.id, shared.revision, next), /Referenced by: Tab parent, Mic parent.*Duplicate this subgraph/);
    assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  }
  const instance = find(f.current(), f.tab).graph.nodes.find(node => node.type === 'Subgraph');
  const definition = nodeDefinition(instance, find(f.current(), f.tab).graph, f.current().graphs);
  assert.equal(definition.label, 'Renamed ASR'); assert.equal(definition.portLabels.inputs.in1, 'Audio samples');
});

test('revision conflicts, concurrent parent/definition saves, missing dependencies and referenced deletion fail safely', async () => {
  const f = await sharedFixture(), old = find(f.current(), 'shared-asr'), tab = find(f.current(), f.tab);
  const changed = entryGraph(old); changed.nodes[0].settings.value = 'ja';
  const moved = entryGraph(tab, f.current()); moved.nodes[0].position.x = 120;
  await Promise.all([f.store.save(old.id, old.revision, changed), f.store.save(tab.id, tab.revision, moved)]);
  const before = f.storage.getItem(LIBRARY_KEY);
  await assert.rejects(f.store.save(old.id, old.revision, old.graph), /changed in another page/);
  await assert.rejects(f.store.delete(old.id, f.current().revision), /Referenced by: Tab parent, Mic parent/);
  await assert.rejects(f.store.assign('webVoice', old.id, f.current().revision), /parent graph/);
  const missing = structuredClone(moved); missing.nodes.find(node => node.type === 'Subgraph').subgraphId = 'missing';
  await assert.rejects(f.store.create({ graph: missing }), /Missing or invalid subgraph/);
  assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  const corrupt = f.current(); find(corrupt, 'shared-asr').graph = null;
  f.storage.setItem(LIBRARY_KEY, JSON.stringify(corrupt));
  assert.ok(entryError(find(corrupt, f.tab), corrupt));
  assert.throws(() => resolvedEntryGraph(find(corrupt, f.tab), corrupt));
  assert.equal(exportEntry(find(corrupt, f.tab), corrupt), JSON.stringify(find(corrupt, f.tab).graph, null, 2));
  corrupt.graphs.push({ graph: { nodes: {} } }, { graph: { nodes: [null] } });
  assert.equal(references(corrupt, old.id).length, 2); // Unrelated corrupt entries cannot break reference inspection.
});

test('port endpoints must exist, be unique, and not already have an internal input wire', () => {
  const shared = extractSubgraph(defaultGraph(), ['speech', 'coalesce'], 'asr').shared;
  const invalid = [graph => graph.interface.inputs[0].node = 'missing', graph => graph.interface.inputs.push({ ...graph.interface.inputs[0], id: 'another' }), graph => graph.interface.inputs.push({ id: 'wired', name: 'Already wired', node: 'coalesce', port: 'input1' })];
  for (const mutate of invalid) { const draft = structuredClone(shared); mutate(draft); assert.throws(() => assertSubgraph(draft), /exposed|internal connection/); }
});

test('duplicate keeps parent references shared; bundled cross-install imports remap once and never overwrite existing definitions', async () => {
  const f = await sharedFixture(); let library = await f.store.duplicate(f.tab), copy = library.graphs.at(-1);
  assert.equal(copy.graph.nodes.find(node => node.type === 'Subgraph').subgraphId, 'shared-asr');
  library = await f.store.duplicate('shared-asr'); assert.notEqual(library.graphs.at(-1).id, 'shared-asr');
  const bundle = JSON.parse(exportEntry(find(library, f.tab), library));
  assert.equal(bundle.format, 'graph-bundle'); assert.equal(bundle.graphs.length, 2);
  const destination = await fixture();
  for (let i = 0; i < 2; i++) {
    const imported = await destination.store.import(bundle, 'imported');
    const root = imported.graphs.at(-1), id = root.graph.nodes.find(node => node.type === 'Subgraph').subgraphId;
    assert.notEqual(id, 'shared-asr'); assert.equal(find(imported, id).kind, 'subgraph');
    assert.equal(entryError(root, imported), ''); assert.equal(resolvedEntryGraph(root, imported).nodes.length, 4);
  }
  assert.equal(destination.current().graphs.length, 5);
  const before = destination.storage.getItem(LIBRARY_KEY); bundle.graphs.pop();
  await assert.rejects(destination.store.import(bundle, 'broken'), /Missing bundled dependency/);
  assert.equal(destination.storage.getItem(LIBRARY_KEY), before);
  const standalone = JSON.parse(exportEntry(find(library, 'shared-asr'), library));
  assert.equal((await destination.store.import(standalone)).graphs.at(-1).kind, 'subgraph');
});

test('self and indirect reference cycles in bundles are rejected before any write', async () => {
  const f = await fixture();
  const item = (id, next) => ({ id, name: id, kind: 'subgraph', description: '', graph: { version: 15, nodes: [{ id: 'inner', type: 'Subgraph', subgraphId: next, settings: {}, position: { x: 0, y: 0 } }], edges: [], interface: { inputs: [], outputs: [] } } });
  for (const graphs of [[item('a', 'a')], [item('a', 'b'), item('b', 'a')]]) {
    const before = f.storage.getItem(LIBRARY_KEY);
    await assert.rejects(f.store.import({ format: 'graph-bundle', version: 1, root: 'a', graphs }), /Nested or circular/);
    assert.equal(f.storage.getItem(LIBRARY_KEY), before);
  }
});

test('a multi-parent bundle remaps one shared identity for every imported parent', async () => {
  const f = await sharedFixture(), source = f.current(), destination = await fixture();
  const value = { format: 'graph-bundle', version: 1, root: f.tab, graphs: [find(source, f.tab), find(source, f.mic), find(source, 'shared-asr')] };
  const imported = await destination.store.import(value);
  const parents = imported.graphs.filter(entry => entry.name === 'Tab parent' || entry.name === 'Mic parent');
  assert.equal(parents.length, 2);
  const references = parents.map(entry => entry.graph.nodes.find(node => node.type === 'Subgraph').subgraphId);
  assert.equal(references[0], references[1]); assert.notEqual(references[0], 'shared-asr');
  for (const entry of parents) assert.equal(entryError(entry, imported), '');
});

test('explicit duplicate-and-rewire migration permits retiring a definition only after both parents are saved', async () => {
  const f = await sharedFixture(); let current = await f.store.duplicate('shared-asr'); const replacement = current.graphs.at(-1);
  const draft = entryGraph(replacement); draft.interface.outputs[0].id = 'transcript';
  await f.store.save(replacement.id, replacement.revision, draft);
  for (const id of [f.tab, f.mic]) {
    current = f.current(); const entry = find(current, id), graph = entryGraph(entry, current), instance = graph.nodes.find(node => node.type === 'Subgraph');
    instance.subgraphId = replacement.id;
    for (const route of graph.edges) if (route.from[0] === instance.id) route.from[1] = 'transcript';
    await f.store.save(id, entry.revision, graph);
    if (id === f.tab) await assert.rejects(f.store.delete('shared-asr'), /Referenced by: Mic parent/);
  }
  await f.store.delete('shared-asr');
  assert.equal(find(f.current(), 'shared-asr'), undefined);
  for (const id of [f.tab, f.mic]) assert.equal(entryError(find(f.current(), id), f.current()), '');
});

test('two instances use distinct runtime nodes; model requirements include shared and parked models', () => {
  const graph = parent(); graph.nodes[1].settings.value = 'en';
  const { shared, parent: extracted } = extractSubgraph(graph, ['language', 'asr'], 'asr');
  shared.nodes.push(graphNode('TextSummaryLfm2', 'parked-summary'));
  const definition = { id: 'asr', kind: 'subgraph', graph: shared, name: 'ASR' };
  const second = { ...structuredClone(extracted.nodes.find(node => node.type === 'Subgraph')), id: 'second' };
  extracted.nodes.push(second, graphNode('Display', 'second-output'));
  extracted.edges.push(edge('audio', 'audio', 'second', 'in1'), edge('second', 'out1', 'second-output', 'input1'));
  const resolved = resolveSubgraphs(extracted, [definition]);
  const asrs = resolved.nodes.filter(node => node.type === 'SpeechToTextWhisper');
  assert.equal(asrs.length, 2); assert.notEqual(asrs[0].id, asrs[1].id);
  assert.deepEqual(graphModelRequirements(resolved).map(model => model.key), ['silero', 'whisper', 'meeting-summary-lfm2']);
  assert.equal(executableGraph(resolved).nodes.some(node => node.type === 'TextSummaryLfm2'), false);
  const wrong = structuredClone(extracted); wrong.edges[0].from = ['second', 'out1'];
  assert.throws(() => resolveSubgraphs(wrong, [definition]), /Incompatible port types/);
});

test('sampled Hold feedback remains legal across a boundary; event cycles revealed by expansion are rejected', () => {
  const graph = { version: 15, nodes: [graphNode('Text', 'text'), graphNode('Hold', 'hold'), graphNode('TextFormatter', 'format'), graphNode('Display', 'display')],
    edges: [edge('text', 'value', 'format', 'input1'), edge('hold', 'value', 'format', 'input2'), edge('format', 'text', 'hold', 'input'), edge('format', 'text', 'display', 'input1')] };
  const extracted = extractSubgraph(graph, ['hold'], 'hold'), definitions = [{ id: 'hold', kind: 'subgraph', name: 'Memory', graph: extracted.shared }];
  assert.deepEqual(nodeDefinition(extracted.instance, extracted.parent, definitions).sampledOutputs, ['out1']);
  assert.doesNotThrow(() => resolveSubgraphs(extracted.parent, definitions));
  // An external trigger makes Hold an ordinary event source. The expanded
  // graph must apply that actual connection, rather than trusting cached ports.
  definitions[0].graph.interface.inputs.push({ id: 'trigger', name: 'Trigger', node: 'hold', port: 'trigger' });
  extracted.parent.nodes.push(graphNode('Button', 'button'));
  extracted.parent.edges.push(edge('button', 'trigger', extracted.instance.id, 'trigger'));
  assert.throws(() => resolveSubgraphs(extracted.parent, definitions), /acyclic/);
});

test('ASR grouped final/ID and preview clear deliveries retain their correlation across shared output ports', async () => {
  const extracted = extractSubgraph(defaultGraph(), ['speech'], 'asr'), views = [], workers = [];
  const resolved = resolveSubgraphs(extracted.parent, [{ id: 'asr', kind: 'subgraph', name: 'ASR', graph: extracted.shared }]);
  const workerFactory = () => {
    const worker = { terminated: false, postMessage(data) {
      queueMicrotask(() => {
        if (data.type === 'load') this.onmessage({ data: { type: 'ready' } });
        if (data.type === 'vad-stop') this.onmessage({ data: { type: 'vad-stopped', session: data.session } });
      });
    }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  };
  const built = buildGraph(resolved, { sourceFactory: () => ({ start() {}, stop() {} }), workerFactory,
    onDisplay: (_, state) => views.push(domText(state)) });
  const speech = [...built.speechNodes.values()][0];
  try {
    await built.pipeline.start();
    speech.receiveEvent({ type: 'partial', id: 0, text: 'preview' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(views.at(-1), 'preview');
    speech.receiveEvent({ type: 'final', id: 0, text: 'committed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(views.at(-1), 'committed');
    await built.pipeline.stop();
  } finally { await built.pipeline.dispose(); }
  assert.ok(workers.every(worker => worker.terminated));
});

test('flattened boundaries preserve real runtime events and independent per-instance state', async () => {
  const text = graphNode('Text', 'source'); text.settings.value = 'first';
  const formatter = graphNode('TextFormatter', 'format'); formatter.settings.template = 'Shared: {1}';
  const graph = { version: 15, nodes: [text, formatter, graphNode('Display', 'output')], edges: [edge('source', 'value', 'format', 'input1'), edge('format', 'text', 'output', 'input1')] };
  const extracted = extractSubgraph(graph, ['format'], 'format'), definitions = [{ id: 'format', kind: 'subgraph', name: 'Formatter', graph: extracted.shared }];
  const firstStates = [], secondStates = [], snapshot = resolveSubgraphs(extracted.parent, definitions);
  const first = buildGraph(snapshot, { onDisplay: (_, state) => firstStates.push(domText(state)) });
  await first.pipeline.start();
  definitions[0].graph.nodes[0].settings.template = 'Changed: {1}';
  const second = buildGraph(resolveSubgraphs(extracted.parent, definitions), { onDisplay: (_, state) => secondStates.push(domText(state)) });
  await second.pipeline.start();
  assert.equal(firstStates.at(-1), 'Shared: first'); assert.equal(secondStates.at(-1), 'Changed: first');
  await first.pipeline.dispose();
  const id = [...second.pipeline.entries.values()].find(entry => entry.node.constructor.name === 'TextFormatterNode');
  assert.ok(id); // Disposing one graph must leave the other running.
  assert.equal(second.pipeline.state, 'running');
  await second.pipeline.stop(); await second.pipeline.dispose();
});

test('Live/Web snapshots own separate ASR workers; disposing one leaves the other usable and final cleanup terminates all', async () => {
  const f = await sharedFixture(), library = f.current(), workers = [];
  const workerFactory = () => {
    const worker = { terminated: false, postMessage(data) {
      if (data.type === 'load') queueMicrotask(() => { if (!this.terminated) this.onmessage({ data: { type: 'ready' } }); });
    }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  };
  const live = buildGraph(resolvedEntryGraph(find(library, f.tab), library), { whisperWorkerFactory: workerFactory });
  const web = buildGraph(webVoiceGraph(resolvedEntryGraph(find(library, f.mic), library)), { whisperWorkerFactory: workerFactory });
  const liveSpeech = [...live.speechNodes.values()][0], webSpeech = [...web.speechNodes.values()][0];
  await Promise.all([liveSpeech.load(), webSpeech.load()]);
  assert.equal(workers.length, 4); assert.notEqual(liveSpeech, webSpeech);
  await live.pipeline.dispose();
  assert.equal(workers.filter(worker => worker.terminated).length, 2);
  assert.ok(!webSpeech.disposed);
  await web.pipeline.dispose(); assert.ok(workers.every(worker => worker.terminated));
});
