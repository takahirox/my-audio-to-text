import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, TextOutputNode, EnglishToJapaneseOpusMtTranslationNode } from '../web/translation-nodes.js';
import { OPUS_MT, OPUS_MT_EN_JA } from '../web/translation-models.js';
import { TranslationSchedulerNode } from '../extension/translation-scheduler.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph, graphNode, edge, NODE_TYPES, translationViewEdges } from '../extension/graph.js';
import { defineAssetSet, HASH_CHUNK_BYTES } from '../extension/model-asset-cache.js';
import { translationLabel, provisionalLabel } from '../extension/translation-view.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function workerFixture({ holdLoad = false, failLoad = false, failTranslate = false, empty = false } = {}) {
  const workers = [], requests = [];
  const workerFactory = url => {
    const worker = { url, messages: [], terminated: false,
      postMessage(data) {
        this.messages.push(data);
        if (data.type === 'load' && !holdLoad) queueMicrotask(() => this.reply({ id: data.id,
          type: failLoad ? 'error' : 'ready', message: 'model failed' }));
        if (data.type === 'translate') requests.push({ worker: this, ...data });
        if (data.type === 'drain') queueMicrotask(() => this.reply({ id: data.id, type: 'drained' }));
      },
      reply(data) { this.onmessage?.({ data }); }, terminate() { this.terminated = true; },
    };
    workers.push(worker); return worker;
  };
  const complete = (index, text = `English: ${requests[index].text}`) => {
    const request = requests[index];
    request.worker.reply({ id: request.id, type: failTranslate ? 'error' : 'result',
      message: 'inference failed', texts: empty ? [] : [text] });
  };
  return { workers, requests, workerFactory, complete };
}
async function schedulerGraph(options = {}) {
  const f = workerFixture(options), outputs = [], states = [], plain = [];
  let emit;
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.workerFactory, prepare: options.prepare,
    TranslationNode: options.direction === 'en-ja' ? EnglishToJapaneseOpusMtTranslationNode : undefined,
    onState: state => states.push(state) });
  const pipeline = new Pipeline({ nodes: {
    source: { inputs: {}, outputs: { provisional: TEXT, final: TEXT }, start(context) { emit = context.emit; } },
    scheduler, sink: { inputs: NODE_TYPES.PairedTextFormatter.inputs, outputs: {}, async receiveInputs(values) {
      await options.receiveInputs?.(values);
      const provisional = Object.hasOwn(values, 'provisionalStatus'), prefix = provisional ? 'provisional' : 'final';
      outputs.push({ port: provisional ? 'provisional' : 'final', source: values[`${prefix}Source`],
        status: values[`${prefix}Status`], error: values[`${prefix}Error`], text: values[provisional ? 'provisionalText' : 'text'] || '',
        index: values.finalIndex });
    } }, plain: new TextOutputNode(text => plain.push(text)),
  }, connections: ['provisional', 'final'].flatMap(port => [
    { from: ['source', port], to: ['scheduler', port === 'final' ? 'text' : port] },
  ]).concat(translationViewEdges('scheduler', 'sink'), [{ from: ['scheduler', 'text'], to: ['plain', 'text'] }]) });
  await pipeline.start();
  const send = (port, text) => emit(port, text);
  return { ...f, pipeline, scheduler, outputs, states, plain, send };
}

