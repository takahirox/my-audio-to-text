import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, TextOutputNode, EnglishToJapaneseOpusMtTranslationNode } from '../web/translation-nodes.js';
import { OPUS_MT, OPUS_MT_EN_JA } from '../web/translation-models.js';
import { TranslationSchedulerNode, TEXT_RESULT } from '../extension/translation-scheduler.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph } from '../extension/graph.js';
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
  const f = workerFixture(options), outputs = [], states = [];
  let emit;
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.workerFactory, prepare: options.prepare,
    TranslationNode: options.direction === 'en-ja' ? EnglishToJapaneseOpusMtTranslationNode : undefined,
    onState: state => states.push(state) });
  const pipeline = new Pipeline({ nodes: {
    source: { inputs: {}, outputs: { provisional: TEXT, final: TEXT }, start(context) { emit = context.emit; } },
    scheduler, sink: { inputs: { provisional: TEXT_RESULT, final: TEXT_RESULT }, outputs: {}, receive(port, value) { outputs.push({ port, ...value }); } },
  }, connections: ['provisional', 'final'].flatMap(port => [
    { from: ['source', port], to: ['scheduler', port === 'final' ? 'text' : port] }, { from: ['scheduler', port === 'final' ? 'finalResult' : 'provisionalResult'], to: ['sink', port] },
  ]) });
  await pipeline.start();
  const send = (port, text) => emit(port, text);
  return { ...f, pipeline, scheduler, outputs, states, send };
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

test('optional session path preserves Japanese, paired ordered English, stop/drain and repeat ownership', async () => {
  const f = sessionFixture(); await f.session.start(42);
  assert.equal(f.translation.workers.length, 0); await f.session.stop();
  f.session.setTranslation(true); await f.session.start(42);
  const speech = f.session.session.speech;
  speech.receiveEvent({ type: 'partial', text: '日本語', id: 0 }); await tick();
  assert.equal(f.session.view.partial, '日本語'); assert.equal(f.session.view.interimTranslation.status, 'pending');
  f.translation.complete(0, 'Japanese'); await tick(); assert.equal(f.session.view.interimTranslation.text, 'Japanese');
  speech.receiveEvent({ type: 'final', text: '日本語', id: 0 });
  speech.receiveEvent({ type: 'final', text: '次', id: 1 }); await tick();
  const stopping = f.session.stop(); await tick(); assert.equal(f.session.view.state, 'stopping');
  f.translation.complete(1, 'Japanese'); await tick(); f.translation.complete(2, 'Next'); await stopping;
  assert.deepEqual(f.session.view.utterances.map(row => [row.source, row.text, row.status]),
    [['日本語', 'Japanese', 'complete'], ['次', 'Next', 'complete']]);
  assert.equal(f.session.view.final, '日本語\n次\n'); assert.ok(f.asr.every(worker => worker.terminated));
  assert.ok(f.translation.workers.every(worker => worker.terminated));
  await f.session.start(99); assert.deepEqual(f.session.view.utterances, []);
  speech.receiveEvent({ type: 'final', text: 'late', id: 5 }); f.translation.complete(2, 'late'); await tick();
  assert.equal(f.session.view.final, ''); f.session.cancel(); await tick();
  assert.ok(f.translation.workers.every(worker => worker.terminated));
});

for (const direction of ['ja-en', 'en-ja']) for (const transcript of [false, true]) {
  test(`${direction}: TranslationView owns ordered rows ${transcript ? 'with' : 'without'} TranscriptView`, async () => {
    const f = sessionFixture(), graph = defaultGraph({ direction });
    if (!transcript) {
      graph.nodes = graph.nodes.filter(node => node.type !== 'TranscriptView');
      graph.edges = graph.edges.filter(edge => edge.to[0] !== 'transcript');
    }
    graph.edges.reverse(); f.session.setGraph(graph); await f.session.start(42);
    const speech = f.session.session.speech;
    speech.receiveEvent({ type: 'partial', text: 'old', id: 0 }); await tick();
    assert.equal(f.session.view.partial, 'old'); assert.equal(f.session.view.interimTranslation.status, 'pending');
    speech.receiveEvent({ type: 'partial', text: 'latest', id: 0 }); await tick();
    f.translation.complete(0, 'stale'); await tick();
    assert.equal(f.session.view.partial, 'latest'); assert.notEqual(f.session.view.interimTranslation.text, 'stale');
    f.translation.complete(1, 'translated latest'); await tick();
    assert.equal(f.session.view.interimTranslation.text, 'translated latest');
    // Identical source strings are separate utterances, paired by scheduler index.
    speech.receiveEvent({ type: 'final', text: 'same', id: 0 });
    speech.receiveEvent({ type: 'final', text: 'same', id: 1 }); await tick();
    assert.deepEqual(f.session.view.utterances.map(row => row.status), ['pending', 'pending']);
    assert.equal(f.session.view.partial, ''); assert.equal(f.session.view.interimTranslation, null);
    const stopping = f.session.stop(); await tick();
    f.translation.complete(2, 'first'); await tick(); f.translation.complete(3, 'second'); await stopping;
    assert.deepEqual(f.session.view.utterances.map(row => [row.source, row.text, row.status, row.direction]),
      [['same', 'first', 'complete', direction], ['same', 'second', 'complete', direction]]);
    assert.equal(f.session.view.final, transcript ? 'same\nsame\n' : '');
    assert.ok(f.translation.workers.every(worker => worker.terminated));
  });
}

