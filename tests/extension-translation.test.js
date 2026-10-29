import { addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, TextOutputNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';
import { OPUS_MT, OPUS_MT_EN_JA } from '../web/translation-models.js';
import { TranslationSchedulerNode, TRANSLATION_OUTPUTS } from '../extension/translation-scheduler.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph, graphNode, edge, NODE_TYPES, translationViewEdges } from '../extension/graph.js';
import { defineAssetSet, HASH_CHUNK_BYTES } from '../extension/model-asset-cache.js';
import { TextFormatterNode } from '../web/text-nodes.js';

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
  const f = workerFixture(options), outputs = [], states = [], plain = [], formatted = [];
  let emit;
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.workerFactory, prepare: options.prepare,
    TranslationNode: { 'en-ja': EnglishToJapaneseOpusMtTranslationNode, 'gemma-en-ja': EnglishToJapaneseTranslateGemmaTranslationNode, 'gemma-ja-en': TranslateGemmaTranslationNode }[options.direction],
    modelName: options.direction?.startsWith('gemma') ? 'TranslateGemma 4B' : 'OPUS-MT',
    onState: state => states.push(state) });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT }, start(c) { emit = c.emit; } }, scheduler,
    sink: { inputs: TRANSLATION_OUTPUTS, async receiveInputs(values) { await options.receiveInputs?.(values); outputs.push(values); } },
    plain: new TextOutputNode(text => plain.push(text)),
    formatter: new TextFormatterNode({ inputCount: 3, template: '{1}|{2}|{3}' }),
    formatted: new TextOutputNode(text => formatted.push(text)),
  }, connections: [edge('source', 'text', 'scheduler', 'text'),
    ...Object.keys(TRANSLATION_OUTPUTS).map(port => edge('scheduler', port, 'sink', port)),
    ...translationViewEdges('scheduler', 'formatter').filter(route => options.includeError !== false || route.from[1] !== 'error'), edge('scheduler', 'text', 'plain', 'text'),
    edge('formatter', 'text', 'formatted', 'text')] });
  await pipeline.start();
  return { ...f, pipeline, scheduler, outputs, states, plain, formatted, send: text => emit('text', text) };
}

test('production pinned manifest includes all seven runtime files and reviewed bounded hashes', () => {
  const files = JSON.parse(readFileSync('extension/opus-mt-assets.json'));
  const set = defineAssetSet({ ...OPUS_MT, files });
  assert.equal(set.bytes, 238978729);
  assert.deepEqual(files.map(file => file.path), ['config.json', 'generation_config.json', 'tokenizer_config.json',
    'tokenizer.json', 'special_tokens_map.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']);
  assert.ok(set.files.every(file => file.url.includes(OPUS_MT.revision) && file.sha256Chunks.length === Math.ceil(file.bytes / HASH_CHUNK_BYTES)));
});