test('production pinned manifest includes all seven runtime files and reviewed bounded hashes', () => {
  const files = JSON.parse(readFileSync('extension/opus-mt-assets.json'));
  const set = defineAssetSet({ ...OPUS_MT, files });
  assert.equal(set.bytes, 238978729);
  assert.deepEqual(files.map(file => file.path), ['config.json', 'generation_config.json', 'tokenizer_config.json',
    'tokenizer.json', 'special_tokens_map.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
  assert.ok(set.files.every(file => file.url.includes(OPUS_MT.revision) && file.sha256Chunks.length === Math.ceil(file.bytes / HASH_CHUNK_BYTES)));
});

for (const direction of ['ja-en', 'en-ja']) {
const graph = options => schedulerGraph({ ...options, direction });
test(`${direction}: explicit Pipeline adapter coalesces rapid provisional updates and prioritizes ordered finals`, async () => {
  const f = await graph();
  f.send('provisional', 'first'); await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.scheduler.translation.entries.get('source').outputs.text, TEXT);
  assert.equal(f.scheduler.translation.entries.get('translator').inputs.text, TEXT);
  assert.equal(f.scheduler.translation.entries.get('sink').inputs.text, TEXT);
  assert.equal(f.workers[0].messages[0].cacheOnly, true);
  assert.ok(f.workers[0].url.pathname.endsWith(direction === 'en-ja' ? '/opus-mt-en-ja-worker.js' : '/opus-mt-worker.js'));
  for (let i = 0; i < 100; i++) f.send('provisional', `update ${i}`);
  await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.scheduler.provisional.source, 'update 99');
  f.send('final', 'final one'); f.send('final', 'final two'); f.send('provisional', 'new utterance'); await tick();
  f.complete(0); await tick();
  assert.equal(f.requests[1].text, 'final one');
  assert.deepEqual(f.outputs.filter(value => value.status === 'complete').map(value => [value.port, value.source]),
    [['provisional', '']], 'old interim suppressed and its preview explicitly cleared');
  // A duplicate delayed reply cannot resolve the active final request.
  f.complete(0, 'stale duplicate'); await tick(); assert.equal(f.requests.length, 2);
  f.complete(1); await tick(); assert.equal(f.requests[2].text, 'final two');
  f.complete(2); await tick(); assert.equal(f.requests[3].text, 'new utterance');
  f.complete(3); await tick();
  assert.deepEqual(f.outputs.filter(value => value.status === 'complete').map(value => [value.port, value.source, value.index]),
    [['provisional', '', undefined], ['final', 'final one', 0], ['final', 'final two', 1], ['provisional', 'new utterance', undefined]]);
  await f.pipeline.stop(); await f.pipeline.dispose(); assert.ok(f.workers.every(worker => worker.terminated));
});

test(`${direction}: slow correlated consumer drains identical finals without delaying a plain TEXT branch`, async () => {
  let release, entered = false;
  const held = new Promise(resolve => { release = resolve; });
  const f = await graph({ receiveInputs: async () => { if (!entered) { entered = true; await held; } } });
  f.send('final', 'same'); f.send('final', 'same'); await tick();
  assert.equal(entered, true); assert.deepEqual(f.outputs, []);
  f.complete(0, 'first'); await tick();
  // A late duplicate completion cannot resolve the next request.
  f.complete(0, 'duplicate'); await tick();
  f.complete(1, 'second'); await tick();
  assert.deepEqual(f.plain, ['first', 'second']);
  let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  release(); await stopping;
  assert.deepEqual(f.outputs.map(row => [row.source, row.status, row.index, row.text]), [
    ['same', 'pending', 0, ''], ['same', 'pending', 1, ''],
    ['same', 'complete', 0, 'first'], ['same', 'complete', 1, 'second'],
  ]);
  await f.pipeline.dispose();
});

test(`${direction}: latest matching provisional completes; Stop drops queued interim and drains every final`, async () => {
  const f = await graph();
  f.send('provisional', 'old'); await tick();
  f.send('provisional', 'latest'); await tick(); f.complete(0); await tick(); f.complete(1); await tick();
  assert.deepEqual(f.outputs.filter(value => value.status === 'complete').map(value => value.source), ['latest']);
  f.send('final', 'one'); f.send('final', 'two'); f.send('provisional', 'obsolete'); await tick();
  let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  f.complete(2); await tick(); assert.equal(f.requests[3].text, 'two');
  f.complete(3); await stopping;
  assert.equal(f.requests.length, 4);
  await f.pipeline.dispose();
});

for (const mode of ['load', 'translate', 'crash', 'empty']) {
  test(`${direction}: translation ${mode} failure marks all finals and remains isolated from upstream Pipeline`, async () => {
    const f = await graph({ failLoad: mode === 'load', failTranslate: mode === 'translate', empty: mode === 'empty' });
    f.send('final', 'one'); f.send('final', 'two'); await tick();
    if (mode === 'translate' || mode === 'empty') { f.complete(0); await tick(); }
    if (mode === 'crash') { f.workers[0].onerror({ message: 'worker crashed' }); await tick(); }
    f.send('final', 'three'); await tick();
    assert.equal(f.pipeline.state, 'running'); assert.equal(f.pipeline.errors.length, 0);
    assert.deepEqual(f.outputs.filter(value => value.status === 'error').map(value => value.index).sort(), [0, 1, 2]);
    assert.ok(f.workers.every(worker => worker.terminated));
    await f.pipeline.stop(); await f.pipeline.dispose();
  });
}

for (const phase of ['prepare', 'load', 'translate']) {
  test(`${direction}: cancel during ${phase} releases owned Worker and rejects late output`, async () => {
    let finish;
    const f = await graph({ holdLoad: phase === 'load', prepare: phase === 'prepare' ? () => new Promise(resolve => { finish = resolve; }) : undefined });
    f.send('final', 'one'); await tick();
    await f.pipeline.dispose(); const before = f.outputs.length;
    if (finish) finish();
    else if (phase === 'load') f.workers[0].reply({ type: 'ready', id: 1 });
    else f.complete(0);
    await tick();
    assert.equal(f.outputs.length, before); assert.ok(f.workers.every(worker => worker.terminated));
    assert.equal(f.pipeline.state, 'disposed');
  });
}

test(`${direction}: overlong final reports error without losing subsequent valid final`, async () => {
  const f = await graph(); f.send('final', 'x'.repeat(1001)); f.send('final', 'valid'); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].text, 'valid');
  f.complete(0); await tick();
  assert.deepEqual(f.outputs.filter(value => value.status !== 'pending').map(value => value.status), ['error', 'complete']);
  await f.pipeline.stop(); await f.pipeline.dispose();
});

}

