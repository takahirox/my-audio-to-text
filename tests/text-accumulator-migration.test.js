import { reviewGraph, reviewSavedGraph, addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGraph, migrateGraph, graphNode, edge, readGraph, saveGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { TabSession } from '../extension/session.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const store = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) }; };

function legacy() {
  const nodes = [graphNode('Text', 'a'), graphNode('Text', 'b'), graphNode('LiveTextDisplay', 'mixed'), graphNode('LiveTextDisplay', 'appendonly'),
    graphNode('LiveTextDisplay', 'snapshot'), graphNode('LiveTextDisplay', 'draft'), graphNode('TextFormatter', 'format'), graphNode('FocusedInputTextOutputNode', 'field'),
    graphNode('TextAccumulator', 'mixed-accumulator'), graphNode('MeetingSummaryLfm2', 'summary'), graphNode('LiveTextDisplay', 'notes')];
  nodes[2].settings = { label: 'My mixed display', language: 'ja' }; nodes[2].position = { x: 9876, y: 1234 };
  nodes[5].settings = { label: 'Replace-only disconnected draft', language: 'en' };
  return { version: 9, translationDirection: 'en-ja', nodes, edges: [edge('a', 'value', 'mixed', 'append'), edge('b', 'value', 'mixed', 'replace'),
    edge('a', 'value', 'appendonly', 'append'), edge('b', 'value', 'snapshot', 'replace'), edge('a', 'value', 'format', 'input1'),
    edge('format', 'text', 'field', 'text'), edge('summary', 'summary', 'notes', 'replace')] };
}

test('v9 migration retains independent sources, drafts, fan-out, positions/settings and minimal collision-safe accumulation', () => {
  const graph = legacy(), original = structuredClone(graph), next = reviewGraph(graph);
  assert.equal(next.version, 15); assert.deepEqual(graph, original);
  for (const node of original.nodes) assert.deepEqual(next.nodes.find(n => n.id === node.id), node);
  assert.equal(next.nodes.length, original.nodes.length + 8);
  assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(edge('a', 'value', 'mixed-accumulator-2', 'append'))));
  assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(edge('b', 'value', 'mixed-dom-preview', 'text'))));
  for (const route of [edge('a', 'value', 'appendonly-accumulator', 'append'), edge('b', 'value', 'snapshot-dom', 'text'), edge('summary', 'summary', 'notes-dom', 'text'),
    edge('a', 'value', 'format', 'input1'), edge('format', 'text', 'field', 'text')]) assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(route)));
  assert.equal(migrateGraph(next), next);
});

