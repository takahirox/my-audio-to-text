import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabSession } from '../extension/session.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { graphNode, edge, GRAPH_VERSION } from '../extension/graph.js';
import { domText } from './fixtures/dom.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
const types = ['MeetingSummaryLfm2', 'MeetingSummaryQwen35', 'IfCondition'];

function graph(type) {
  const nodes = [graphNode('Text', 'source'), graphNode(type, 'model'), graphNode('FocusedInputTextOutputNode', 'field')];
  nodes[0].settings.value = 'first';
  const edges = [edge('source', 'value', 'model', 'text'), edge('source', 'value', 'field', 'text')];
  function display(id, from, port) {
    nodes.push(graphNode('TextAccumulator', id + '-history'), graphNode('TextToDOM', id + '-dom'), graphNode('LiveTextDisplay', id));
    edges.push(edge(from, port, id + '-history', 'append'), edge(id + '-history', 'text', id + '-dom', 'text'), edge(id + '-dom', 'dom', id, 'dom'));
  }
  display('model-output', 'model', type === 'IfCondition' ? 'yes' : 'summary');
  if (type === 'IfCondition') display('no-output', 'model', 'no');
  display('peer', 'source', 'value');
  for (const [type, id] of [['OpusMtJaEn', 'forward'], ['OpusMtEnJa', 'reverse']]) {
    nodes.push(graphNode(type, id)); edges.push(edge('source', 'value', id, 'text')); display(id + '-output', id, 'text');
  }
  return { version: GRAPH_VERSION, nodes, edges };
}

function workers() {
  const all = [];
  const controls = { phase: '', hold: '' };
  function factory() {
    const worker = { messages: [], released: false,
      terminate() { this.released = true; },
      postMessage(data) {
        this.messages.push(data);
        if (controls.hold === data.type) return;
        queueMicrotask(() => this.reply(data, controls.phase === data.type));
      },
      reply(data, fail = false) {
        this.onmessage?.({ data: { id: data.id, type: fail ? 'error' : ({ load: 'ready', summarize: 'result', decide: 'result', drain: 'drained' }[data.type]),
          message: 'Controlled model failure', summary: 'committed summary', branch: 'yes', confidence: .99 } });
      },
    };
    all.push(worker); return worker;
  }
  return { all, controls, factory };
}

function fixture(type) {
  const model = workers(), translations = [], inserted = [];
  const session = new TabSession(() => {}, { graph: graph(type),
    meetingSummaryWorkerFactory: model.factory, ifConditionWorkerFactory: model.factory,
    prepareTranslation: async () => {}, translationWorkerFactory: () => {
      const worker = { postMessage(data) {
        queueMicrotask(() => this.onmessage?.({ data: { id: data.id, type: { load: 'ready', translate: 'result', drain: 'drained' }[data.type], texts: ['translated ' + data.text] } }));
      }, terminate() { this.released = true; } };
      translations.push(worker); return worker;
    },
    pageConnectionFactory: () => ({ async request(action, value) { if (action === 'append') inserted.push(value.text); return { inserted: true }; }, close() {} }),
  });
  session.outputTarget = { tabId: 42, documentId: 'document', label: 'Target' };
  const display = id => domText(session.view.displays[id]);
  const send = async text => { session.session.pipeline.entries.get('source').context.emit('value', text); await turn(); };
  const flush = async () => { await turn(); await session.session.pipeline.entries.get('model').node.flush?.(); await turn(); };
  return { session, model, translations, inserted, display, send, flush };
}

