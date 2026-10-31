import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGraph, defaultGraph, graphNode, edge, migrateGraph, readGraph, saveGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
const store = () => { const values = new Map(); return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) }; };
function legacy(version = 14) {
  const graph = defaultGraph(); graph.version = version;
  const window = graphNode('TextWindow', 'window', 444, 555);
  window.settings = { maxChars: 2000, maxWaitMs: 2500, sentenceBoundary: 'on' };
  graph.nodes.push(window, graphNode('Text', 'window-maxChars'), graphNode('OpusMtEnJa', 'translator'), graphNode('TextWindow', 'inactive'));
  graph.edges.push(edge('speech', 'final', 'window', 'text'), edge('window', 'text', 'translator', 'text'), edge('window', 'provisional', 'translator', 'provisional'));
  return graph;
}

for (const version of [9, 10, 11, 12, 13, 14]) test(`v${version} TextWindow requires review and changes only its thresholds/removed port in the draft`, () => {
  const graph = legacy(version), original = structuredClone(graph); let draft;
  assert.throws(() => migrateGraph(graph), error => {
    draft = error.recoveryGraph;
    assert.match(error.message, /TextWindow graph v15 requires review/);
    assert.match(error.message, /Removed window.provisional → translator.provisional/);
    assert.match(error.message, /without added spaces/);
    return !!draft;
  });
  assert.deepEqual(graph, original); assert.equal(draft.version, 15);
  for (const node of original.nodes) {
    const actual = draft.nodes.find(n => n.id === node.id);
    assert.deepEqual(actual, node.id === 'window' ? { ...node, settings: {} } : node);
  }
  assert.equal(draft.nodes.find(n => n.id === 'window-maxChars-2').settings.value, 2000);
  assert.equal(draft.nodes.find(n => n.id === 'window-maxWaitSeconds').settings.value, 2.5);
  assert.deepEqual(draft.edges, [...original.edges.filter(e => e.from[0] !== 'window' || e.from[1] !== 'provisional'),
    edge('window-maxChars-2', 'value', 'window', 'maxChars'), edge('window-maxWaitSeconds', 'value', 'window', 'maxWaitSeconds')]);
  assert.deepEqual(assertGraph(draft), draft); assert.equal(migrateGraph(draft), draft);
  assert.throws(() => buildGraph(graph), /requires review/);
});

test('saved TextWindow JSON remains byte-for-byte until Save; backups survive collisions, reloads and failed backup writes', () => {
  const storage = store(), raw = JSON.stringify(legacy(), null, 2).replaceAll('\n', '\r\n');
  storage.setItem(GRAPH_KEY, raw); storage.setItem(GRAPH_RECOVERY_KEY, 'earlier recovery'); storage.setItem('processing-graph-before-v12', 'older');
  let draft; assert.throws(() => readGraph(storage), e => { draft = e.recoveryGraph; return !!draft; });
  assert.equal(storage.getItem(GRAPH_KEY), raw);
  const failing = { ...storage, setItem(k, v) { if (k.startsWith(GRAPH_RECOVERY_KEY)) throw Error('Quota'); storage.setItem(k, v); } };
  assert.throws(() => saveGraph(failing, draft), /Quota/); assert.equal(storage.getItem(GRAPH_KEY), raw);
  saveGraph(storage, draft); assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-2`), raw);
  assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), 'earlier recovery'); assert.equal(storage.getItem('processing-graph-before-v12'), 'older');
  assert.deepEqual(readGraph(storage), draft); saveGraph(storage, draft);
  assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-3`), null);
});

test('old default-only and inactive TextWindows also require review; unrelated v14 graphs preserve all fields and routes', () => {
  const graph = defaultGraph(); graph.version = 14;
  assert.deepEqual(assertGraph(graph), { ...graph, version: 15 });
  graph.nodes.push(graphNode('TextWindow', 'draft'));
  assert.throws(() => assertGraph(graph), e => !!e.recoveryGraph && /draft/.test(e.message));
});

test('unsupported legacy values, unknown settings/ports and conflicting input wiring are retained for manual repair', () => {
  for (const change of [
    g => { g.nodes.find(n => n.id === 'window').settings.maxChars = '2000'; },
    g => { g.nodes.find(n => n.id === 'window').settings.maxWaitMs = 0; },
    g => { g.nodes.find(n => n.id === 'window').settings.unrelated = 'keep'; },
    g => { g.edges.push(edge('window', 'unknown', 'translator', 'text')); },
    g => { g.edges.push(edge('window-maxChars', 'value', 'window', 'maxChars')); },
  ]) {
    const graph = legacy(); change(graph); const raw = JSON.stringify(graph), storage = store(); storage.setItem(GRAPH_KEY, raw);
    assert.throws(() => readGraph(storage), e => !e.recoveryGraph); assert.equal(storage.getItem(GRAPH_KEY), raw);
  }
});

test('reviewed threshold Number nodes configure the actual runtime before its text source starts', async () => {
  const graph = legacy(); graph.edges = graph.edges.filter(e => !['window', 'translator'].includes(e.from[0]) && e.to[0] !== 'window');
  graph.nodes = graph.nodes.filter(n => ['window', 'window-maxChars'].includes(n.id));
  graph.edges = [];
  graph.nodes.push(graphNode('Text', 'source'), graphNode('TextToDOM', 'dom'), graphNode('LiveTextDisplay', 'field'));
  graph.nodes.find(n => n.id === 'source').settings.value = 'x'.repeat(2001);
  graph.edges.push(edge('source', 'value', 'window', 'text'), edge('window', 'text', 'dom', 'text'), edge('dom', 'dom', 'field', 'dom'));
  let draft; try { assertGraph(graph); } catch (e) { draft = e.recoveryGraph; }
  const outputs = [], built = buildGraph(draft, { onDisplay: (_, dom) => outputs.push(domText(dom)) });
  // Inspect the actual window output, independently of the field adapter.
  const pipeline = built.pipeline; await pipeline.start(); await new Promise(r => setImmediate(r));
  const node = pipeline.entries.get('window').node;
  assert.equal(node.maxChars, 2000); assert.equal(node.maxWaitSeconds, 2.5); assert.equal(node.pending, 'x');
  await pipeline.stop(); assert.deepEqual(outputs, ['', 'x'.repeat(2000), 'x']); assert.equal(node.pending, ''); await pipeline.dispose();
});
