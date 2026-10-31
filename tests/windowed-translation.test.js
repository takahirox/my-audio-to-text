import { addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranslationCommitNode } from '../web/translation-commit-node.js';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/port-contracts.js';
import { TextAccumulatorNode, LiveTextDisplayNode } from '../web/text-nodes.js';
import { TextToDOMNode, DOMCombinerNode } from '../web/dom-nodes.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { validateGraph, graphNode, edge, readGraph, saveGraph, defaultGraph, GRAPH_VERSION } from '../extension/graph.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { TabSession } from '../extension/session.js';
import { windowTranscript, closedWindows, windowGraph } from './fixtures/windowed-translation.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function workers() {
  const requests = [], owned = [];
  const workerFactory = () => {
    const w = { postMessage(data) {
      if (data.type === 'translate') requests.push({ ...data, worker: w });
      else queueMicrotask(() => w.onmessage?.({ data: { id: data.id, type: data.type === 'load' ? 'ready' : 'drained' } }));
    }, terminate() { w.terminated = true; } };
    owned.push(w); return w;
  };
  const complete = (i, error = false) => {
    const r = requests[i]; r.worker.onmessage?.({ data: { id: r.id, type: error ? 'error' : 'result', texts: [`訳:${r.text}`], message: 'controlled failure' } });
  };
  return { requests, owned, workerFactory, complete };
}
async function graph(mode = 'revisable', limits = {}) {
  const f = workers(), displays = [], previews = [], description = windowGraph(mode);
  for (const [port, value] of Object.entries(limits)) {
    const id = port === 'maxChars' ? 'window-chars' : 'window-wait';
    description.nodes.find(n => n.id === id).settings.value = value;
  }
  const preview = graphNode('Text', 'preview-input'); description.nodes.push(preview);
  description.edges.push(edge(preview.id, 'value', 'translator', 'provisional'));
  const built = buildGraph(addDOMFormatters(description), { prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory,
    onDisplay: (id, state) => { if (id === 'display') displays.push(domText(state)); else previews.push(domText(state)); } });
  await built.pipeline.start(); await built.translations[0].ready;
  return { ...f, ...built, displays, previews, preview: () => previews.at(-1) ?? '',
    send: text => built.pipeline.entries.get('input').context.emit('value', text),
    sendPreview: text => built.pipeline.entries.get('preview-input').context.emit('value', text),
    display: () => displays.at(-1), accumulator: built.pipeline.entries.get('display-accumulator').node };
}
async function drain(f) {
  let done = false, failure;
  const stopping = f.pipeline.stop().catch(e => { failure = e; }).finally(() => { done = true; });
  let completed = 0;
  while (!done) { await tick(); while (completed < f.requests.length) f.complete(completed++); }
  await stopping; if (failure) throw failure;
}

for (const mode of ['baseline', 'window', 'revisable']) test(`${mode}: exact fixture order, source retention and Stop drain`, async () => {
  const f = await graph(mode);
  for (const text of windowTranscript) f.send(text);
  await drain(f);
  const expected = mode === 'baseline' ? windowTranscript : closedWindows;
  assert.equal(f.display(), [...(mode === 'baseline' ? [''] : []), ...expected.map(s => `訳:${s}`)].join('\n'));
  assert.deepEqual(f.requests.map(r => r.text), expected); assert.equal(f.preview(), '');
  assert.equal(f.pipeline.errors.length, 0); await f.pipeline.dispose();
  assert.ok(f.owned.every(w => w.terminated));
});

test('explicit preview source coalesces snapshots independently of exact committed windows', async () => {
  const f = await graph('revisable', { maxChars: 6 });
  f.sendPreview('First'); await tick();
  f.sendPreview('First growing'); f.sendPreview('latest'); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.translations[0].preview.source, 'latest');
  f.complete(0); await tick(); assert.equal(f.preview(), ''); f.complete(1); await tick();
  assert.equal(f.preview(), '訳:latest');
  f.send('First.'); await tick(); assert.equal(f.preview(), ''); f.complete(2); await tick();
  f.send('First.'); await tick(); f.complete(2); await tick(); assert.equal(f.accumulator.count, 1);
  f.complete(3); await f.pipeline.stop(); assert.equal(f.display(), '訳:First.\n訳:First.'); await f.pipeline.dispose();
});

