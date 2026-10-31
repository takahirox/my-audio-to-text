import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextSlidingWindowNode } from '../web/text-sliding-window-node.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { Pipeline } from '../web/pipeline.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { NODE_TYPES, GRAPH_VERSION, GRAPH_KEY, graphNode, edge, validateGraph, graphWarnings, saveGraph, readGraph } from '../extension/graph.js';

function window(maxChars) {
  const node = new TextSlidingWindowNode(), snapshots = [], controller = new AbortController();
  const context = { signal: controller.signal, emit(port, text) { assert.equal(port, 'text'); snapshots.push(text); } };
  node.start(context);
  if (maxChars !== undefined) node.receive('maxChars', maxChars);
  return { node, snapshots, controller, context };
}

test('contract has only TEXT/NUMBER inputs, one TEXT output, no Settings and optional maxChars', () => {
  const node = new TextSlidingWindowNode(), definition = NODE_TYPES.TextSlidingWindow;
  assert.deepEqual(node.inputs, { text: TEXT, maxChars: NUMBER });
  assert.deepEqual(node.outputs, { text: TEXT });
  assert.deepEqual(definition.inputs, node.inputs);
  assert.deepEqual(definition.outputs, node.outputs);
  assert.deepEqual(definition.optionalInputs, ['maxChars']);
  assert.deepEqual(graphNode('TextSlidingWindow', 'window').settings, {});
  for (const field of ['settings', 'numberSettings', 'textSettings']) assert.equal(definition[field], undefined);
});

test('each text event appends verbatim and emits the full retained snapshot, including duplicates and empty text', () => {
  const { node, snapshots } = window();
  for (const fragment of ['', 'same', 'same', ' ', '\n', '。', 'Next!', '']) node.receive('text', fragment);
  assert.deepEqual(snapshots, ['', 'same', 'samesame', 'samesame ', 'samesame \n', 'samesame \n。', 'samesame \n。Next!', 'samesame \n。Next!']);
  node.stop(); assert.equal(snapshots.length, 8);
});

test('default limit is 1000, and explicit limits may be smaller or larger', () => {
  const { node, snapshots } = window();
  node.receive('text', 'x'.repeat(1200));
  assert.deepEqual(snapshots, ['x'.repeat(1000)]);
  node.receive('maxChars', 2000); node.receive('text', 'x'.repeat(500));
  assert.equal(snapshots.at(-1).length, 1500);
  node.receive('maxChars', 1); node.receive('text', 'z');
  assert.equal(snapshots.at(-1), 'z');
});

for (const [name, maxChars, fragments, expected] of [
  ['English', 20, ['Old sentence. ', 'New sentence. ', 'Tail'], ['Old sentence. ', 'New sentence. ', 'New sentence. Tail']],
  ['Japanese', 7, ['古い文。', '新しい文。', '末尾'], ['古い文。', '新しい文。', '新しい文。末尾']],
  ['English without punctuation', 10, ['alpha bravo charlie'], ['charlie']],
  ['Japanese without punctuation', 5, ['これはテストです'], ['テストです']],
]) test(`${name}: evict whole sentences before whole words`, () => {
  const { node, snapshots } = window(maxChars);
  for (const fragment of fragments) node.receive('text', fragment);
  assert.deepEqual(snapshots, expected);
});

test('oversized newest sentence falls back to whole words before clipping the newest token', () => {
  const { node, snapshots } = window(12);
  node.receive('text', 'Old. alpha bravo charlie delta');
  assert.equal(snapshots.at(-1), 'delta');
  node.receive('maxChars', 4); node.receive('text', ' abcdefgh.');
  assert.equal(snapshots.at(-1), 'fgh.');
});

test('oversized tokens, URLs, whitespace and non-BMP characters stay bounded and preserve code points', () => {
  for (const maxChars of [1, 2, 3, 5, 11]) for (const fragment of ['a'.repeat(4096), 'https://example.com/' + 'x'.repeat(4096), ' '.repeat(100), '😀'.repeat(100), 'a😀b', '😀日本語😀']) {
    const { node, snapshots } = window(maxChars);
    node.receive('text', fragment); node.receive('text', fragment);
    for (const text of snapshots) {
      assert.ok(text.length <= maxChars);
      assert.ok(text.isWellFormed());
      assert.ok(fragment.repeat(2).endsWith(text));
    }
  }
  const { node, snapshots } = window(1);
  node.receive('text', '😀');
  assert.deepEqual(snapshots, ['']); // No complete code point fits in one code unit.
});

test('missing Intl.Segmenter uses punctuation/whitespace boundaries and safe suffix clipping', () => {
  const original = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    for (const [maxChars, input, expected] of [[12, 'Old. New. Tail', 'New. Tail'], [7, '古い文。新しい文。末尾', '新しい文。末尾'], [10, 'alpha bravo charlie', 'charlie'], [3, '日本語😀', '語😀']]) {
      const { node, snapshots } = window(maxChars);
      node.receive('text', input); assert.deepEqual(snapshots, [expected]);
    }
  } finally { Intl.Segmenter = original; }
});

test('limit-only changes trim silently; growing never restores evicted history', () => {
  const { node, snapshots } = window();
  node.receive('text', 'Old. New. Tail');
  node.receive('maxChars', 9); assert.equal(snapshots.length, 1);
  assert.equal(node.buffer, 'New. Tail');
  node.receive('maxChars', 100); node.receive('text', '');
  assert.deepEqual(snapshots, ['Old. New. Tail', 'New. Tail']);
  node.receive('maxChars', 4); node.receive('text', '!');
  assert.equal(snapshots.at(-1), 'ail!');
});

