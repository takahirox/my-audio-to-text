import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pipeline } from '../web/pipeline.js';
import { ButtonNode, buttonLabel } from '../web/button-node.js';
import { HoldNode } from '../web/hold-node.js';
import { ANY, TEXT, NUMBER, ITEM, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST, compatiblePorts } from '../web/port-contracts.js';
import { MONO_16KHZ_PCM } from '../web/transcription-nodes.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { AUDIO_STREAM } from '../web/audio-stream.js';
import { graphNode, edge, validateGraph, executableGraph, nodeDefinition, GRAPH_VERSION, saveGraph, readGraph, INPUT_TYPES } from '../extension/graph.js';
import { TabSession } from '../extension/session.js';
import { domText } from './fixtures/dom.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(triggerContract = NUMBER) {
  const seen = [], peer = [], states = [];
  const source = { outputs: { text: TEXT, trigger: triggerContract }, start(c) { this.context = c; } };
  const hold = new HoldNode({ onState: state => states.push(state) });
  const pipeline = new Pipeline({ nodes: { source, hold,
    sink: { inputs: { text: TEXT }, receive(_, text) { seen.push(text); } },
    peer: { inputs: { text: TEXT }, receive(_, text) { peer.push(text); } },
  }, connections: [edge('source', 'text', 'hold', 'input'), edge('source', 'trigger', 'hold', 'trigger'),
    edge('hold', 'value', 'sink', 'text'), edge('hold', 'value', 'peer', 'text')] });
  return { pipeline, source, hold, seen, peer, states };
}

test('ANY is sink-only and accepts every existing concrete output without broadening ITEM or strict inputs', () => {
  for (const contract of [TEXT, NUMBER, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST, MONO_16KHZ_PCM, SYNTHESIZED_AUDIO, AUDIO_STREAM]) {
    assert.ok(compatiblePorts(contract, ANY));
    assert.equal(compatiblePorts(ANY, contract), false);
  }
  assert.equal(compatiblePorts(ANY, ANY), false);
  assert.equal(compatiblePorts(NUMBER, ITEM), false);
  assert.equal(compatiblePorts(NUMBER, TEXT), false);
  assert.throws(() => new Pipeline({ nodes: { bad: { outputs: { event: ANY } } } }), /input-only/);
  for (const contract of [TEXT, NUMBER]) {
    const g = { version: GRAPH_VERSION, nodes: [graphNode(contract === TEXT ? 'Text' : 'Number', 'source'), graphNode('Hold', 'hold'), graphNode('Display', 'sink')], edges: [edge('source', 'value', 'hold', 'trigger'), edge('hold', 'value', 'sink', 'input1')] };
    assert.deepEqual(validateGraph(g), []);
    g.edges[0].to[1] = 'input';
    assert.equal(validateGraph(g).length > 0, contract === NUMBER);
  }
});

for (const contract of [TEXT, NUMBER]) test(`trigger accepts repeated, falsy ${contract.name} deliveries; updates are silent; no initial value and explicit empty text differ`, async () => {
  const f = fixture(contract); await f.pipeline.start();
  assert.deepEqual(Object.keys(f.hold.outputs), ['value']);
  assert.equal(f.pipeline.entries.get('sink').samples.length, 0);
  assert.equal(f.pipeline.entries.get('hold').sampledOutputs.size, 0);
  assert.match(f.states[0], /Waiting/);
  const marker = contract === TEXT ? '' : 0;
  f.source.context.emit('trigger', marker); await tick(); assert.deepEqual(f.seen, []);
  f.source.context.emit('text', 'A'); f.source.context.emit('text', 'B'); await tick(); assert.deepEqual(f.seen, []);
  f.source.context.emit('trigger', marker); f.source.context.emit('trigger', marker);
  f.source.context.emit('text', 'C'); f.source.context.emit('trigger', marker);
  f.source.context.emit('text', ''); f.source.context.emit('trigger', marker);
  await f.pipeline.stop();
  assert.deepEqual(f.seen, ['B', 'B', 'C', '']); assert.deepEqual(f.peer, f.seen);
  await f.pipeline.dispose(); assert.equal(f.hold.hasValue, false);
});

test('atomic groups store new input first, emit exactly once, and omitted group siblings do not fire', async () => {
  const f = fixture(TEXT); await f.pipeline.start();
  f.source.context.emitOutputs({ trigger: '', text: 'atomic' });
  f.source.context.emitOutputs({ text: 'silent' });
  f.source.context.emitOutputs({ trigger: 'ignored payload' });
  await f.pipeline.stop(); assert.deepEqual(f.seen, ['atomic', 'silent']); await f.pipeline.dispose();
});