for (const when of ['running', 'stopping']) test(`Cancel while ${when} suppresses late replies and discards the pending window`, async () => {
  const f = await graph('revisable', { maxChars: 6 });
  f.send('First.'); await tick(); f.complete(0); await tick();
  f.send('tail'); await tick();
  const stopping = when === 'stopping' ? f.pipeline.stop() : null;
  await tick(); await f.pipeline.dispose(); if (f.requests[1]) f.complete(1); await stopping;
  assert.equal(f.display(), '訳:First.'); assert.equal(f.preview(), '');
  assert.ok(f.owned.every(w => w.terminated)); assert.equal(f.pipeline.entries.get('window').node.timer, null);
});

for (const operation of ['stop', 'cancel']) {
  test(`TranslationCommit input failure emits its compatibility clear before ${operation} and retains committed history`, async () => {
    const results = [], clears = [], displays = {}, accumulator = new TextAccumulatorNode();
    const pipeline = new Pipeline({ nodes: {
      input: { outputs: { boundary: TEXT, provisional: TEXT } },
      translator: { inputs: { text: TEXT, provisional: TEXT }, outputs: { source: TEXT, text: TEXT, error: TEXT, provisionalText: TEXT },
        receive(port, source, context) { results.push(() => context.emitOutputs(port === 'provisional' ? { provisionalText: `訳:${source}` } : { source, text: `訳:${source}`, error: '' })); } },
      commit: new TranslationCommitNode(), clears: { inputs: { text: TEXT }, receive(_, value) { clears.push(value); } }, accumulator, history: new TextToDOMNode(), preview: new TextToDOMNode(), combined: new DOMCombinerNode(),
      one: new LiveTextDisplayNode(dom => displays.one = domText(dom)), two: new LiveTextDisplayNode(dom => displays.two = domText(dom)),
    }, connections: [
      edge('input', 'boundary', 'commit', 'boundary'), edge('input', 'boundary', 'translator', 'text'), edge('input', 'provisional', 'translator', 'provisional'),
      ...['source', 'text', 'error'].map(port => edge('translator', port, 'commit', port)),
      edge('commit', 'final', 'accumulator', 'append'), edge('accumulator', 'text', 'history', 'text'), edge('commit', 'provisional', 'preview', 'text'), edge('commit', 'provisional', 'clears', 'text'),
      edge('history', 'dom', 'combined', 'first'), edge('preview', 'dom', 'combined', 'second'),
      edge('combined', 'dom', 'one', 'dom'), edge('combined', 'dom', 'two', 'dom'),
    ] });
    try {
      await pipeline.start();
      const input = pipeline.entries.get('input').context;
      input.emit('boundary', 'First.'); await tick(); results[0](); await tick();
      const clearCount = clears.length;
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      input.emit('boundary', 'x'.repeat(1001)); await tick();
      assert.equal(pipeline.entries.get('commit').failed, true);
      assert.equal(pipeline.errors.length, 1); assert.match(pipeline.errors[0].message, /backlog limit/);
      assert.equal(clears.length, clearCount + 1); assert.equal(clears.at(-1), '');
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      results[0](); results[1](); await tick();
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      if (operation === 'stop') await assert.rejects(pipeline.stop(), AggregateError);
      else await pipeline.cancel();
      results[0](); results[1](); await tick();
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      assert.equal(accumulator.committed, '訳:First.'); assert.equal(accumulator.count, 1);
    } finally { await pipeline.dispose(); }
  });
}

