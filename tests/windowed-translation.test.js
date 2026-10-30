import { addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TextWindowNode, windowSettings } from '../web/text-window-node.js';
import { TranslationCommitNode } from '../web/translation-commit-node.js';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/port-contracts.js';
import { TextAccumulatorNode, LiveTextDisplayNode } from '../web/text-nodes.js';
import { TextToDOMNode, DOMCombinerNode } from '../web/dom-nodes.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { validateGraph, graphNode, edge, readGraph, saveGraph, defaultGraph } from '../extension/graph.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { TabSession } from '../extension/session.js';
import { windowTranscript, closedWindows, windowGraph } from './fixtures/windowed-translation.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function buffer(settings = {}) {
  const node = new TextWindowNode(settings), outputs = [], controller = new AbortController();
  node.start({ signal: controller.signal, emit: (port, text) => outputs.push({ port, text }) });
  return { node, outputs, controller, finals: () => outputs.filter(o => o.port === 'text').map(o => o.text) };
}

test('TextWindow preserves repeats, sentence fragments, whitespace, leftovers and exact UTF-16 bounds', () => {
  const f = buffer();
  for (const text of windowTranscript) f.node.receive('text', text);
  f.node.stop(); f.node.stop();
  assert.deepEqual(f.finals(), closedWindows);
  const g = buffer({ maxChars: 7 });
  g.node.receive('text', '  a😀b😀c\n'.repeat(50)); g.node.stop();
  assert.equal(g.finals().join(''), '  a😀b😀c\n'.repeat(50));
  assert.ok(g.finals().every(s => s.length <= 7 && !/[\uD800-\uDBFF]$/.test(s) && !/^[\uDC00-\uDFFF]/.test(s)));
  const h = buffer({ maxChars: 1000 });
  h.node.receive('text', 'x'.repeat(10001)); h.node.stop();
  assert.deepEqual(h.finals().map(s => s.length), [...Array(10).fill(1000), 1]);
  assert.equal(h.node.pending, '');
});

test('TextWindow punctuation is conservative, optional, and empty/invalid input is defined', () => {
  const f = buffer();
  f.node.receive('text', ''); f.node.receive('text', 'Dr. Smith paid 3.14 dollars. Tail');
  assert.deepEqual(f.finals(), ['Dr. Smith paid 3.14 dollars. ']);
  f.node.receive('text', '\t tail\n'); f.node.stop();
  assert.equal(f.finals()[1], 'Tail\t tail\n');
  assert.throws(() => f.node.receive('text', null), /TEXT/);
  assert.throws(() => f.node.receive('bad', 'x'), /TEXT/);
  assert.throws(() => f.node.receive('text', 'x'.repeat(32769)), /32,768/);
  for (const settings of [{ maxChars: 1 }, { maxChars: 1001 }, { maxWaitMs: 0 }, { maxWaitMs: 30001 }, { maxChars: 2.5 }, { sentenceBoundary: true }]) assert.throws(() => windowSettings(settings));
  const g = buffer({ sentenceBoundary: 'off' }); g.node.receive('text', 'One. Two!'); assert.deepEqual(g.finals(), []); g.node.stop(); assert.deepEqual(g.finals(), ['One. Two!']);
});