test('arrival-only routes do not copy or inspect a large structured trigger payload; typed sibling fan-out still validates', async () => {
  const f = fixture(KEYED_PAIRED_TEXT); await f.pipeline.start();
  const payload = { get id() { throw Error('must not inspect'); } };
  f.source.context.emit('text', 'snapshot'); f.source.context.emit('trigger', payload);
  await f.pipeline.stop(); assert.deepEqual(f.seen, ['snapshot']); assert.deepEqual(f.pipeline.errors, []); await f.pipeline.dispose();
  const source = { outputs: { pair: KEYED_PAIRED_TEXT }, start(c) { this.context = c; } };
  const p = new Pipeline({ nodes: { source, hold: new HoldNode(), typed: { inputs: { pair: ITEM }, receive() {} } },
    connections: [edge('source', 'pair', 'hold', 'trigger'), edge('source', 'pair', 'typed', 'pair')] });
  await p.start(); source.context.emit('pair', payload); assert.match(p.errors[0].message, /KEYED_PAIRED_TEXT/); await p.dispose();
});

test('saved trigger connection determines cycle validation, executable selection and runtime mode for each Hold independently', () => {
  const nodes = ['Text', 'Hold', 'TextFormatter', 'Button', 'Hold', 'Display'].map((type, i) => graphNode(type, 'n' + i));
  const g = { version: GRAPH_VERSION, nodes, edges: [edge('n0', 'value', 'n2', 'input2'), edge('n1', 'value', 'n2', 'input1'), edge('n2', 'text', 'n1', 'input'), edge('n2', 'text', 'n4', 'input'), edge('n3', 'trigger', 'n4', 'trigger'), edge('n4', 'value', 'n5', 'input1')] };
  assert.deepEqual(validateGraph(g), []); assert.equal(executableGraph(g).nodes.length, 6);
  assert.deepEqual(nodeDefinition(nodes[1], g).sampledOutputs, ['value']); assert.deepEqual(nodeDefinition(nodes[4], g).sampledOutputs, []);
  g.edges.push(edge('n3', 'trigger', 'n1', 'trigger')); assert.match(validateGraph(g).join(' '), /acyclic/);
  assert.throws(() => new Pipeline({ nodes: { hold: new HoldNode(), button: new ButtonNode(), relay: { inputs: { text: TEXT }, outputs: { text: TEXT }, receive() {} } }, connections: [edge('button', 'trigger', 'hold', 'trigger'), edge('hold', 'value', 'relay', 'text'), edge('relay', 'text', 'hold', 'input')] }), /acyclic/);
});

test('an incomplete saved trigger branch cannot silently convert an event Hold to sampled mode', () => {
  const g = { version: GRAPH_VERSION, nodes: ['Text', 'Hold', 'TextSummaryLfm2', 'Display'].map((type, i) => graphNode(type, 'n' + i)), edges: [edge('n0', 'value', 'n1', 'input'), edge('n2', 'summary', 'n1', 'trigger'), edge('n1', 'value', 'n3', 'input1'), edge('n0', 'value', 'n3', 'input2')] };
  g.nodes[3].settings.inputCount = 2;
  assert.deepEqual(validateGraph(g), []);
  assert.deepEqual(executableGraph(g).nodes.map(n => n.id), ['n0', 'n3']);
});

test('a sampled value connected to ANY cannot synthesize a trigger during an input-only update', async () => {
  const seen = [], source = { outputs: { text: TEXT }, start(context) { this.context = context; } };
  const p = new Pipeline({ nodes: { source, sampled: new HoldNode(), emitted: new HoldNode(),
    sink: { inputs: { text: TEXT }, receive(_, text) { seen.push(text); } } }, connections: [
    edge('source', 'text', 'emitted', 'input'), edge('sampled', 'value', 'emitted', 'trigger'), edge('emitted', 'value', 'sink', 'text')] });
  await p.start(); source.context.emit('text', 'silent'); await p.stop();
  assert.deepEqual(seen, []); assert.equal(p.entries.get('emitted').samples.length, 0);
  assert.deepEqual(p.errors, []); await p.dispose();
});

test('Button emits the NUMBER marker once per press, including identical consecutive presses; closed contexts cannot emit', async () => {
  const button = new ButtonNode(), seen = [];
  assert.equal(button.press(), false);
  const p = new Pipeline({ nodes: { button, sink: { inputs: { number: NUMBER }, receive(_, number) { seen.push(number); } } }, connections: [edge('button', 'trigger', 'sink', 'number')] });
  await p.start(); assert.equal(button.press(), true); assert.equal(button.press(), true); await p.stop();
  assert.equal(button.press(), false); assert.deepEqual(seen, [1, 1]); await p.dispose(); assert.equal(button.press(), false);
});

