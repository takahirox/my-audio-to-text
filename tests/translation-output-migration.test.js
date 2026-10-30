import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_VERSION, GRAPH_KEY, GRAPH_RECOVERY_KEY, defaultGraph, graphNode, edge, readGraph, saveGraph, assertGraph } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';

function store(raw) {
  const values = new Map([[GRAPH_KEY, raw], [GRAPH_RECOVERY_KEY, 'earlier recovery\r\n'], ['processing-graph-before-v12', 'v12 recovery']]);
  return { values, getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'OpusMtEnJa', 'OpusMtJaEn']) {
  for (const version of [10, 11, 12, 13]) test(`${type} v${version}: mixed routes require review, preserve original bytes, and save/reload a deliberate preview repair`, () => {
    const old = defaultGraph({ enabled: true }); old.version = version;
    old.nodes.find(n => n.id === 'translation').type = type;
    old.nodes.push(graphNode('TextFormatter', 'diagnostics'), graphNode('Text', 'parked'));
    old.edges.push(edge('speech', 'provisional', 'translation', 'provisional'), edge('translation', 'error', 'diagnostics', 'input1'));
    const raw = JSON.stringify(old, null, 2).replaceAll('\n', '\r\n'), storage = store(raw);
    let draft;
    assert.throws(() => readGraph(storage), error => {
      assert.match(error.message, /Translation output graph v14 requires review/);
      assert.match(error.message, /provisionalText/); draft = error.recoveryGraph; return !!draft;
    });
    assert.equal(storage.getItem(GRAPH_KEY), raw);
    assert.throws(() => buildGraph(old), /requires review/);
    assert.throws(() => saveGraph(storage, old), /requires review/);
    assert.deepEqual(draft.nodes, old.nodes); assert.deepEqual(draft.edges, old.edges);
    assert.equal(draft.version, GRAPH_VERSION);
    // The user explicitly repairs preview routing in the offered draft.
    draft.nodes.push(graphNode('TextToDOM', 'preview-dom'), graphNode('LiveTextDisplay', 'preview'));
    draft.edges.push(edge('translation', 'provisionalText', 'preview-dom', 'text'), edge('preview-dom', 'dom', 'preview', 'dom'));
    saveGraph(storage, draft); assert.deepEqual(readGraph(storage), draft);
    assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-2`), raw);
    assert.equal(storage.getItem(GRAPH_RECOVERY_KEY), 'earlier recovery\r\n');
    assert.equal(storage.getItem('processing-graph-before-v12'), 'v12 recovery');
    const saved = storage.getItem(GRAPH_KEY); saveGraph(storage, readGraph(storage));
    assert.equal(storage.getItem(GRAPH_KEY), saved); assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-2`), raw);
  });
  test(`${type}: v12 committed-only graph upgrades without route changes; failed backup leaves saved JSON intact`, () => {
    const old = defaultGraph({ enabled: true }); old.version = 12;
    old.nodes.find(n => n.id === 'translation').type = type;
    const raw = JSON.stringify(old), storage = store(raw), write = storage.setItem;
    storage.setItem = () => { throw Error('storage full'); };
    assert.throws(() => readGraph(storage), /storage full/); assert.equal(storage.getItem(GRAPH_KEY), raw);
    storage.setItem = write;
    const upgraded = readGraph(storage);
    assert.deepEqual(upgraded, { ...old, version: GRAPH_VERSION });
    assert.equal(storage.getItem(`${GRAPH_RECOVERY_KEY}-2`), raw);
  });
}

test('v12 mixed graphs with invalid routes require repair without deleting any edge or overwriting storage', () => {
  const old = defaultGraph({ enabled: true }); old.version = 12;
  old.edges.push(edge('speech', 'provisional', 'translation', 'provisional'), edge('translation', 'unknown', 'translated-format', 'input2'));
  const raw = JSON.stringify(old), storage = store(raw);
  assert.throws(() => readGraph(storage), error => !error.recoveryGraph && /Repair required.*Unknown port/.test(error.message));
  assert.equal(storage.getItem(GRAPH_KEY), raw);
});

test('a committed result without a closed boundary cannot become a preview or an implicit commit', async () => {
  const { TranslationCommitNode } = await import('../web/translation-commit-node.js');
  const node = new TranslationCommitNode(), outputs = [];
  const context = { signal: new AbortController().signal, emit() {}, emitOutputs: v => outputs.push(v), cause: {}, groupInputs: ['source', 'text', 'error'] };
  node.start(context);
  assert.throws(() => node.receiveInputs({ source: 'unclosed', text: 'preview', error: '' }, context), /no closed source window/);
  assert.deepEqual(outputs, []); node.dispose();
  assert.equal(assertGraph(defaultGraph()).version, GRAPH_VERSION);
});

test('legacy generic TranslationCommit preview routing requires review even without a provisional translator connection', () => {
  const old = defaultGraph(); old.version = 12;
  old.nodes.push(graphNode('TranslationCommit', 'generic-commit'));
  const raw = JSON.stringify(old), storage = store(raw);
  assert.throws(() => readGraph(storage), error => {
    assert.match(error.message, /requires review for generic-commit/);
    assert.match(error.message, /rejects unclosed results/);
    assert.deepEqual(error.recoveryGraph, { ...old, version: GRAPH_VERSION }); return true;
  });
  assert.equal(storage.getItem(GRAPH_KEY), raw);
});
