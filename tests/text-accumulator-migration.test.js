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
  assert.equal(next.version, 11); assert.deepEqual(graph, original);
  for (const node of original.nodes) assert.deepEqual(next.nodes.find(n => n.id === node.id), node);
  assert.equal(next.nodes.length, original.nodes.length + 6);
  assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(edge('a', 'value', 'mixed-accumulator-2', 'append'))));
  assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(edge('b', 'value', 'mixed-accumulator-2', 'preview'))));
  for (const route of [edge('a', 'value', 'appendonly-accumulator', 'append'), edge('b', 'value', 'snapshot-dom', 'text'), edge('summary', 'summary', 'notes-dom', 'text'),
    edge('a', 'value', 'format', 'input1'), edge('format', 'text', 'field', 'text')]) assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(route)));
  assert.equal(migrateGraph(next), next);
});

test('v9 read retains exact original and all older recovery copies; repeated imports never overwrite backups', () => {
  const storage = store(), raw = JSON.stringify(legacy(), null, 2);
  storage.setItem('processing-graph-before-v9', 'older recovery'); storage.setItem(GRAPH_RECOVERY_KEY, 'earlier v9 recovery'); storage.setItem(GRAPH_KEY, raw);
  const graph = reviewSavedGraph(storage); assert.equal(graph.version, 11);
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
    assert.deepEqual(next.edges.slice(0, 3), [edge('producer', 'final', 'display-accumulator', 'append'), edge('producer', 'provisional', 'display-accumulator', 'preview'), graph.edges[2]]);
  });
}

test('migrated mixed sources preserve independent delivery, duplicates and Stop; snapshots remain direct', async () => {
  const graph = legacy(), displays = {};
  const built = buildGraph(reviewGraph(graph), { onDisplay: (id,text) => displays[id] = domText(text) });
  await built.pipeline.start(); await tick();
  const emit = (id, text) => built.pipeline.entries.get(id).context.emit('value', text);
  emit('b', 'preview'); emit('a', 'same'); emit('a', 'same'); emit('b', 'tail'); await tick();
  assert.equal(displays.mixed, '\nsame\nsame\ntail'); // Text.a's initial empty segment is accepted.
  assert.equal(displays.snapshot, 'tail');
  await built.pipeline.stop(); assert.equal(displays.mixed, '\nsame\nsame'); assert.equal(displays.snapshot, 'tail');
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
    // Completing the draft activates append semantics in the next session.
    migrated.edges.push(edge('snapshot', 'value', 'draft', 'input1'));
    const active = new TabSession(() => {}, { graph: migrated });
    await active.start(); await tick();
    const acc = active.session.pipeline.entries.get('view-accumulator');
    assert.equal(acc.node.committed, 'literal snapshot');
    acc.node.receive('preview', 'uncommitted', acc.context); await tick();
    assert.equal(domText(active.view.displays.view), 'literal snapshot\nuncommitted');
    await active[operation](); await tick();
    assert.equal(domText(active.view.displays.view), 'literal snapshot');
    // Ordinary v10 preview-only accumulators still clear their tail.
    delete migrated.nodes.find(node => node.id === 'view-accumulator').legacyDisplay;
    migrated.edges.pop();
    const preview = new TabSession(() => {}, { graph: migrated });
    await preview.start(); await tick();
    assert.equal(domText(preview.view.displays.view), 'literal snapshot');
    await preview[operation](); await tick();
    assert.equal(domText(preview.view.displays.view), '');
  });
}

test('session Cancel publishes committed snapshots consistently through generic TEXT consumers', async () => {
  const graph = { version: 11, nodes: [graphNode('Text', 'source'), graphNode('TextAccumulator', 'acc'), graphNode('LiveTextDisplay', 'view'), graphNode('TextFormatter', 'formatter'), graphNode('LiveTextDisplay', 'formatted')],
    edges: [edge('source', 'value', 'acc', 'append'), edge('source', 'value', 'acc', 'preview'), edge('acc', 'text', 'view', 'content'), edge('acc', 'text', 'formatter', 'input1'), edge('formatter', 'text', 'formatted', 'content')] };
  const session = new TabSession(() => {}, { graph: addDOMFormatters(graph) }); await session.start(); await tick();
  const acc = session.session.pipeline.entries.get('acc'); acc.node.receive('append', 'keep', acc.context); acc.node.receive('preview', 'discard', acc.context); await tick();
  assert.equal(domText(session.view.displays.view), '\nkeep\ndiscard');
  const canceled = session.cancel(); assert.equal(session.cancel(), canceled);
  await canceled; assert.equal(domText(session.view.displays.view), '\nkeep');
  assert.equal(domText(session.view.displays.formatted), '\nkeep', 'ordinary formatter delivery clears the same preview');
  await session.start(); await tick(); assert.equal(domText(session.view.displays.view), ''); session.cancel();
});