for (const type of types) {
  const infer = type === 'IfCondition' ? 'decide' : 'summarize';
  const status = type === 'IfCondition' ? 'conditionStatus' : 'summaryStatus';
  for (const phase of ['load', infer, 'stop']) for (const end of phase === 'stop' ? ['stop'] : ['stop', 'cancel']) {
    test(`${type}: ${phase} failure is recorded once; independent paths survive ${end}/restart`, async t => {
      const f = fixture(type); t.after(() => f.session.cancel());
      if (phase === 'load') f.model.controls.phase = 'load';
      await f.session.start(42); await f.flush();
      const pipeline = f.session.session.pipeline;
      assert.equal(f.session.view.state, 'running');
      const committed = phase === 'load' ? '' : type === 'IfCondition' ? 'first' : 'committed summary';
      assert.equal(f.display('model-output'), committed);
      if (phase !== 'load') {
        f.model.controls.phase = phase === 'stop' && type === 'IfCondition' ? 'drain' : infer;
        await f.send('failed input');
        if (phase !== 'stop') await f.flush();
      }
      if (phase !== 'stop') {
        assert.equal(pipeline.entries.get('model').failed, true);
        assert.equal(pipeline.entries.get('model').controller.signal.aborted, true);
        assert.equal(pipeline.errors.length, 1);
        assert.match(pipeline.errors[0].message, /Node model: Controlled model failure/);
        assert.equal(f.model.all[0].released, true);
        await f.send('surviving input');
        assert.equal(f.display('peer').split('\n').at(-1), 'surviving input');
        assert.equal(f.display('forward-output').split('\n').at(-1), 'translated surviving input');
        assert.equal(f.display('reverse-output').split('\n').at(-1), 'translated surviving input');
        assert.equal(f.inserted.at(-1), 'surviving input');
        assert.equal(f.session.view.state, 'running');
      }
      // A pending short summary fails during Stop. IfCondition's Stop-time
      // failure is its Worker drain reply, after all accepted decisions finish.
      await f.session[end]();
      assert.equal(f.session.view.state, 'idle');
      assert.equal(pipeline.state, 'disposed');
      assert.ok(f.model.all.every(worker => worker.released));
      assert.ok(f.translations.every(worker => worker.released));
      assert.equal(pipeline.errors.length, 1);
      assert.equal(pipeline.entries.get('model').failed, true);
      assert.equal(f.session.view.error, '', 'the processor status reports the error without a duplicate general error');
      assert.equal(f.session.view[status].match(/Controlled model failure/g)?.length, 1);
      assert.doesNotMatch(f.session.view.status, /failed/);
      assert.equal(f.display('model-output'), phase === 'stop' && type === 'IfCondition' ? 'first\nfailed input' : committed);
      f.model.controls.phase = ''; f.model.controls.hold = '';
      await f.session.start(42); await f.flush();
      assert.notEqual(f.session.session.pipeline, pipeline);
      assert.equal(f.session.session.pipeline.errors.length, 0);
      assert.equal(f.display('peer'), 'first');
      assert.equal(f.display('model-output'), type === 'IfCondition' ? 'first' : 'committed summary');
      await f.session.stop();
    });
  }

  for (const pending of ['load', infer, 'stop']) test(`${type}: Cancel interrupts pending ${pending}; stale replies cannot enter a restarted graph`, async t => {
    const f = fixture(type); t.after(() => f.session.cancel());
    const heldRequest = pending === 'stop' ? type === 'IfCondition' ? 'drain' : infer : pending;
    if (pending !== 'stop') f.model.controls.hold = pending;
    const starting = f.session.start(42); await turn();
    if (pending !== 'load') {
      await starting;
      if (type !== 'IfCondition') { f.session.session.pipeline.entries.get('model').node.flush(); await turn(); }
    }
    let stopping;
    if (pending === 'stop') {
      await f.flush(); f.model.controls.hold = heldRequest;
      if (type !== 'IfCondition') await f.send('pending at Stop');
      stopping = f.session.stop(); await turn();
    }
    const pipeline = f.session.session.pipeline, worker = f.model.all[0];
    const late = worker.onmessage, request = worker.messages.at(-1);
    assert.equal(request.type, heldRequest);
    await f.session.cancel(); await starting; await stopping;
    assert.equal(worker.released, true); assert.equal(pipeline.errors.length, 0);
    f.model.controls.hold = '';
    await f.session.start(42); await f.flush();
    const snapshot = () => Object.fromEntries(Object.entries(f.session.view.displays).map(([id, dom]) => [id, domText(dom)]));
    const before = snapshot();
    late({ data: { id: request.id, type: heldRequest === 'load' ? 'ready' : heldRequest === 'drain' ? 'drained' : 'result', summary: 'stale summary', branch: 'no', confidence: .99 } });
    await turn();
    assert.deepEqual(snapshot(), before);
    assert.equal(f.session.session.pipeline.errors.length, 0);
    await f.session.stop();
  });

  test(`${type}: startup failure without an independent output rejects and disposes`, async () => {
    const g = graph(type); g.nodes = g.nodes.filter(node => ['source', 'model'].includes(node.id) || node.id.startsWith('model-output'));
    g.edges = g.edges.filter(route => g.nodes.some(node => node.id === route.from[0]) && g.nodes.some(node => node.id === route.to[0]));
    const f = workers(); f.controls.phase = 'load'; const errors = [];
    const { pipeline } = buildGraph(g, { meetingSummaryWorkerFactory: f.factory, ifConditionWorkerFactory: f.factory, onError: error => errors.push(error) });
    await assert.rejects(pipeline.start(), /Controlled model failure/);
    assert.equal(pipeline.state, 'disposed'); assert.equal(pipeline.entries.get('model').failed, true);
    assert.equal(errors.length, 1); assert.equal(f.all[0].released, true);
  });
}

for (const type of types.filter(type => type !== 'IfCondition')) test(`${type}: backlog diagnostic drains accepted evidence without reporting a processor failure`, async t => {
  const f = fixture(type); t.after(() => f.session.cancel());
  await f.session.start(42);
  const pipeline = f.session.session.pipeline, node = pipeline.entries.get('model').node;
  // The first short fragment is still pending when the overflowing one arrives.
  await f.send('x'.repeat(32768)); await f.flush();
  assert.match(f.session.view.summaryStatus, /overflowing fragment was rejected/);
  assert.equal(f.display('model-output'), 'committed summary');
  assert.deepEqual(f.model.all[0].messages.filter(m => m.type === 'summarize').map(m => m.text), ['first']);
  assert.equal(node.disposed, true); assert.equal(pipeline.entries.get('model').failed, false);
  assert.deepEqual(pipeline.errors, []);
  await f.send('peer survives'); assert.equal(f.display('peer').split('\n').at(-1), 'peer survives');
  await f.session.stop(); assert.equal(f.session.view.status, 'Stopped. Outputs are ready.');
});