test('deadline flushes without another event, is not extended by arrivals, and Cancel clears timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = buffer({ maxWaitMs: 100 });
  f.node.receive('text', 'one'); t.mock.timers.tick(90); f.node.receive('text', 'two');
  t.mock.timers.tick(10); assert.deepEqual(f.finals(), ['one two']);
  t.mock.timers.tick(100); f.node.stop(); assert.deepEqual(f.finals(), ['one two']);
  const g = buffer({ maxWaitMs: 100 }); g.node.receive('text', 'discard'); g.controller.abort(); t.mock.timers.tick(200);
  assert.deepEqual(g.finals(), []); assert.equal(g.node.pending, '');
});

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
async function graph(mode = 'revisable', settings) {
  const f = workers(), displays = [], description = windowGraph(mode);
  if (settings) Object.assign(description.nodes.find(n => n.id === 'window').settings, settings);
  const built = buildGraph(addDOMFormatters(description), { prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory,
    onDisplay: (_, state) => displays.push(domText(state)) });
  await built.pipeline.start(); await built.translations[0].ready;
  return { ...f, ...built, displays, send: text => built.pipeline.entries.get('input').context.emit('value', text), display: () => displays.at(-1), preview: () => built.pipeline.entries.get('display-combined')?.node.snapshots.second?.textContent ?? '', accumulator: built.pipeline.entries.get('display-accumulator').node };
}
async function drain(f) {
  let done = false, failure;
  const stopping = f.pipeline.stop().catch(e => { failure = e; }).finally(() => { done = true; });
  let completed = 0;
  while (!done) { await tick(); while (completed < f.requests.length) f.complete(completed++); }
  await stopping; if (failure) throw failure;
}

for (const mode of ['baseline', 'window', 'revisable']) test(`${mode}: fixed fixture order, repeats, source retention and stop drain`, async () => {
  const f = await graph(mode);
  for (const text of windowTranscript) f.send(text);
  await drain(f);
  const expected = mode === 'baseline' ? windowTranscript : closedWindows;
  assert.deepEqual(f.display(), ([...(mode === 'baseline' ? [''] : []), ...expected.map(s => `訳:${s}`)]).join('\n'));
  assert.equal(f.preview(), '');
  assert.deepEqual(f.requests.slice(mode === 'revisable' ? 1 : 0).map(r => r.text), expected);
  assert.equal(f.requests.length, expected.length + (mode === 'revisable' ? 1 : 0));
  assert.equal(f.pipeline.errors.length, 0); await f.pipeline.dispose();
  assert.ok(f.owned.every(w => w.terminated));
});

test('slow inference coalesces growing snapshots, suppresses stale results and appends closed windows only once', async () => {
  const f = await graph(); f.send('The'); await tick(); assert.equal(f.requests.length, 1);
  for (const text of ['meeting', 'starts', 'at']) f.send(text);
  await tick(); assert.equal(f.requests.length, 1);
  const scheduler = f.translations[0]; assert.equal(scheduler.preview.source, 'The meeting starts at');
  f.complete(0); await tick(); assert.equal(f.preview(), ''); assert.equal(f.requests.length, 2);
  f.complete(1); await tick(); assert.equal(f.preview(), '訳:The meeting starts at');
  f.send('ten.'); await tick(); assert.equal(f.preview(), '');
  f.complete(2); await tick(); assert.deepEqual(f.display(), (['訳:The meeting starts at ten.']).join('\n'));
  // The next equal source is a distinct window; an old duplicate reply cannot
  // satisfy it, even while its own provisional work is running.
  f.send('The meeting starts at'); await tick(); f.send('ten.'); await tick();
  f.complete(2); f.complete(3); await tick(); assert.equal(f.accumulator.count, 1);
  f.complete(4); await f.pipeline.stop();
  assert.deepEqual(f.display(), (['訳:The meeting starts at ten.', '訳:The meeting starts at ten.']).join('\n'));
  await f.pipeline.dispose();
});

for (const when of ['running', 'stopping']) test(`Cancel while ${when} invalidates late preview/final replies and preserves committed items`, async () => {
  const f = await graph(); f.send('First.'); await tick(); f.complete(0); await tick();
  f.send('unfinished'); await tick();
  const stopping = when === 'stopping' ? f.pipeline.stop() : null;
  await tick(); await f.pipeline.dispose(); f.complete(1); await stopping;
  assert.deepEqual(f.display(), (['訳:First.']).join('\n')); assert.equal(f.preview(), '');
  assert.ok(f.owned.every(w => w.terminated)); assert.equal(f.pipeline.entries.get('window').node.timer, null);
});