test('UI distinguishes matching, pending, older interim, failed and canceled translation', () => {
  const complete = { status: 'complete', source: 'old', text: 'English old' };
  assert.equal(provisionalLabel('old', complete, true), 'English old');
  assert.match(provisionalLabel('new', complete, true), /Translating… Older interim: English old/);
  assert.match(provisionalLabel('new', { status: 'pending', source: 'new', previous: complete }, true), /Original for older translation: old/);
  assert.equal(provisionalLabel('new', null, false), 'Translation off');
  assert.equal(translationLabel({ status: 'error', error: 'cache missing' }), 'Translation failed: cache missing');
  assert.equal(translationLabel({ status: 'canceled' }), 'Translation canceled');
});

function sessionFixture(translation = workerFixture()) {
  const asr = [], views = [];
  const session = new TabSession(view => views.push(view), {
    translationWorkerFactory: translation.workerFactory, prepareTranslation: async () => {},
    sourceFactory: () => ({ start() {}, stop() {} }),
    workerFactory(path) {
      const worker = { path, terminated: false, postMessage(data) {
        if (data.type === 'load') queueMicrotask(() => this.reply({ type: 'ready' }));
        if (data.type === 'vad-stop') queueMicrotask(() => this.reply({ type: 'vad-stopped', session: data.session }));
      }, reply(data) { this.onmessage?.({ data }); }, terminate() { this.terminated = true; } };
      asr.push(worker); return worker;
    },
  });
  return { session, asr, views, translation };
}

const display = (f, id = 'transcript') => f.session.view.displays[id] || { items: [], preview: '' };
const rows = f => f.session.session.pipeline.entries.get('translated-format').node.rows;