test('failed explicit previews append nothing; failed closed windows retain source and previous commits', async () => {
  const f = await graph('revisable', { maxChars: 6 });
  f.send('First.'); await tick(); f.complete(0); await tick();
  f.pipeline.entries.get('window-chars').context.emit('value', 1000);
  f.send('unfinished '); f.sendPreview('unfinished'); await tick(); f.complete(1, true); await tick();
  assert.equal(f.display(), '訳:First.'); assert.equal(f.preview(), '');
  f.send('tail.'); await f.pipeline.stop();
  assert.equal(f.display(), '訳:First.\n[Translation failed: controlled failure]\nunfinished tail.'); await f.pipeline.dispose();
});

test('bare dispose retains an explicit preview snapshot without committing pending text', async () => {
  const f = await graph(); f.send('open'); f.sendPreview('open'); await tick(); f.complete(0); await tick();
  assert.equal(f.preview(), '訳:open'); assert.equal(f.accumulator.committed, '');
  await f.pipeline.dispose(); f.complete(0); assert.equal(f.accumulator.text, ''); assert.equal(f.preview(), '訳:open');
});

test('Live reports a buffer failure while independent TEXT delivery continues', async () => {
  const description = windowGraph('revisable'); description.nodes.find(n => n.id === 'window-chars').settings.value = 6;
  description.nodes.push(graphNode('LiveTextDisplay', 'peer')); description.edges.push(edge('input', 'value', 'peer', 'content'));
  const f = workers();
  const session = new TabSession(() => {}, { graph: addDOMFormatters(description), prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory });
  await session.start(); await session.session.translations[0].ready;
  const send = text => session.session.pipeline.entries.get('input').context.emit('value', text);
  send('First.'); await tick(); f.complete(0); await tick(); send('x'.repeat(32769)); await tick();
  assert.equal(session.view.state, 'running'); assert.match(session.view.error, /32,768/);
  send('peer continues'); await tick(); assert.equal(domText(session.view.displays.display), '訳:First.'); assert.equal(domText(session.view.displays.peer), 'peer continues');
  await session.cancel(); assert.ok(f.owned.every(w => w.terminated));
});

test('large input creates bounded finals with an exact remainder and no implicit previews', async () => {
  const f = await graph('revisable', { maxChars: 1000 });
  f.send('x'.repeat(12017)); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.translations[0].finals.length, 11);
  assert.equal(f.translations[0].preview, null); assert.equal(f.pipeline.entries.get('window').node.pending.length, 17);
  await drain(f); assert.equal(f.accumulator.count, 13);
  assert.ok(f.requests.every(r => r.text.length <= 1000));
  assert.equal(f.display().split('\n').map(s => s.slice(2)).join(''), 'x'.repeat(12017)); await f.pipeline.dispose();
});

test('NUMBER wait input alone flushes pending text through the real scheduler', async () => {
  const f = await graph('window', { maxWaitSeconds: 0.01 }); f.send('no punctuation');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(f.requests.map(r => r.text), ['no punctuation']);
  f.complete(0); await f.pipeline.stop(); assert.equal(f.display(), '訳:no punctuation'); await f.pipeline.dispose();
});

test('long sessions remove committed text from window, scheduler and commit buffers', async () => {
  const f = await graph('revisable', { maxChars: 6 });
  for (let i = 0; i < 100; i++) {
    f.send('Again.'); await tick(); f.complete(i); await tick();
    assert.equal(f.pipeline.entries.get('window').node.pending, '');
    assert.equal(f.translations[0].finals.length, 0); assert.equal(f.pipeline.entries.get('commit').node.boundaries.length, 0);
  }
  await f.pipeline.stop(); assert.equal(f.display(), Array(100).fill('訳:Again.').join('\n')); await f.pipeline.dispose();
});