for (const direction of ['ja-en', 'en-ja', 'gemma-en-ja', 'gemma-ja-en']) {
  const graph = options => schedulerGraph({ ...options, direction });
  test(`${direction}: committed results are atomic, FIFO, repeat-safe and ignore duplicate worker replies`, async () => {
    const f = await graph();
    assert.deepEqual(Object.keys(f.scheduler.inputs), ['text', 'provisional']);
    assert.deepEqual(Object.keys(f.scheduler.outputs), ['source', 'text', 'error']);
    f.send('same'); f.send('same'); f.send(''); f.send('  '); f.send('last'); await tick();
    assert.deepEqual(f.outputs, [], 'pending emits no formatter rows'); assert.equal(f.requests.length, 1);
    assert.equal(f.workers[0].messages[0].cacheOnly, true);
    assert.ok(f.workers[0].url.pathname.endsWith(direction.startsWith('gemma') ? '/translategemma-worker.js' : direction === 'en-ja' ? '/opus-mt-en-ja-worker.js' : '/opus-mt-worker.js'));
    if (direction.startsWith('gemma')) assert.equal(f.workers[0].messages[0].direction, direction.slice(6));
    f.complete(0, 'first'); await tick(); f.complete(0, 'stale duplicate'); await tick();
    assert.equal(f.requests.length, 2); f.complete(1, 'second'); await tick();
    assert.equal(f.requests.length, 3); assert.equal(f.requests[2].text, 'last');
    const stopping = f.pipeline.stop(); await tick(); f.complete(2, 'third'); await stopping;
    assert.deepEqual(f.outputs, [
      { source: 'same', text: 'first', error: '' }, { source: 'same', text: 'second', error: '' },
      { source: '', text: '', error: '' }, { source: '  ', text: '', error: '' }, { source: 'last', text: 'third', error: '' },
    ]);
    assert.deepEqual(f.formatted, ['same|first|', 'same|second|', '||', '  ||', 'last|third|']);
    assert.deepEqual(f.plain, ['first', 'second', '', '', 'third']);
    await f.pipeline.dispose(); assert.ok(f.workers.every(w => w.terminated));
  });
  test(`${direction}: slow formatter consumer preserves group order without holding plain fan-out`, async () => {
    let release; const held = new Promise(resolve => { release = resolve; });
    const f = await graph({ receiveInputs: () => held }); f.send('same'); f.send('same'); await tick();
    f.complete(0, 'one'); await tick(); f.complete(1, 'two'); await tick();
    assert.deepEqual(f.plain, ['one', 'two']); assert.deepEqual(f.outputs, []);
    let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
    await tick(); assert.equal(stopped, false); release(); await stopping;
    assert.deepEqual(f.outputs.map(v => v.text), ['one', 'two']); await f.pipeline.dispose();
  });
  for (const mode of ['load', 'translate', 'crash', 'empty']) test(`${direction}: ${mode} failure emits ordered source/error only and no successful TEXT`, async () => {
    const f = await graph({ failLoad: mode === 'load', failTranslate: mode === 'translate', empty: mode === 'empty' });
    f.send('one'); f.send('two'); await tick();
    if (mode === 'translate' || mode === 'empty') { f.complete(0); await tick(); }
    if (mode === 'crash') { f.workers[0].onerror({ message: 'worker crashed' }); await tick(); }
    f.send('three'); await f.pipeline.stop();
    assert.equal(f.pipeline.errors.length, 0);
    assert.deepEqual(f.outputs.map(v => v.source), ['one', 'two', 'three']);
    assert.ok(f.outputs.every(v => v.error && !Object.hasOwn(v, 'text'))); assert.deepEqual(f.plain, []);
    assert.ok(f.workers.every(w => w.terminated)); await f.pipeline.dispose();
  });
  test(`${direction}: a recoverable per-utterance error clears stale translation and preserves later successful routing`, async () => {
    const f = await graph(); f.send('first'); f.send('x'.repeat(1001)); f.send('last'); await tick();
    f.complete(0, 'translated first'); await tick();
    assert.match(f.formatted[1], /\|\|(?:OPUS-MT|TranslateGemma 4B) accepts/);
    assert.doesNotMatch(f.formatted[1], /translated first/);
    f.complete(1, 'translated last'); await f.pipeline.stop();
    assert.deepEqual(f.plain, ['translated first', 'translated last']);
    assert.equal(f.formatted[2], 'last|translated last|'); await f.pipeline.dispose();
  });
  for (const phase of ['prepare', 'load', 'translate']) test(`${direction}: Cancel during ${phase} suppresses queued and late work`, async () => {
    let finish;
    const f = await graph({ holdLoad: phase === 'load', prepare: phase === 'prepare' ? () => new Promise(resolve => { finish = resolve; }) : undefined });
    f.send('one'); f.send('two'); await tick(); await f.pipeline.dispose();
    if (finish) finish(); else if (phase === 'load') f.workers[0].reply({ type: 'ready', id: 1 }); else f.complete(0);
    await tick(); assert.deepEqual(f.outputs, []); assert.ok(f.workers.every(w => w.terminated));
    assert.equal(f.pipeline.state, 'disposed');
  });
}

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

const display = (f, id = 'transcript') => domText(f.session.view.displays[id]) || '';
for (const direction of ['ja-en', 'en-ja']) for (const original of [false, true]) test(`${direction}: live committed formatting appends repeated phrases once, drains Stop and starts fresh (${original})`, async () => {
  const f = sessionFixture(), graph = defaultGraph({ enabled: true, direction });
  if (!original) { graph.nodes = graph.nodes.filter(n => n.id !== 'transcript'); graph.edges = graph.edges.filter(e => e.to[0] !== 'transcript'); }
  graph.edges.reverse(); f.session.setGraph(addDOMFormatters(graph)); await f.session.start(42);
  const speech = f.session.session.speechNodes.get('speech');
  speech.receiveEvent({ type: 'partial', text: 'uncommitted', id: 0 }); await tick();
  assert.equal(f.translation.requests.length, 0); assert.deepEqual(display(f, 'translated'), '');
  speech.receiveEvent({ type: 'final', text: 'same', id: 0 }); speech.receiveEvent({ type: 'final', text: 'same', id: 1 }); await tick();
  assert.deepEqual(display(f, 'translated'), [].join('\n'), 'pending is represented by runtime status, not history rows');
  const stopping = f.session.stop(); await tick();
  f.translation.complete(0, 'first'); await tick(); f.translation.complete(1, 'second'); await stopping;
  const labels = direction === 'en-ja' ? ['English', 'Japanese'] : ['Japanese', 'English'];
  assert.deepEqual(display(f, 'translated'), ['first', 'second'].map(t => `same\n${t}`).join('\n'));
  assert.deepEqual(display(f), original ? 'same\nsame' : ''); assert.ok(f.translation.workers.every(w => w.terminated));
  await f.session.start(42); assert.deepEqual(display(f, 'translated'), [].join('\n'));
  speech.receiveEvent({ type: 'final', text: 'old session', id: 5 }); f.translation.complete(1, 'late'); await tick();
  assert.deepEqual(display(f, 'translated'), [].join('\n')); f.session.cancel();
});