for (const direction of ['ja-en', 'en-ja']) for (const original of [false, true]) test(`${direction}: paired formatter preserves ordered repeated sources, stale preview suppression and Stop drain (${original})`, async () => {
  const f = sessionFixture(), graph = defaultGraph({ direction });
  if (!original) { graph.nodes = graph.nodes.filter(n => n.id !== 'transcript'); graph.edges = graph.edges.filter(e => e.to[0] !== 'transcript'); }
  graph.edges.reverse(); f.session.setGraph(graph); await f.session.start(42);
  const speech = f.session.session.speech;
  speech.receiveEvent({ type: 'partial', text: 'old', id: 0 }); await tick();
  speech.receiveEvent({ type: 'partial', text: 'latest', id: 0 }); await tick();
  f.translation.complete(0, 'stale'); await tick(); assert.doesNotMatch(display(f, 'translated').preview, /stale/);
  f.translation.complete(1, 'translated latest'); await tick(); assert.match(display(f, 'translated').preview, /latest.*\n.*translated latest/);
  speech.receiveEvent({ type: 'final', text: 'same', id: 0 }); speech.receiveEvent({ type: 'final', text: 'same', id: 1 }); await tick();
  assert.deepEqual(rows(f).map(row => row.status), ['pending', 'pending']);
  const stopping = f.session.stop(); await tick();
  f.translation.complete(2, 'first'); await tick(); f.translation.complete(3, 'second'); await stopping;
  assert.match(display(f, 'translated').preview, /same\n.*first\n\n.*same\n.*second/);
  assert.deepEqual(display(f).items, original ? ['same', 'same'] : []);
  assert.ok(f.translation.workers.every(w => w.terminated));
  await f.session.start(42); assert.equal(display(f, 'translated').preview, '');
  speech.receiveEvent({ type: 'final', text: 'late', id: 5 }); f.translation.complete(3, 'late'); await tick();
  assert.deepEqual(display(f).items, []); f.session.cancel();
});

for (const direction of ['ja-en', 'en-ja']) for (const ports of [['replace'], ['append'], ['replace', 'append']]) test(`${direction}: arbitrary direct translation TEXT display ${ports.join('/')}`, async () => {
  const f = sessionFixture(), graph = defaultGraph({ direction });
  graph.nodes = graph.nodes.filter(n => n.id !== 'translated-format'); graph.edges = graph.edges.filter(e => e.to[0] !== 'translated-format' && e.from[0] !== 'translated-format');
  for (const port of ports) graph.edges.push({ from: ['translation', port === 'append' ? 'text' : 'provisional'], to: ['translated', port] });
  f.session.setGraph(graph); await f.session.start(42); const speech = f.session.session.speech;
  speech.receiveEvent({ type: 'partial', text: 'preview' }); await tick(); assert.equal(display(f, 'translated').preview, '');
  f.translation.complete(0, 'translated preview'); await tick(); assert.equal(display(f, 'translated').preview, ports.includes('replace') ? 'translated preview' : '');
  speech.receiveEvent({ type: 'final', text: 'final' }); await tick(); assert.equal(display(f, 'translated').preview, '');
  f.translation.complete(1, 'translated final'); await tick(); assert.deepEqual(display(f, 'translated').items, ports.includes('append') ? ['translated final'] : []);
  await f.session.stop(); await f.session.start(42); assert.deepEqual(display(f, 'translated'), { preview: '', items: [] }); f.session.cancel();
});

test('paired compatibility retains error history and visibly cancels pending rows, ignoring late replies', async () => {
  const f = sessionFixture(); f.session.setTranslation(true); await f.session.start(42);
  f.session.session.speech.receiveEvent({ type: 'final', text: 'pending', id: 0 }); await tick();
  f.session.cancel(); f.translation.complete(0, 'late'); await tick();
  assert.match(display(f, 'translated').preview, /pending\n.*Translation canceled/); assert.doesNotMatch(display(f, 'translated').preview, /late/);
  f.session.prepareTranslation = async () => { throw Error('cache unavailable'); }; await f.session.start(42);
  f.session.session.speech.receiveEvent({ type: 'final', text: 'failed', id: 0 }); await tick(); await f.session.stop();
  assert.match(display(f, 'translated').preview, /failed\n.*Translation failed: cache unavailable/); assert.deepEqual(display(f).items, ['failed']);
});

test('English → Japanese has a distinct pinned complete manifest and cache keys', () => {
  const files = JSON.parse(readFileSync('extension/opus-mt-en-ja-assets.json'));
  const set = defineAssetSet({ ...OPUS_MT_EN_JA, files });
  const original = defineAssetSet({ ...OPUS_MT, files: JSON.parse(readFileSync('extension/opus-mt-assets.json')) });
  assert.equal(set.bytes, 252634769);
  assert.equal(set.files.length, 7);
  assert.ok(set.files.every(file => file.url.includes(OPUS_MT_EN_JA.revision) && !original.files.some(old => old.url === file.url)));
  assert.ok(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256) && file.sha256Chunks.length === Math.ceil(file.bytes / HASH_CHUNK_BYTES)));
});