for (const direction of ['ja-en', 'en-ja']) for (const paired of [false, true]) test(`${direction}: delayed translated finals preserve the current ASR preview ${paired ? 'with' : 'without'} paired metadata`, async () => {
  const f = sessionFixture(), graph = defaultGraph({ direction });
  if (!paired) {
    graph.nodes = graph.nodes.filter(node => node.type !== 'TranslationView');
    graph.edges = graph.edges.filter(route => route.to[0] !== 'translated');
  }
  graph.edges = graph.edges.filter(route => !(route.to[0] === 'transcript' && route.to[1] === 'final')
    && !(route.to[0] === 'translation' && route.to[1] === 'provisional'));
  graph.edges.push({ from: ['translation', 'text'], to: ['transcript', 'final'] });
  f.session.setGraph(graph); await f.session.start(42);
  const speech = f.session.session.speech;
  // Finalization also clears provisional deliveries still queued at the sink.
  speech.receiveEvent({ type: 'partial', text: 'same', id: 0 });
  speech.receiveEvent({ type: 'final', text: 'same', id: 0 }); await tick();
  assert.equal(f.session.view.partial, ''); assert.equal(f.translation.requests.length, 1);
  speech.receiveEvent({ type: 'partial', text: 'same', id: 1 }); await tick();
  assert.equal(f.session.view.partial, 'same');
  f.translation.complete(0, 'first translation'); await tick();
  assert.equal(f.session.view.final, 'first translation\n');
  assert.equal(f.session.view.partial, 'same', 'an older translated final cannot clear a newer equal-string preview');
  speech.receiveEvent({ type: 'final', text: 'same', id: 1 });
  speech.receiveEvent({ type: 'partial', text: 'next preview', id: 2 }); await tick();
  f.translation.complete(1, 'second translation'); await tick();
  assert.equal(f.session.view.final, 'first translation\nsecond translation\n');
  assert.equal(f.session.view.partial, 'next preview');
  await f.session.stop(); assert.equal(f.session.view.partial, '');
  await f.session.start(42);
  f.session.session.speech.receiveEvent({ type: 'partial', text: 'canceled preview', id: 0 }); await tick();
  f.session.cancel(); await tick(); assert.equal(f.session.view.partial, '');
});

for (const direction of ['ja-en', 'en-ja']) for (const paired of [false, true]) test(`${direction}: scheduler clears its translated preview on finalization ${paired ? 'with' : 'without'} paired metadata`, async () => {
  const f = sessionFixture(), graph = defaultGraph({ direction });
  if (!paired) {
    graph.nodes = graph.nodes.filter(node => node.type !== 'TranslationView');
    graph.edges = graph.edges.filter(route => route.to[0] !== 'translated');
  }
  graph.edges = graph.edges.filter(route => route.to[0] !== 'transcript');
  graph.edges.push({ from: ['translation', 'provisional'], to: ['transcript', 'provisional'] },
    { from: ['translation', 'text'], to: ['transcript', 'final'] });
  f.session.setGraph(graph); await f.session.start(42);
  const speech = f.session.session.speech;
  speech.receiveEvent({ type: 'partial', text: 'hello', id: 0 }); await tick();
  f.translation.complete(0, 'Translated hello'); await tick();
  assert.equal(f.session.view.partial, 'Translated hello');
  speech.receiveEvent({ type: 'final', text: 'hello', id: 0 }); await tick();
  assert.equal(f.session.view.partial, '', 'final receipt invalidates the scheduler-owned preview before inference');
  f.translation.complete(1, 'Translated hello'); await tick();
  assert.equal(f.session.view.final, 'Translated hello\n');
  assert.equal(f.session.view.partial, '', 'the completed final leaves no stale translated preview');

  // A same-string next utterance is independent of the preceding final.
  speech.receiveEvent({ type: 'final', text: 'hello', id: 1 });
  speech.receiveEvent({ type: 'partial', text: 'hello', id: 2 }); await tick();
  if (paired) assert.equal(f.session.view.interimTranslation.status, 'pending');
  f.translation.complete(2, 'Second hello'); await tick();
  if (paired) assert.equal(f.session.view.interimTranslation.status, 'pending', 'an older final preserves newer provisional state');
  f.translation.complete(3, 'New preview'); await tick();
  assert.equal(f.session.view.partial, 'New preview');
  assert.equal(f.session.view.final, 'Translated hello\nSecond hello\n');
  await f.session.stop(); assert.equal(f.session.view.partial, '');
});