test('Button labels persist by ID, allow a blank fallback, and reject overlong or non-text settings', () => {
  const g = { version: GRAPH_VERSION, nodes: [graphNode('Button', 'b'), graphNode('Button', 'a')], edges: [] };
  assert.equal(INPUT_TYPES.includes('Button'), false);
  g.nodes.forEach(n => { n.settings.label = 'Generate summary'; });
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  saveGraph(storage, g); assert.deepEqual(readGraph(storage), g);
  g.nodes[0].settings.label = ' '; assert.deepEqual(validateGraph(g), []); assert.equal(buttonLabel(' '), 'Run action');
  for (const label of [42, 'x'.repeat(121)]) { g.nodes[0].settings.label = label; assert.match(validateGraph(g).join(' '), /label/); }
});

function manualGraph() {
  const g = { version: GRAPH_VERSION, nodes: ['Text', 'Hold', 'Button', 'Button', 'TextSummaryLfm2', 'Display'].map((type, i) => graphNode(type, ['input', 'held', 'z', 'a', 'summary', 'view'][i])), edges: [edge('input', 'value', 'held', 'input'), edge('z', 'trigger', 'held', 'trigger'), edge('held', 'value', 'summary', 'text'), edge('summary', 'summary', 'view', 'input2'), edge('input', 'value', 'view', 'input1'), edge('a', 'trigger', 'other', 'trigger'), edge('otherText', 'value', 'other', 'input'), edge('other', 'value', 'otherView', 'input1')] };
  g.nodes[0].settings.value = 'A'; g.nodes[5].settings.inputCount = 2;
  g.nodes.push(graphNode('Hold', 'other'), graphNode('Text', 'otherText'), graphNode('Display', 'otherView'), graphNode('Button', 'parked'));
  g.nodes.find(n => n.id === 'otherText').settings.value = 'independent';
  for (const n of g.nodes.filter(n => n.type === 'Button')) n.settings.label = 'Same caption';
  return g;
}
function sessionFixture({ holdLoad = false, failLoad = false } = {}) {
  const workers = [], states = [];
  const session = new TabSession(view => states.push(view), { graph: manualGraph(), textSummaryWorkerFactory: () => {
    const worker = { messages: [], postMessage(data) {
      this.messages.push(data);
      if (data.type === 'load' && !holdLoad) queueMicrotask(() => this.reply(data.id, failLoad ? 'error' : 'ready', { message: 'Missing prepared model' }));
    }, reply(id, type, fields = {}) { this.onmessage?.({ data: { id, type, ...fields } }); }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  } });
  return { session, workers, states, request: () => workers.at(-1)?.messages.at(-1), complete: (summary = 'result') => { const worker = workers.at(-1); worker.reply(worker.messages.at(-1).id, 'result', { summary }); } };
}

test('manual actions: no audio permission or eager model load; duplicate captions, fan-out, FIFO snapshot, busy and Stop draining', async () => {
  const f = sessionFixture(), s = f.session;
  assert.deepEqual(s.view.graphActions.map(a => a.id), ['a', 'z']); assert.ok(s.view.graphActions.every(a => a.disabled));
  assert.equal(await s.pressButton('z'), false);
  const beforeStart = s.view.graphActions.find(a => a.id === 'z').invoke;
  const starting = s.start();
  assert.equal(await s.pressButton('z'), false, 'no dispatch during loading');
  await starting; await tick(); const p = s.session.pipeline;
  assert.equal(await beforeStart(), false, 'idle handlers cannot acquire a later session');
  assert.deepEqual(f.workers, []); assert.equal(domText(s.view.displays.view.input1), 'A'); assert.equal(domText(s.view.displays.view.input2), '');
  const z = s.view.graphActions.find(a => a.id === 'z'); const work = z.invoke();
  assert.equal(await z.invoke(), false); assert.equal(s.view.graphActions.find(a => a.id === 'z').disabled, true);
  // A disjoint action with the same caption remains usable.
  assert.equal(await s.view.graphActions.find(a => a.id === 'a').invoke(), true);
  assert.equal(domText(s.view.displays.otherView.input1), 'independent');
  await tick(); assert.equal(f.request().text, 'A');
  p.entries.get('input').context.emit('value', 'B'); await tick();
  assert.equal(domText(s.view.displays.view.input1), 'B'); assert.equal(f.request().text, 'A');
  f.complete('S1'); assert.equal(await work, true);
  const next = s.view.graphActions.find(a => a.id === 'z').invoke(); await tick(); assert.equal(f.request().text, 'B');
  const stopped = s.stop(); assert.equal(await s.pressButton('z'), false); assert.equal(s.view.state, 'stopping');
  f.complete('S2'); await next; await stopped;
  assert.equal(domText(s.view.displays.view.input2), 'S2'); assert.ok(f.workers[0].terminated);
  assert.equal(f.workers[0].messages.filter(m => m.type === 'summarize').length, 2);
});

for (const phase of ['loading', 'generating']) test(`Cancel during lazy ${phase}, stale callbacks and restart never target replacement contexts`, async () => {
  const f = sessionFixture({ holdLoad: phase === 'loading' }), s = f.session;
  await s.start(); const stale = s.view.graphActions.find(a => a.id === 'z').invoke;
  const work = stale(); await tick(); const worker = f.workers[0], late = worker.onmessage, id = f.request().id;
  await s.cancel(); await work; assert.ok(worker.terminated);
  late({ data: { id, type: phase === 'loading' ? 'ready' : 'result', summary: 'late' } });
  await s.start(); await tick(); assert.equal(await stale(), false); assert.equal(f.workers.length, 1);
  assert.equal(domText(s.view.displays.view.input2), ''); assert.equal(s.session.pipeline.entries.get('held').node.value, 'A');
  await s.stop();
});

test('inference and oversized-input errors disable only affected actions and preserve transcript without truncation', async () => {
  for (const oversized of [false, true]) {
    const f = sessionFixture(), s = f.session; await s.start();
    const input = 'X'.repeat(oversized ? 32769 : 1);
    s.session.pipeline.entries.get('input').context.emit('value', input); await tick();
    const work = s.view.graphActions.find(a => a.id === 'z').invoke(); await tick();
    if (!oversized) f.workers[0].reply(f.request().id, 'error', { message: 'GPU lost' });
    await work;
    assert.match(s.view.summaryStatus, oversized ? /32,768/ : /GPU lost/);
    assert.equal(domText(s.view.displays.view.input1), input); assert.equal(domText(s.view.displays.view.input2), '');
    assert.equal(s.view.graphActions.find(a => a.id === 'z').disabled, true); assert.equal(s.view.graphActions.find(a => a.id === 'a').disabled, false);
    if (oversized) assert.equal(f.workers.length, 0, 'invalid input never loads model resources');
    await s.stop();
  }
});

test('first manual request reports deferred load failure without inference or transcript interruption', async () => {
  const f = sessionFixture({ failLoad: true }), s = f.session;
  await s.start(); assert.equal(f.workers.length, 0);
  await s.view.graphActions.find(a => a.id === 'z').invoke();
  assert.match(s.view.summaryStatus, /Missing prepared model/);
  assert.equal(f.workers[0].messages.filter(m => m.type === 'summarize').length, 0);
  assert.ok(f.workers[0].terminated);
  assert.equal(s.view.graphActions.find(a => a.id === 'z').disabled, true);
  assert.equal(domText(s.view.displays.view.input1), 'A'); await s.stop();
});

test('ordinary trigger producers retain every identical event and snapshot FIFO ahead of async completion', async () => {
  const f = sessionFixture(), s = f.session; await s.start(); await tick();
  const p = s.session.pipeline, source = p.entries.get('input').context, button = p.entries.get('z').context;
  button.emit('trigger', 1); source.emit('value', 'B'); button.emit('trigger', 1); button.emit('trigger', 1);
  await tick(); assert.equal(f.request().text, 'A');
  f.complete('same'); await tick(); assert.equal(f.request().text, 'B');
  f.complete('same'); await tick(); assert.equal(f.request().text, 'B');
  f.complete('same'); await s.stop();
  assert.deepEqual(f.workers[0].messages.filter(m => m.type === 'summarize').map(m => m.text), ['A', 'B', 'B']);
  assert.equal(domText(s.view.displays.view.input2), 'same');
});

test('programmatic trigger overflow is bounded and visible while transcript remains live', async () => {
  const f = sessionFixture(), s = f.session; await s.start(); await tick();
  const p = s.session.pipeline, button = p.entries.get('z').context;
  button.emit('trigger', 1); await tick();
  for (let i = 0; i < 32; i++) button.emit('trigger', 1);
  await tick(); assert.match(s.view.summaryStatus, /backlog exceeded/);
  assert.equal(p.entries.get('summary').failed, true); assert.equal(p.errors.length, 1);
  assert.equal(f.workers[0].messages.filter(m => m.type === 'summarize').length, 1);
  assert.ok(f.workers[0].terminated);
  p.entries.get('input').context.emit('value', 'still transcribing'); await tick();
  assert.equal(domText(s.view.displays.view.input1), 'still transcribing'); await s.stop();
});

test('checked-in manual-summary example retains audio and Button roots and uses two Display tabs', async () => {
  const g = JSON.parse(await readFile('docs/examples/manual-text-summary.json', 'utf8'));
  assert.deepEqual(validateGraph(g), []); assert.equal(executableGraph(g).nodes.length, g.nodes.length);
  assert.equal(g.nodes.find(n => n.type === 'Display').settings.inputCount, 2);
});