for (const reverse of [false, true]) test(`independent windows drain separately (reverse order: ${reverse})`, async () => {
  const descriptions = ['a', 'b'].map(suffix => {
    const g = windowGraph('revisable');
    g.nodes.forEach(n => { n.id += suffix; }); g.edges.forEach(e => { e.from[0] += suffix; e.to[0] += suffix; }); return g;
  });
  const description = { version: GRAPH_VERSION, nodes: descriptions.flatMap(g => g.nodes), edges: descriptions.flatMap(g => g.edges) };
  if (reverse) description.nodes.reverse();
  const f = workers(), displays = {};
  const built = buildGraph(addDOMFormatters(description), { prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory, onDisplay: (id, s) => displays[id] = domText(s) });
  await built.pipeline.start(); await Promise.all(built.translations.map(n => n.ready));
  const send = (suffix, s) => built.pipeline.entries.get(`input${suffix}`).context.emit('value', s);
  send('a', 'same'); send('b', 'same'); await tick(); assert.equal(f.requests.length, 0);
  const aDone = built.pipeline.drain(descriptions[0].nodes.map(n => n.id)); await tick(); f.complete(0); await aDone;
  assert.equal(displays.displaya, '訳:same'); assert.equal(displays.displayb, '');
  send('b', 'tail.'); await tick(); const stopping = built.pipeline.stop(); await tick(); f.complete(1); await stopping;
  assert.equal(displays.displaya, '訳:same'); assert.equal(displays.displayb, '訳:sametail.');
  await built.pipeline.dispose(); assert.ok(f.owned.every(w => w.terminated));
});

test('32-window overload is visible and leaves an independent TEXT branch running', async () => {
  const description = windowGraph('revisable'); description.nodes.find(n => n.id === 'window-chars').settings.value = 5;
  description.nodes.push(graphNode('LiveTextDisplay', 'independent')); description.edges.push(edge('input', 'value', 'independent', 'content'));
  const f = workers(), displays = {};
  const built = buildGraph(addDOMFormatters(description), { prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory, onDisplay: (id, s) => displays[id] = domText(s) });
  await built.pipeline.start(); await built.translations[0].ready;
  for (let i = 0; i < 50; i++) built.pipeline.entries.get('input').context.emit('value', 'Wait.');
  await tick(); assert.equal(displays.independent, 'Wait.');
  assert.match(built.pipeline.errors.map(e => e.message).join(' '), /backlog limit/);
  assert.ok(built.translations[0].finals.length <= 32); assert.ok(built.pipeline.entries.get('commit').node.boundaries.length <= 32); await built.pipeline.dispose();
});

test('graphs save/reload with explicit NUMBER wiring, no new weights and generic commit validation', () => {
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  for (const mode of ['window', 'revisable']) {
    const g = windowGraph(mode); assert.deepEqual(validateGraph(addDOMFormatters(g)), []);
    saveGraph(storage, g); assert.deepEqual(readGraph(storage), g);
    assert.deepEqual(graphModelRequirements(g).map(r => r.id), ['translategemma']);
    assert.ok(!g.edges.some(e => e.from[0] === 'window' && e.from[1] === 'provisional'));
  }
  const g = windowGraph('revisable'); g.nodes.push(graphNode('TextWindow', 'other'));
  g.edges.find(e => e.to[0] === 'commit' && e.to[1] === 'boundary').from[0] = 'other'; assert.deepEqual(validateGraph(addDOMFormatters(g)), []);
  assert.deepEqual(graphModelRequirements({ nodes: [graphNode('TextWindow', 'w'), graphNode('TranslationCommit', 'c')] }), []);
  assert.equal(defaultGraph().version, GRAPH_VERSION);
});

test('TranslationCommit rejects independent/malformed results and detects an undrained boundary', () => {
  const node = new TranslationCommitNode(), c = { signal: new AbortController().signal, emit() {}, emitOutputs() {} };
  node.start(c); assert.throws(() => node.receiveInputs({ source: 'x', text: 'y', error: '' }, c), /causal|grouped/);
  node.receiveInputs({ boundary: 'x' }, { ...c, delivery: {} });
  assert.throws(() => node.receiveInputs({ source: 'other', text: 'y', error: '' }, { ...c, cause: {}, groupInputs: ['source', 'text', 'error'] }), /does not match/);
  assert.throws(() => node.stop(), /untranslated/);
});