test('TranslationView without TranscriptView retains errors and cancels pending rows without accepting late replies', async () => {
  const f = sessionFixture(), graph = defaultGraph();
  graph.nodes = graph.nodes.filter(node => node.type !== 'TranscriptView');
  graph.edges = graph.edges.filter(edge => edge.to[0] !== 'transcript');
  f.session.setGraph(graph); await f.session.start(42);
  f.session.session.speech.receiveEvent({ type: 'final', text: 'pending', id: 0 }); await tick();
  f.session.cancel(); f.translation.complete(0, 'late'); await tick();
  assert.deepEqual(f.session.view.utterances.map(row => [row.source, row.status, row.text]), [['pending', 'canceled', '']]);
  f.session.prepareTranslation = async () => { throw Error('cache unavailable'); };
  await f.session.start(42); await tick();
  f.session.session.speech.receiveEvent({ type: 'final', text: 'failed', id: 0 }); await tick();
  await f.session.stop();
  assert.deepEqual(f.session.view.utterances.map(row => [row.source, row.status, row.error]), [['failed', 'error', 'cache unavailable']]);
});

test('unavailable model never stops speech capture and final pairing reports accurate failure', async () => {
  const f = sessionFixture(); f.session.prepareTranslation = async () => { throw new Error('WASM / cache unavailable'); };
  f.session.setTranslation(true); await f.session.start(42); await tick();
  assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.translationStatus, /unavailable/);
  f.session.session.speech.receiveEvent({ type: 'final', text: '原文', id: 0 }); await tick();
  assert.equal(f.session.view.final, '原文\n'); assert.equal(f.session.view.utterances[0].status, 'error');
  assert.equal(f.translation.workers.length, 0); assert.equal(f.session.view.error, '');
  await f.session.stop();
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

test('direction is captured before loading, applies next session, and never relabels old rows', async () => {
  const f = sessionFixture(); const preparations = [];
  f.session.prepareTranslation = async (signal, direction) => preparations.push(direction);
  assert.equal(f.session.view.translationDirection, 'ja-en');
  f.session.setTranslationDirection('en-ja');
  await f.session.start(42); assert.equal(f.translation.workers.length, 0); await f.session.stop();
  f.session.setTranslation(true);
  const starting = f.session.start(42);
  f.session.setTranslationDirection('ja-en');
  await starting; await tick();
  assert.deepEqual(preparations, ['en-ja']);
  assert.ok(f.translation.workers[0].url.pathname.endsWith('/opus-mt-en-ja-worker.js'));
  assert.equal(f.session.view.displayDirection, 'en-ja');
  f.session.session.speech.receiveEvent({ type: 'partial', text: 'Hello', id: 0 }); await tick();
  f.translation.complete(0, 'こんにちは'); await tick();
  assert.equal(f.session.view.interimTranslation.text, 'こんにちは');
  f.session.session.speech.receiveEvent({ type: 'final', text: 'Hello', id: 0 }); await tick();
  f.translation.complete(1, 'こんにちは'); await tick(); await f.session.stop();
  assert.equal(f.session.view.utterances[0].direction, 'en-ja');
  assert.equal(f.session.view.displayDirection, 'en-ja');
  await f.session.start(42); await tick();
  assert.deepEqual(preparations, ['en-ja', 'ja-en']);
  assert.ok(f.translation.workers[1].url.pathname.endsWith('/opus-mt-worker.js'));
  assert.equal(f.session.view.displayDirection, 'ja-en'); assert.deepEqual(f.session.view.utterances, []);
  f.session.cancel(); await tick(); assert.ok(f.translation.workers.every(worker => worker.terminated));
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

test('independent transcript and paired translation streams do not overwrite each other’s interim state', async () => {
  const f = sessionFixture(); f.session.setTranslation(true);
  const graph = structuredClone(f.session.graph); graph.nodes.find(node => node.type === 'TranscriptView').settings.direction = 'en-ja';
  f.session.setGraph(graph); await f.session.start(42);
  assert.equal(f.session.view.displayTranscriptDirection, 'en-ja');
  assert.equal(f.session.view.displayDirection, 'ja-en');
  const pipeline = f.session.session.pipeline;
  const transcript = pipeline.entries.get('transcript'), translation = pipeline.entries.get('translation');
  await transcript.node.receive('provisional', 'independent transcript', transcript.context);
  translation.node.receive('provisional', 'translation source'); await tick();
  assert.equal(f.session.view.partial, 'independent transcript');
  assert.equal(f.session.view.interimTranslation.source, 'translation source');
  await transcript.node.receive('final', 'independent final', transcript.context);
  assert.equal(f.session.view.partial, 'independent transcript', 'independent ports are not an atomic pair');
  await transcript.node.receive('provisional', '', transcript.context);
  assert.equal(f.session.view.partial, '', 'the provisional stream can explicitly clear its own preview');
  f.translation.complete(0, 'translated'); await tick();
  assert.equal(f.session.view.interimTranslation.text, 'translated');
  assert.equal(f.session.view.final, 'independent final\n');
  translation.node.receive('provisional', ''); await tick();
  assert.equal(f.session.view.interimTranslation.source, '');
  await f.session.stop();
});