for (const direction of ['ja-en', 'en-ja']) for (const port of ['content']) test(`${direction}: completed TEXT feeds a direct ${port} sink`, async () => {
  const f = sessionFixture(), graph = defaultGraph({ enabled: true, direction });
  graph.nodes = graph.nodes.filter(n => n.id !== 'translated-format'); graph.edges = graph.edges.filter(e => e.to[0] !== 'translated-format' && e.from[0] !== 'translated-format');
  graph.edges = graph.edges.filter(e => e.to[0] !== 'translated'); graph.edges.push(edge('translation', 'text', 'translated', port)); f.session.setGraph(addDOMFormatters(graph)); await f.session.start(42);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'source' }); await tick(); f.translation.complete(0, 'translated'); await tick();
  assert.deepEqual(display(f, 'translated'), 'translated');
  await f.session.stop(); await f.session.start(42); assert.deepEqual(display(f, 'translated'), ''); f.session.cancel();
});

test('Cancel adds no pending history; failed committed results remain readable and contain no stale translation', async () => {
  const f = sessionFixture(); f.session.setTranslation(true); await f.session.start(42);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'pending', id: 0 }); await tick();
  f.session.cancel(); f.translation.complete(0, 'late'); await tick(); assert.deepEqual(display(f, 'translated'), [].join('\n'));
  f.session.prepareTranslation = async () => { throw Error('cache unavailable'); }; await f.session.start(42);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'failed', id: 0 }); await tick(); await f.session.stop();
  assert.deepEqual(display(f, 'translated'), ['failed\nTranslation failed: cache unavailable'].join('\n'));
  assert.deepEqual(display(f), ['failed'].join('\n'));
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

test('multiple translator runtime statuses retain each branch failure independently of Live labels', async () => {
  const f = sessionFixture(), graph = defaultGraph({ enabled: true });
  graph.nodes.push(graphNode('OpusMtEnJa', 'reverse'), graphNode('LiveTextDisplay', 'reverse-display'));
  graph.edges.push(edge('speech', 'final', 'reverse', 'text'), edge('reverse', 'text', 'reverse-display', 'content'));
  f.session.prepareTranslation = async (signal, direction) => { if (direction === 'ja-en') throw Error('Forward cache unavailable'); };
  f.session.setGraph(addDOMFormatters(graph)); await f.session.start(42); await tick();
  assert.match(f.session.view.translationStatus, /translation: Translation unavailable: Forward cache unavailable/);
  assert.match(f.session.view.translationStatus, /reverse: Local OPUS-MT ready/);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'Hello' }); await tick();
  f.translation.complete(0, 'こんにちは'); await tick(); await f.session.stop();
  assert.match(display(f, 'translated'), /Forward cache unavailable/);
  assert.deepEqual(display(f, 'reverse-display'), ['こんにちは'].join('\n'));
});


test('empty committed input is a successful empty value even when model preparation failed', async () => {
  const f = await schedulerGraph({ prepare: async () => { throw Error('missing'); } });
  f.send(''); f.send('  '); f.send('failed'); await f.pipeline.stop();
  assert.deepEqual(f.outputs, [{ source: '', text: '', error: '' }, { source: '  ', text: '', error: '' }, { source: 'failed', error: 'missing' }]);
  assert.equal(f.workers.length, 0); await f.pipeline.dispose();
});

test('saved label/direction changes apply only to fresh Nodes and keep the active graph immutable', async () => {
  const f = sessionFixture(); f.session.setGraph(defaultGraph({ enabled: true, direction: 'en-ja' })); await f.session.start(42);
  const active = f.session.view.activeGraph;
  const next = defaultGraph({ enabled: true, direction: 'ja-en' });
  next.nodes.find(n => n.id === 'translated').settings.label = 'New comparison'; f.session.setGraph(next);
  assert.equal(f.session.view.activeGraph, active);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'Hello' }); await tick();
  f.translation.complete(0, 'こんにちは'); await f.session.stop();
  assert.deepEqual(display(f, 'translated'), ['Hello\nこんにちは'].join('\n'));
  await f.session.start(42); assert.deepEqual(display(f, 'translated'), [].join('\n'));
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: '日本語' }); await tick();
  f.translation.complete(1, 'Japanese'); await f.session.stop();
  assert.deepEqual(display(f, 'translated'), ['日本語\nJapanese'].join('\n'));
});


test('optional error wire is not required to clear a previous translation in the direct formatter', async () => {
  const f = await schedulerGraph({ includeError: false }); f.send('one'); f.send('x'.repeat(1001)); await tick();
  f.complete(0, 'previous translation'); await f.pipeline.stop();
  assert.equal(f.formatted[0], 'one|previous translation|');
  assert.equal(f.formatted[1], 'x'.repeat(1001) + '||');
  assert.deepEqual(f.plain, ['previous translation']); await f.pipeline.dispose();
});