test('Cancel clears a completed visible preview without committing it', async () => {
  const f = await graph(); f.send('open'); await tick(); f.complete(0); await tick();
  assert.equal(f.preview(), '訳:open'); assert.equal(f.accumulator.committed, '');
  await f.pipeline.dispose(); f.complete(0);
  assert.equal(f.accumulator.text, ''); // Dispose publishes no canceled snapshot.
  assert.equal(f.display(), '訳:open');
});

for (const operation of ['stop', 'cancel']) {
  test(`TranslationCommit input failure clears the composed preview before ${operation} and retains committed history`, async () => {
    const results = [], displays = {}, accumulator = new TextAccumulatorNode();
    const pipeline = new Pipeline({ nodes: {
      input: { outputs: { boundary: TEXT, provisional: TEXT } },
      translator: { inputs: { text: TEXT, provisional: TEXT }, outputs: { source: TEXT, text: TEXT, error: TEXT },
        receive(port, source, context) { results.push(() => context.emitOutputs({ source, text: `訳:${source}`, error: '' })); } },
      commit: new TranslationCommitNode(), accumulator, history: new TextToDOMNode(), preview: new TextToDOMNode(), combined: new DOMCombinerNode(),
      one: new LiveTextDisplayNode(dom => displays.one = domText(dom)), two: new LiveTextDisplayNode(dom => displays.two = domText(dom)),
    }, connections: [
      edge('input', 'boundary', 'commit', 'boundary'), edge('input', 'boundary', 'translator', 'text'), edge('input', 'provisional', 'translator', 'provisional'),
      ...['source', 'text', 'error'].map(port => edge('translator', port, 'commit', port)),
      edge('commit', 'final', 'accumulator', 'append'), edge('accumulator', 'text', 'history', 'text'), edge('commit', 'provisional', 'preview', 'text'),
      edge('history', 'dom', 'combined', 'first'), edge('preview', 'dom', 'combined', 'second'),
      edge('combined', 'dom', 'one', 'dom'), edge('combined', 'dom', 'two', 'dom'),
    ] });
    try {
      await pipeline.start();
      const input = pipeline.entries.get('input').context;
      input.emit('boundary', 'First.'); await tick(); results[0](); await tick();
      input.emit('provisional', 'unfinished'); await tick(); results[1](); await tick();
      assert.deepEqual(displays, { one: '訳:First.訳:unfinished', two: '訳:First.訳:unfinished' });
      input.emit('boundary', 'x'.repeat(1001)); await tick();
      assert.equal(pipeline.entries.get('commit').failed, true);
      assert.equal(pipeline.errors.length, 1); assert.match(pipeline.errors[0].message, /backlog limit/);
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      results[1](); results[2](); await tick();
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      if (operation === 'stop') await assert.rejects(pipeline.stop(), AggregateError);
      else await pipeline.cancel();
      results[1](); results[2](); await tick();
      assert.deepEqual(displays, { one: '訳:First.', two: '訳:First.' });
      assert.equal(accumulator.committed, '訳:First.'); assert.equal(accumulator.count, 1);
    } finally { await pipeline.dispose(); }
  });
}

test('failed previews append nothing; failed closed windows visibly retain source and previous commits', async () => {
  const f = await graph(); f.send('First.'); await tick(); f.complete(0); await tick();
  f.send('unfinished'); await tick(); f.complete(1, true); await tick();
  assert.deepEqual(f.display(), (['訳:First.']).join('\n')); assert.equal(f.preview(), '');
  // Worker failure is terminal for this existing translator. Its final still
  // reports source/error, and is committed as a visible source fallback.
  f.send('tail.'); await f.pipeline.stop();
  assert.deepEqual(f.display(), (['訳:First.', '[Translation failed: controlled failure]\nunfinished tail.']).join('\n'));
  await f.pipeline.dispose();
});