test('invalid limits and text are rejected explicitly without changing the active bound or buffer', () => {
  const { node, snapshots, context } = window(10);
  node.receive('text', 'keep');
  for (const value of [0, -1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '5', '', null, undefined]) {
    assert.throws(() => node.receive('maxChars', value), /positive safe integer/);
    assert.throws(() => node.receiveInputs({ text: 'bad', maxChars: value }, context), /positive safe integer/);
    assert.equal(node.maxChars, 10); assert.equal(node.buffer, 'keep');
  }
  for (const value of [null, undefined, 5, {}]) assert.throws(() => node.receive('text', value), /expects text: TEXT/);
  assert.throws(() => node.receive('unknown', ''), /expects text: TEXT/);
  assert.deepEqual(snapshots, ['keep']);
});

for (const action of ['stop', 'cancel', 'dispose', 'abort']) test(`${action} clears history and rejects late inputs; Start resets the limit and emits nothing`, () => {
  const { node, snapshots, controller, context } = window(4);
  node.receive('text', 'keep');
  if (action === 'abort') controller.abort(); else node[action]();
  node.receive('text', 'late', context); node.receive('maxChars', 1, context);
  assert.equal(node.buffer, ''); assert.deepEqual(snapshots, ['keep']);
  node.start({ ...context, signal: new AbortController().signal });
  assert.equal(node.maxChars, 1000); assert.deepEqual(snapshots, ['keep']);
  node.receive('text', 'fresh'); assert.deepEqual(snapshots, ['keep', 'fresh']);
});

test('pipeline applies grouped limits before text in either key order and preserves independent arrival order', async () => {
  for (const reverse of [false, true]) {
    const snapshots = [], original = [];
    let source;
    const pipeline = new Pipeline({ nodes: {
      source: { outputs: { text: TEXT, limit: NUMBER }, start(context) { source = context; } },
      window: new TextSlidingWindowNode(),
      sink: { inputs: { text: TEXT }, receive(_, text) { snapshots.push(text); } },
      original: { inputs: { text: TEXT }, receive(_, text) { original.push(text); } },
    }, connections: [edge('source', 'text', 'window', 'text'), edge('source', 'limit', 'window', 'maxChars'), edge('window', 'text', 'sink', 'text'), edge('source', 'text', 'original', 'text')] });
    await pipeline.start();
    source.emitOutputs(reverse ? { limit: 4, text: 'abcdef' } : { text: 'abcdef', limit: 4 });
    source.emit('text', '!'); source.emit('limit', 2); source.emit('text', ''); source.emit('text', '!');
    await pipeline.stop();
    assert.deepEqual(snapshots, ['cdef', 'def!', 'f!', '!!']);
    assert.deepEqual(original, ['abcdef', '!', '', '!']);
    assert.deepEqual(pipeline.errors, []); await pipeline.dispose();
  }
});

test('saved graphs reload and run with or without maxChars; existing stored content survives', async () => {
  for (const withLimit of [false, true]) {
    const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'source'), graphNode('Number', 'limit'), graphNode('TextSlidingWindow', 'window'), graphNode('FocusedInputTextOutputNode', 'sink')],
      edges: [edge('source', 'value', 'window', 'text'), edge('window', 'text', 'sink', 'text'), ...(withLimit ? [edge('limit', 'value', 'window', 'maxChars')] : [])] };
    graph.nodes[0].settings.value = 'old newest'; graph.nodes[1].settings.value = 6;
    const entries = new Map([['unrelated', 'retained'], ['processing-graph-before-v14', 'original backup']]);
    const storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
    assert.deepEqual(validateGraph(graph), []);
    assert.ok(!graphWarnings(graph).some(warning => warning.includes('window.maxChars')));
    saveGraph(storage, graph); const saved = storage.getItem(GRAPH_KEY);
    const loaded = readGraph(storage); assert.deepEqual(loaded, graph);
    for (let run = 0; run < 2; run++) {
      const { pipeline } = buildGraph(loaded, {}), snapshots = [];
      pipeline.entries.get('sink').node = { inputs: { text: TEXT }, receive(_, text) { snapshots.push(text); } };
      await pipeline.start(); await pipeline.stop(); await pipeline.dispose();
      assert.deepEqual(snapshots, [withLimit ? 'newest' : 'old newest']);
      assert.deepEqual(pipeline.errors, []);
    }
    assert.equal(storage.getItem(GRAPH_KEY), saved);
    assert.equal(storage.getItem('unrelated'), 'retained'); assert.equal(storage.getItem('processing-graph-before-v14'), 'original backup');
  }
});

test('pipeline Cancel discards queued appends and ignores late source events', async () => {
  const node = new TextSlidingWindowNode(), snapshots = [];
  let source;
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(context) { source = context; } }, window: node,
    sink: { inputs: { text: TEXT }, receive(_, text) { snapshots.push(text); } },
  }, connections: [edge('source', 'text', 'window', 'text'), edge('window', 'text', 'sink', 'text')] });
  await pipeline.start(); source.emit('text', 'keep');
  await pipeline.entries.get('window').queue; await pipeline.entries.get('sink').queue;
  source.emit('text', 'queued'); await pipeline.cancel();
  source.emit('text', 'late'); await pipeline.dispose();
  assert.deepEqual(snapshots, ['keep']); assert.equal(node.buffer, '');
  assert.deepEqual(pipeline.errors, []);
});