test('v9 read retains exact original and all older recovery copies; repeated imports never overwrite backups', () => {
  const storage = store(), raw = JSON.stringify(legacy(), null, 2);
  storage.setItem('processing-graph-before-v9', 'older recovery'); storage.setItem(GRAPH_RECOVERY_KEY, 'earlier v9 recovery'); storage.setItem(GRAPH_KEY, raw);
  const graph = reviewSavedGraph(storage); assert.equal(graph.version, 15);
  assert.equal(storage.getItem('processing-graph-before-v9'), 'older recovery'); assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), 'earlier v9 recovery');
  assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-2`), raw);
  storage.setItem(GRAPH_KEY, raw); reviewSavedGraph(storage); assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-3`), null);
  const another = legacy(); another.nodes[0].settings.value = 'another'; storage.setItem(GRAPH_KEY, JSON.stringify(another)); reviewSavedGraph(storage);
  assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-3`), JSON.stringify(another));
  const failing = { ...storage, setItem(k,v) { if (k.startsWith(GRAPH_RECOVERY_KEY)) throw Error('Quota'); storage.setItem(k,v); } };
  another.nodes[0].settings.value = 'unbacked'; const unbacked = JSON.stringify(another); storage.setItem(GRAPH_KEY, unbacked);
  assert.throws(() => saveGraph(failing, graph), /Quota/); assert.equal(storage.getItem(GRAPH_KEY), unbacked);
});

for (const type of ['SpeechToTextReazonSpeech', 'SpeechToTextZipformerEn', 'SpeechToTextMoonshineMediumEn', 'TranslationCommit']) {
  test(`v9 ${type} paired ports retain grouped topology and direct formatter fan-out`, () => {
    const graph = { version: 9, nodes: [graphNode(type, 'producer'), graphNode('LiveTextDisplay', 'display'), graphNode('TextFormatter', 'formatter')],
      edges: [edge('producer', 'final', 'display', 'append'), edge('producer', 'provisional', 'display', 'replace'), edge('producer', 'final', 'formatter', 'input1')] };
    const next = reviewGraph(graph);
    for (const route of [edge('producer', 'final', 'display-accumulator', 'append'), edge('producer', 'provisional', 'display-dom-preview', 'text'), graph.edges[2]]) assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(route)));
    assert.equal(next.edges.some(e => e.to[1] === 'preview'), false);
  });
}

test('migrated mixed sources preserve independent delivery, duplicates and Stop; snapshots remain direct', async () => {
  const graph = legacy(), displays = {};
  const built = buildGraph(reviewGraph(graph), { onDisplay: (id,text) => displays[id] = domText(text) });
  await built.pipeline.start(); await tick();
  const emit = (id, text) => built.pipeline.entries.get(id).context.emit('value', text);
  emit('b', 'preview'); emit('a', 'same'); emit('a', 'same'); emit('b', 'tail'); await tick();
  assert.equal(displays.mixed, '\nsame\nsametail'); // Text.a's initial empty segment is accepted.
  assert.equal(displays.snapshot, 'tail');
  await built.pipeline.stop(); assert.equal(displays.mixed, '\nsame\nsametail'); assert.equal(displays.snapshot, 'tail');
  await built.pipeline.dispose();
});

for (const operation of ['stop', 'cancel']) {
  test(`migrated inactive append draft retains the latest snapshot on ${operation}, including after reload`, async () => {
    const graph = { version: 9, nodes: [graphNode('Text', 'snapshot'), graphNode('TextFormatter', 'draft'), graphNode('LiveTextDisplay', 'view')],
      edges: [edge('snapshot', 'value', 'view', 'replace'), edge('draft', 'text', 'view', 'append')] };
    graph.nodes[0].settings.value = 'literal snapshot';
    const storage = store(), original = JSON.stringify(graph);
    storage.setItem(GRAPH_KEY, original);
    reviewSavedGraph(storage);
    const migrated = reviewSavedGraph(storage);
    assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), original);
    assert.ok(migrated.nodes.some(node => node.id === 'draft'));
    assert.ok(migrated.edges.some(route => JSON.stringify(route) === JSON.stringify(edge('draft', 'text', 'view-accumulator', 'append'))));
    const session = new TabSession(() => {}, { graph: migrated });
    await session.start(); await tick();
    assert.equal(session.session.description.nodes.some(node => node.id === 'draft'), false);
    assert.equal(domText(session.view.displays.view), 'literal snapshot');
    const source = session.session.pipeline.entries.get('snapshot');
    source.context.emit('value', 'latest snapshot'); await tick();
    assert.equal(domText(session.view.displays.view), 'latest snapshot');
    await session[operation](); await tick();
    assert.equal(domText(session.view.displays.view), 'latest snapshot');

  });
}

test('v12 paired previews require review, preserve fan-out/settings and round-trip exactly with old backups', () => {
  const graph = pairedGraph(), raw = JSON.stringify(graph, null, 2), storage = store();
  storage.setItem(GRAPH_KEY, raw);
  for (const key of ['processing-graph-before-v9', 'processing-graph-before-v12', GRAPH_RECOVERY_KEY]) storage.setItem(key, `older ${key}`);
  let draft;
  assert.throws(() => readGraph(storage), error => {
    draft = error.recoveryGraph;
    return /v13 requires review/.test(error.message) && !!draft;
  });
  assert.throws(() => buildGraph(graph), /requires review/);
  assert.equal(storage.getItem(GRAPH_KEY), raw);
  assert.deepEqual(graph, JSON.parse(raw));
  for (const node of graph.nodes) assert.deepEqual(draft.nodes.find(n => n.id === node.id), node);
  for (const route of [edge('speech', 'final', 'field', 'text'), edge('dom', 'dom', 'dom-combined-2', 'first'), edge('dom-combined-2', 'dom', 'live', 'dom'), edge('dom-combined-2', 'dom', 'other', 'dom')]) assert.ok(draft.edges.some(e => JSON.stringify(e) === JSON.stringify(route)));
  assert.deepEqual(draft.nodes.find(n => n.id === 'dom-preview-2').settings, { className: 'custom' });
  saveGraph(storage, draft); assert.deepEqual(readGraph(storage), draft);
  assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-2`), raw);
  assert.equal(storage.getItem('processing-graph-before-v12'), 'older processing-graph-before-v12');
  storage.setItem(GRAPH_KEY, raw); reviewSavedGraph(storage);
  assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-3`), null);
});

function pairedGraph() {
  const graph = { version: 12, nodes: [graphNode('ChromeTabAudio', 'audio'), graphNode('SpeechToTextZipformerEn', 'speech'), graphNode('TextAccumulator', 'acc'), graphNode('TextToDOM', 'dom'), graphNode('LiveTextDisplay', 'live'), graphNode('LiveTextDisplay', 'other'), graphNode('FocusedInputTextOutputNode', 'field'), graphNode('Text', 'dom-preview'), graphNode('Text', 'dom-combined')],
    edges: [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'final', 'acc', 'append'), edge('speech', 'provisional', 'acc', 'preview'), edge('acc', 'text', 'dom', 'text'), edge('dom', 'dom', 'live', 'dom'), edge('dom', 'dom', 'other', 'dom'), edge('speech', 'final', 'field', 'text')] };
  graph.nodes.find(n => n.id === 'dom').settings.className = 'custom';
  graph.nodes.find(n => n.id === 'acc').position = { x: 456, y: 789 };
  return graph;
}

for (const mode of ['preview-only', 'independent', 'legacy-imported', 'TranslationCommit']) test(`v12 ${mode} preview is preserved in a reviewed explicit composition`, () => {
  const graph = pairedGraph();
  if (mode === 'preview-only') graph.edges = graph.edges.filter(e => e.to[1] !== 'append');
  if (mode === 'independent') { graph.nodes.push(graphNode('Text', 'independent')); graph.edges.find(e => e.to[1] === 'preview').from = ['independent', 'value']; }
  if (mode === 'legacy-imported') graph.nodes.find(n => n.id === 'acc').legacyDisplay = true;
  if (mode === 'TranslationCommit') { graph.nodes.find(n => n.id === 'speech').type = 'TranslationCommit'; graph.edges = graph.edges.filter(e => e.to[1] !== 'audio'); }
  const raw = structuredClone(graph);
  let draft;
  assert.throws(() => assertGraph(graph), error => { draft = error.recoveryGraph; return !!draft && /No correlation is inferred/.test(error.message); });
  assert.deepEqual(graph, raw);
  const preview = graph.edges.find(e => e.to[1] === 'preview');
  assert.ok(draft.edges.some(e => JSON.stringify(e.from) === JSON.stringify(preview.from) && e.to[0] === 'dom-preview-2'));
  assert.equal(draft.edges.some(e => e.to[1] === 'preview'), false);
  assert.equal(Object.hasOwn(draft.nodes.find(n => n.id === 'acc'), 'legacyDisplay'), false);
  assert.deepEqual(assertGraph(draft), draft);
});

for (const mode of ['TEXT fan-out', 'shared formatter']) test(`v12 ${mode} is blocked with exact original retained instead of silently changing string semantics`, () => {
  const graph = pairedGraph();
  if (mode === 'TEXT fan-out') graph.edges.push(edge('acc', 'text', 'field', 'text'));
  else graph.edges.push(edge('speech', 'final', 'dom', 'text'));
  const raw = JSON.stringify(graph, null, 2), storage = store(); storage.setItem(GRAPH_KEY, raw);
  assert.throws(() => readGraph(storage), error => !error.recoveryGraph && /needs manual repair.*original JSON and all routes are kept/.test(error.message));
  assert.equal(storage.getItem(GRAPH_KEY), raw);
  // Explicit Reset and Save also backs up unsupported compositions verbatim.
  const replacement = pairedGraph(); replacement.edges = replacement.edges.filter(e => e.to[1] !== 'preview');
  saveGraph(storage, replacement); assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), raw);
});

for (const version of [11, 12]) test(`v${version} append-only and explicit DOM compositions retain every node and route`, () => {
  const graph = pairedGraph(); graph.version = version;
  graph.edges = graph.edges.filter(e => e.to[1] !== 'preview');
  graph.nodes.push(graphNode('TextToDOM', 'explicit-preview'), graphNode('DOMCombiner', 'explicit-combined'));
  graph.edges.push(edge('speech', 'provisional', 'explicit-preview', 'text'), edge('explicit-preview', 'dom', 'explicit-combined', 'second'), edge('dom', 'dom', 'explicit-combined', 'first'));
  assert.deepEqual(assertGraph(graph), { ...graph, version: 15 });
});