test('large uncommitted input creates bounded finals and one latest preview without exceeding model limit', async () => {
  const f = await graph('revisable', { maxChars: 1000 });
  f.send('x'.repeat(1000 * 12 + 17)); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.translations[0].finals.length, 11);
  assert.equal(f.translations[0].preview.source, 'x'.repeat(17));
  await drain(f); assert.equal(f.accumulator.count, 13);
  assert.ok(f.requests.every(r => r.text.length <= 1000));
  assert.equal(f.display().split('\n').map(s => s.slice(2)).join(''), 'x'.repeat(12017)); await f.pipeline.dispose();
});

test('deadline alone sends the pending batch through the real scheduler path', async () => {
  const f = await graph('window', { maxWaitMs: 10 }); f.send('no punctuation');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.requests.map(r => r.text), ['no punctuation']);
  f.complete(0); await f.pipeline.stop(); assert.deepEqual(f.display(), (['訳:no punctuation']).join('\n'));
  await f.pipeline.dispose();
});

test('long sessions retain no committed source history in the window, scheduler or commit node', async () => {
  const f = await graph();
  for (let i = 0; i < 100; i++) {
    f.send('Again.'); await tick(); f.complete(i); await tick();
    assert.equal(f.pipeline.entries.get('window').node.pending, '');
    assert.equal(f.translations[0].finals.length, 0);
    assert.equal(f.pipeline.entries.get('commit').node.boundaries.length, 0);
  }
  await f.pipeline.stop(); assert.deepEqual(f.display(), (Array(100).fill('訳:Again.')).join('\n')); await f.pipeline.dispose();
});

test('hundreds of growing open snapshots retain one pending preview and eventually one complete final', async () => {
  const f = await graph('revisable', { maxChars: 1000, maxWaitMs: 30000 });
  f.send('a'); await tick();
  for (let i = 1; i < 500; i++) f.send('a');
  await tick(); assert.equal(f.requests.length, 1);
  assert.equal(f.translations[0].preview.source, Array(500).fill('a').join(' '));
  assert.equal(f.translations[0].finals.length, 0);
  const stopping = f.pipeline.stop(); await tick(); f.complete(0); await tick();
  assert.equal(f.preview(), ''); assert.equal(f.requests.length, 2);
  f.complete(1); await stopping;
  assert.deepEqual(f.display(), ([`訳:${Array(500).fill('a').join(' ')}`]).join('\n'));
  await f.pipeline.dispose();
});

for (const reverse of [false, true]) test(`independent concurrent windows survive one branch draining first (reverse order: ${reverse})`, async () => {
  const descriptions = ['a', 'b'].map(suffix => {
    const g = windowGraph('revisable');
    g.nodes.forEach(n => { n.id += suffix; });
    g.edges.forEach(e => { e.from[0] += suffix; e.to[0] += suffix; });
    return g;
  });
  const description = { version: 13, nodes: descriptions.flatMap(g => g.nodes), edges: descriptions.flatMap(g => g.edges) };
  if (reverse) description.nodes.reverse();
  const f = workers(), displays = {};
  const built = buildGraph(addDOMFormatters(description), { prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory, onDisplay: (id, s) => { s = domText(s); displays[id] = s; } });
  await built.pipeline.start(); await Promise.all(built.translations.map(n => n.ready));
  const send = (suffix, s) => built.pipeline.entries.get(`input${suffix}`).context.emit('value', s);
  send('a', 'same'); await tick(); send('b', 'same'); await tick();
  const aDone = built.pipeline.drain(descriptions[0].nodes.map(n => n.id)); await tick();
  f.complete(0); f.complete(1); await tick(); f.complete(2); await aDone;
  assert.deepEqual(displays.displaya, '訳:same');
  assert.deepEqual(displays.displayb, '訳:same');
  send('b', 'tail.'); await tick(); f.complete(3); await built.pipeline.stop();
  assert.deepEqual(displays.displaya, (['訳:same']).join('\n')); assert.deepEqual(displays.displayb, (['訳:same tail.']).join('\n'));
  await built.pipeline.dispose(); assert.ok(f.owned.every(w => w.terminated));
});