test('active processing direction and display labels remain immutable when a different draft is saved', async () => {
  const f = sessionFixture(), preparations = []; f.session.prepareTranslation = async (signal, direction) => preparations.push(direction);
  f.session.setGraph(defaultGraph({ direction: 'en-ja' })); await f.session.start(42);
  const active = f.session.view.activeGraph; f.session.setTranslationDirection('ja-en');
  assert.equal(f.session.view.activeGraph, active); assert.deepEqual(preparations, ['en-ja']);
  f.session.session.speech.receiveEvent({ type: 'final', text: 'Hello', id: 0 }); await tick(); f.translation.complete(0, 'こんにちは'); await tick(); await f.session.stop();
  assert.equal(display(f, 'translated').preview, 'English: Hello\nJapanese: こんにちは');
  await f.session.start(42); assert.deepEqual(preparations, ['en-ja', 'ja-en']); assert.equal(display(f, 'translated').preview, ''); f.session.cancel();
});

test('scheduler accepts only TEXT and emits successful strings once to independent fan-out without diagnostic connections', async () => {
  const f = workerFixture(), a = [], b = [];
  let emit;
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.workerFactory });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(c) { emit = text => c.emit('text', text); } }, scheduler,
    a: new TextOutputNode(text => a.push(text)),
    b: new TextOutputNode(text => b.push(text)),
  }, connections: [
    { from: ['source', 'text'], to: ['scheduler', 'text'] },
    ...['a', 'b'].map(id => ({ from: ['scheduler', 'text'], to: [id, 'text'] })),
  ] });
  await pipeline.start();
  emit('same'); emit('same'); emit('x'.repeat(1001)); emit('next'); await tick();
  assert.deepEqual(a, [], 'pending is never a TEXT value');
  f.complete(0, 'first'); await tick(); f.complete(1, 'second'); await tick();
  const stopping = pipeline.stop(); await tick(); f.complete(2, 'third'); await stopping;
  assert.deepEqual(a, ['first', 'second', 'third']); assert.deepEqual(b, a);
  await pipeline.dispose();
});

test('independent sinks consume plain TEXT and append clears only its own replace preview', async () => {
  const f = sessionFixture(); f.session.setTranslation(true); await f.session.start(42);
  const original = f.session.session.pipeline.entries.get('transcript');
  original.node.receive('replace', 'independent preview', original.context);
  f.session.session.translation.receive('provisional', 'translation source'); await tick();
  assert.equal(display(f).preview, 'independent preview'); assert.match(display(f, 'translated').preview, /translation source/);
  original.node.receive('append', 'committed', original.context); assert.equal(display(f).preview, '');
  f.translation.complete(0, 'translated'); await tick(); assert.match(display(f, 'translated').preview, /translated/);
  assert.deepEqual(display(f).items, ['committed']); await f.session.stop();
});

test('multiple translator runtime statuses retain each branch failure independently of Live labels', async () => {
  const f = sessionFixture(), graph = defaultGraph();
  graph.nodes.push(graphNode('OpusMtEnJa', 'reverse'), graphNode('LiveTextDisplay', 'reverse-display'));
  graph.edges.push(edge('speech', 'final', 'reverse', 'text'), edge('reverse', 'text', 'reverse-display', 'append'));
  f.session.prepareTranslation = async (signal, direction) => { if (direction === 'ja-en') throw Error('Forward cache unavailable'); };
  f.session.setGraph(graph); await f.session.start(42); await tick();
  assert.match(f.session.view.translationStatus, /translation: Translation unavailable: Forward cache unavailable/);
  assert.match(f.session.view.translationStatus, /reverse: Local OPUS-MT ready/);
  f.session.session.speech.receiveEvent({ type: 'final', text: 'Hello' }); await tick();
  f.translation.complete(0, 'こんにちは'); await tick(); await f.session.stop();
  assert.match(display(f, 'translated').preview, /Forward cache unavailable/);
  assert.deepEqual(display(f, 'reverse-display').items, ['こんにちは']);
});