test('32-window overload is explicit, bounded and leaves an independent TEXT branch running', async () => {
  const description = windowGraph('revisable');
  description.nodes.push(graphNode('LiveTextDisplay', 'independent')); description.edges.push(edge('input', 'value', 'independent', 'content'));
  const f = workers(), displays = {};
  const built = buildGraph(addDOMFormatters(description), { prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory, onDisplay: (id, s) => { s = domText(s); displays[id] = s; } });
  await built.pipeline.start(); await built.translations[0].ready;
  for (let i = 0; i < 50; i++) built.pipeline.entries.get('input').context.emit('value', 'Wait.');
  await tick(); assert.equal(displays.independent, 'Wait.'); // Independent snapshots replace directly.
  assert.match(built.pipeline.errors.map(e => e.message).join(' '), /backlog limit/);
  assert.ok(built.translations[0].finals.length <= 32);
  assert.ok(built.pipeline.entries.get('commit').node.boundaries.length <= 32);
  await built.pipeline.dispose();
});

test('Live session reports a new buffer failure without canceling peer branches or committed history', async () => {
  const description = windowGraph('revisable');
  description.nodes.push(graphNode('LiveTextDisplay', 'peer')); description.edges.push(edge('input', 'value', 'peer', 'content'));
  const f = workers();
  const session = new TabSession(() => {}, { graph: addDOMFormatters(description), prepareTranslateGemma() {}, translationWorkerFactory: f.workerFactory });
  await session.start(); await session.session.translations[0].ready;
  const send = text => session.session.pipeline.entries.get('input').context.emit('value', text);
  send('First.'); await tick(); f.complete(0); await tick();
  send('x'.repeat(32769)); await tick();
  assert.equal(session.view.state, 'running'); assert.match(session.view.error, /32,768/);
  send('peer continues'); await tick();
  assert.deepEqual(domText(session.view.displays.display), (['訳:First.']).join('\n'));
  assert.equal(domText(session.view.displays.peer), 'peer continues');
  session.cancel(); await tick(); assert.ok(f.owned.every(w => w.terminated));
});

test('graph saves/reloads with no version migration, no new weights, and permits generic correlation routes for runtime validation', () => {
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  for (const mode of ['window', 'revisable']) {
    const g = windowGraph(mode); assert.deepEqual(validateGraph(addDOMFormatters(g)), []); saveGraph(storage, addDOMFormatters(g)); assert.deepEqual(readGraph(storage), g);
    assert.deepEqual(graphModelRequirements(g).map(r => r.id), ['translategemma']);
  }
  const g = windowGraph('revisable'); g.nodes.push(graphNode('TextWindow', 'other'));
  g.edges.find(e => e.to[0] === 'commit' && e.to[1] === 'boundary').from[0] = 'other';
  assert.deepEqual(validateGraph(addDOMFormatters(g)), []);
  g.edges.find(e => e.to[0] === 'commit' && e.to[1] === 'source').from = ['input', 'value'];
  assert.deepEqual(validateGraph(addDOMFormatters(g)), []);
  assert.deepEqual(graphModelRequirements({ nodes: [graphNode('TextWindow', 'w'), graphNode('TranslationCommit', 'c')] }), []);
  assert.equal(defaultGraph().version, 13);
});

test('TranslationCommit rejects independent/malformed results and detects an undrained boundary', () => {
  const node = new TranslationCommitNode(), c = { signal: new AbortController().signal, emit() {}, emitOutputs() {} };
  node.start(c); assert.throws(() => node.receiveInputs({ source: 'x', text: 'y', error: '' }, c), /causal|grouped/);
  node.receiveInputs({ boundary: 'x' }, { ...c, delivery: {} });
  assert.throws(() => node.receiveInputs({ source: 'other', text: 'y', error: '' }, { ...c, cause: {}, groupInputs: ['source', 'text', 'error'] }), /does not match/);
  assert.throws(() => node.stop(), /untranslated/);
});
