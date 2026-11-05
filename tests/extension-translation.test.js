import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, TextOutputNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';
import { OPUS_MT, OPUS_MT_EN_JA } from '../web/translation-models.js';
import { TranslationSchedulerNode, TRANSLATION_OUTPUTS } from '../extension/translation-scheduler.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph, graphNode, edge, NODE_TYPES } from '../extension/graph.js';
import { defineAssetSet, HASH_CHUNK_BYTES } from '../extension/model-asset-cache.js';
import { TextAccumulatorNode, TextFormatterNode } from '../web/text-nodes.js';

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
  let emit, emitOutputs;
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.workerFactory, prepare: options.prepare,
    TranslationNode: { 'en-ja': EnglishToJapaneseOpusMtTranslationNode, 'gemma-en-ja': EnglishToJapaneseTranslateGemmaTranslationNode, 'gemma-ja-en': TranslateGemmaTranslationNode }[options.direction],
    modelName: options.direction?.startsWith('gemma') ? 'TranslateGemma 4B' : 'OPUS-MT',
    onState: state => states.push(state) });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { text: TEXT, provisional: TEXT, context: TEXT }, start(c) { emit = c.emit; emitOutputs = c.emitOutputs; } }, scheduler,
    sink: { inputs: TRANSLATION_OUTPUTS, async receiveInputs(values) { await options.receiveInputs?.(values); outputs.push(values); } },
    plain: new TextOutputNode(text => plain.push(text)),
    formatter: new TextFormatterNode({ inputCount: 3, template: '{1}|{2}|{3}' }),
    formatted: new TextOutputNode(text => formatted.push(text)),
  }, connections: [edge('source', 'text', 'scheduler', 'text'), edge('source', 'provisional', 'scheduler', 'provisional'),
    ...(scheduler.acceptsContext ? [edge('source', 'context', 'scheduler', 'context')] : []),
    ...Object.keys(TRANSLATION_OUTPUTS).map(port => edge('scheduler', port, 'sink', port)),
    ...['source', 'text', 'error'].map((port, index) => edge('scheduler', port, 'formatter', `input${index + 1}`)).filter(route => options.includeError !== false || route.from[1] !== 'error'), edge('scheduler', 'text', 'plain', 'text'),
    edge('formatter', 'text', 'formatted', 'text')] });
  await pipeline.start();
  return { ...f, pipeline, scheduler, outputs, states, plain, formatted, send: text => emit('text', text), preview: text => emit('provisional', text),
    setContext: text => emit('context', text), emitOutputs };
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
    assert.deepEqual(Object.keys(f.scheduler.inputs), direction.startsWith('gemma') ? ['text', 'provisional', 'id', 'provisionalId', 'context'] : ['text', 'provisional', 'id', 'provisionalId']);
    assert.deepEqual(Object.keys(f.scheduler.outputs), Object.keys(TRANSLATION_OUTPUTS));
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
    assert.ok(f.states.some(state => state.includes('Translation unavailable:') && state.includes(f.outputs[0].error)), 'specific failure reaches diagnostics without a formatter error wire');
    assert.ok(f.workers.every(w => w.terminated)); await f.pipeline.dispose();
  });
  test(`${direction}: a recoverable per-utterance error clears stale translation and preserves later successful routing`, async () => {
    const f = await graph(); f.send('first'); f.send('x'.repeat(1001)); f.send('last'); await tick();
    f.complete(0, 'translated first'); await tick();
    assert.match(f.formatted[1], /\|\|(?:OPUS-MT|TranslateGemma 4B) accepts/);
    assert.doesNotMatch(f.formatted[1], /translated first/);
    assert.ok(f.states.some(state => /Translation unavailable: .*accepts at most 1,000/.test(state)));
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
  graph.nodes.push(graphNode('OpusMtEnJa', 'reverse'), graphNode('Display', 'reverse-display'));
  graph.edges.push(edge('speech', 'final', 'reverse', 'text'), edge('reverse', 'text', 'reverse-display', 'input1'));
  f.session.prepareTranslation = async (signal, direction) => { if (direction === 'ja-en') throw Error('Forward cache unavailable'); };
  f.session.setGraph((graph)); await f.session.start(42); await tick();
  assert.match(f.session.view.translationStatus, /translation: Translation unavailable: Forward cache unavailable/);
  assert.match(f.session.view.translationStatus, /reverse: Local OPUS-MT ready/);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'Hello' }); await tick();
  f.translation.complete(0, 'こんにちは'); await tick(); await f.session.stop();
  assert.equal(display(f), 'Hello');
  assert.match(f.session.view.translationStatus, /Forward cache unavailable/);
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
  next.nodes.find(n => n.id === 'transcript').position.x += 10; f.session.setGraph(next);
  assert.equal(f.session.view.activeGraph, active);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'Hello' }); await tick();
  f.translation.complete(0, 'こんにちは'); await f.session.stop();
  assert.deepEqual(display(f), ['Hello\nこんにちは'].join('\n'));
  await f.session.start(42); assert.deepEqual(display(f), [].join('\n'));
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', text: '日本語' }); await tick();
  f.translation.complete(1, 'Japanese'); await f.session.stop();
  assert.deepEqual(display(f), ['日本語\nJapanese'].join('\n'));
});


test('optional error wire is not required to clear a previous translation in the direct formatter', async () => {
  const f = await schedulerGraph({ includeError: false }); f.send('one'); f.send('x'.repeat(1001)); await tick();
  f.complete(0, 'previous translation'); await f.pipeline.stop();
  assert.equal(f.formatted[0], 'one|previous translation|');
  assert.equal(f.formatted[1], 'x'.repeat(1001) + '||');
  assert.deepEqual(f.plain, ['previous translation']); await f.pipeline.dispose();
});

for (const direction of ['ja-en', 'en-ja', 'gemma-en-ja', 'gemma-ja-en']) {
  test(`${direction}: explicit preview family replaces, clears on final acceptance, and shares one priority FIFO Worker`, async () => {
    const f = await schedulerGraph({ direction });
    f.preview('old'); await tick();
    f.preview('new'); f.preview('latest'); await tick();
    assert.equal(f.scheduler.preview.source, 'latest');
    assert.equal(f.requests.length, 1);
    f.complete(0, 'stale'); await tick();
    assert.deepEqual(f.outputs, []);
    f.complete(1, 'visible preview'); await tick();
    assert.deepEqual(f.outputs, [{ provisionalSource: 'latest', provisionalText: 'visible preview', provisionalError: '' }]);
    assert.deepEqual(f.plain, []); assert.deepEqual(f.formatted, []);
    f.preview('in flight'); await tick();
    f.send('same'); f.send('same'); f.preview('pending'); f.preview('last preview'); await tick();
    assert.deepEqual(f.outputs.at(-1), { provisionalSource: '', provisionalText: '', provisionalError: '' });
    f.complete(2, 'late after final'); await tick();
    assert.equal(f.requests[3].text, 'same');
    // A duplicate obsolete reply cannot resolve the active committed request.
    f.complete(2, 'duplicate'); await tick(); assert.deepEqual(f.plain, []);
    f.complete(3, 'first'); await tick(); assert.equal(f.requests[4].text, 'same');
    f.complete(4, 'second'); await tick(); assert.equal(f.requests[5].text, 'last preview');
    f.complete(5, 'new preview'); await tick();
    assert.deepEqual(f.plain, ['first', 'second']);
    assert.deepEqual(f.outputs.at(-1), { provisionalSource: 'last preview', provisionalText: 'new preview', provisionalError: '' });
    await f.pipeline.stop();
    assert.deepEqual(f.outputs.at(-1), { provisionalSource: '', provisionalText: '', provisionalError: '' });
    assert.equal(f.workers.length, 1);
    assert.deepEqual(f.pipeline.errors, []); await f.pipeline.dispose();
    assert.ok(f.workers[0].terminated);
  });
  for (const kind of ['empty', 'whitespace', 'failure', 'missing result', 'preparation']) test(`${direction}: preview ${kind} stays in its atomic family`, async () => {
    const f = await schedulerGraph({ direction, empty: kind === 'missing result', failTranslate: kind === 'failure',
      prepare: kind === 'preparation' ? async () => { throw Error('missing preview assets'); } : undefined });
    const source = kind === 'empty' ? '' : kind === 'whitespace' ? '  ' : 'draft';
    f.preview(source); await tick();
    if (f.requests.length) { f.complete(0); await tick(); }
    assert.deepEqual(f.plain, []); assert.deepEqual(f.formatted, []);
    assert.equal(f.outputs.length, 1);
    const result = f.outputs[0]; assert.equal(result.provisionalSource, source);
    if (['empty', 'whitespace'].includes(kind)) {
      assert.deepEqual(result, { provisionalSource: source, provisionalText: '', provisionalError: '' });
      assert.equal(f.requests.length, 0);
    } else {
      assert.ok(result.provisionalError); assert.equal(Object.hasOwn(result, 'provisionalText'), false);
      assert.ok(f.states.some(s => s.startsWith('Translation unavailable:')));
    }
    await f.pipeline.dispose();
  });
  for (const ending of ['stop', 'cancel']) test(`${direction}: ${ending} clears explicit preview, ignores late completions, and a fresh runtime restarts`, async () => {
    const f = await schedulerGraph({ direction });
    f.preview('shown'); await tick(); f.complete(0, 'shown translation'); await tick();
    f.preview('running'); await tick(); f.preview('discard pending'); await tick();
    const ended = f.pipeline[ending](); await tick();
    assert.deepEqual(f.outputs.at(-1), { provisionalSource: '', provisionalText: '', provisionalError: '' });
    f.complete(1, 'late'); await ended; await f.pipeline.dispose();
    assert.equal(f.requests.length, 2); assert.deepEqual(f.plain, []);
    const next = await schedulerGraph({ direction });
    f.complete(1, 'late after restart'); next.send('fresh'); await tick(); next.complete(0, 'new'); await next.pipeline.stop();
    assert.deepEqual(next.plain, ['new']); await next.pipeline.dispose();
  });
}

test('independent atomic output families clear omitted siblings without clearing the other family at a shared formatter', async () => {
  const f = workerFixture(), values = []; let source;
  const scheduler = new TranslationSchedulerNode({ workerFactory: f.workerFactory });
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { final: TEXT, draft: TEXT }, start(c) { source = c; } }, scheduler,
    formatter: new TextFormatterNode({ inputCount: 4, template: '{1}|{2}|{3}|{4}' }),
    sink: new TextOutputNode(value => values.push(value)),
  }, connections: [edge('source', 'final', 'scheduler', 'text'), edge('source', 'draft', 'scheduler', 'provisional'),
    ...['source', 'text', 'provisionalSource', 'provisionalText'].map((port, i) => edge('scheduler', port, 'formatter', `input${i + 1}`)),
    edge('formatter', 'text', 'sink', 'text')] });
  await pipeline.start(); source.emit('final', 'committed'); await tick(); f.complete(0, 'keep'); await tick();
  source.emit('draft', 'draft'); await tick(); f.complete(1, 'preview'); await tick();
  assert.equal(values.at(-1), 'committed|keep|draft|preview');
  source.emit('draft', 'failed draft'); await tick();
  const r = f.requests[2]; r.worker.reply({ id: r.id, type: 'error', message: 'failed' }); await tick();
  assert.equal(values.at(-1), 'committed|keep|failed draft|');
  await pipeline.stop(); assert.equal(values.at(-1), 'committed|keep||'); await pipeline.dispose();
});

for (const direction of ['ja-en', 'en-ja', 'gemma-en-ja', 'gemma-ja-en']) {
  for (const phase of ['prepare', 'load']) test(`${direction}: Cancel during preview ${phase} clears only the preview route and suppresses late startup`, async () => {
    let finish;
    const f = await schedulerGraph({ direction, holdLoad: phase === 'load',
      prepare: phase === 'prepare' ? () => new Promise(resolve => { finish = resolve; }) : undefined });
    f.preview('old'); f.preview('latest'); await tick();
    await f.pipeline.cancel();
    if (finish) finish(); else f.workers[0].reply({ type: 'ready', id: 1 });
    await tick();
    assert.deepEqual(f.outputs, [{ provisionalSource: '', provisionalText: '', provisionalError: '' }]);
    assert.deepEqual(f.plain, []); assert.deepEqual(f.requests, []);
    assert.ok(f.workers.every(w => w.terminated));
  });
}

for (const direction of ['gemma-en-ja', 'gemma-ja-en']) {
  test(`${direction}: context-only updates, grouped snapshots, FIFO and explicit empty reset`, async () => {
    const f = await schedulerGraph({ direction, holdLoad: true });
    f.send('default'); f.setContext('first context'); f.send('one');
    f.emitOutputs({ text: 'two', provisional: 'ignored', context: 'grouped context' });
    f.setContext(''); f.send('reset'); f.setContext('later context'); await tick();
    assert.equal(f.requests.length, 0);
    f.workers[0].reply({ type: 'ready', id: 1 }); await tick();
    for (const [i, [text, context]] of [['default', undefined], ['one', 'first context'], ['two', 'grouped context'], ['reset', undefined]].entries()) {
      assert.equal(f.requests[i].text, text); assert.equal(f.requests[i].context, context);
      f.complete(i, 'translated ' + text); await tick();
    }
    assert.deepEqual(f.plain, ['translated default', 'translated one', 'translated two', 'translated reset']);
    assert.equal(f.requests.length, 4, 'context-only updates never infer');
    await f.pipeline.stop(); assert.equal(f.scheduler.translationContext, '');
    assert.deepEqual(f.pipeline.errors, []); await f.pipeline.dispose();
  });
  test(`${direction}: context updates keep preview snapshots, replacement and committed priority`, async () => {
    const f = await schedulerGraph({ direction });
    f.setContext('old'); f.preview('running preview'); await tick();
    f.setContext('new'); f.preview('replaced'); f.setContext('latest'); f.preview('latest preview'); await tick();
    f.complete(0, 'stale'); await tick();
    assert.deepEqual(f.outputs, []); assert.equal(f.requests[1].context, 'latest');
    f.setContext('changed while running'); await tick(); f.complete(1, 'visible'); await tick();
    assert.equal(f.outputs.at(-1).provisionalText, 'visible', 'context alone does not invalidate or revive previews');
    f.preview('obsolete'); await tick();
    f.setContext('committed'); f.send('final'); f.setContext('pending'); f.preview('pending preview'); f.setContext('future'); await tick();
    assert.equal(f.outputs.at(-1).provisionalText, '');
    f.complete(2, 'obsolete output'); await tick();
    assert.equal(f.requests[3].text, 'final'); assert.equal(f.requests[3].context, 'committed');
    f.complete(3, 'committed output'); await tick();
    assert.equal(f.requests[4].text, 'pending preview'); assert.equal(f.requests[4].context, 'pending');
    f.complete(4, 'preview output'); await tick();
    assert.deepEqual(f.plain, ['committed output']); assert.equal(f.outputs.at(-1).provisionalText, 'preview output');
    await f.pipeline.stop(); await f.pipeline.dispose();
    assert.equal(f.workers.length, 1); assert.ok(f.workers[0].terminated);
  });
  test(`${direction}: Stop drains queued context snapshots before clearing session state`, async () => {
    const f = await schedulerGraph({ direction });
    f.setContext('one context'); f.send('one'); f.setContext('two context'); f.send('two');
    f.setContext(''); f.send('three'); await tick();
    const stopping = f.pipeline.stop(); await tick();
    for (const [i, context] of ['one context', 'two context', undefined].entries()) {
      assert.equal(f.requests[i].context, context); f.complete(i, 'translated ' + i); await tick();
    }
    await stopping;
    assert.deepEqual(f.plain, ['translated 0', 'translated 1', 'translated 2']);
    assert.equal(f.scheduler.translationContext, ''); await f.pipeline.dispose();
  });
  for (const phase of ['prepare', 'load', 'inference']) test(`${direction}: Cancel during ${phase} discards context, jobs and late replies`, async () => {
    let finish;
    const f = await schedulerGraph({ direction, holdLoad: phase === 'load',
      prepare: phase === 'prepare' ? () => new Promise(resolve => { finish = resolve; }) : undefined });
    f.setContext('private session context'); f.preview('preview'); f.send('committed'); await tick();
    await f.pipeline.cancel();
    assert.equal(f.scheduler.translationContext, ''); assert.deepEqual(f.scheduler.finals, []);
    const outputs = [...f.outputs];
    if (finish) finish(); else if (phase === 'load') f.workers[0].reply({ type: 'ready', id: 1 }); else f.complete(0, 'late');
    f.setContext('late context'); await tick(); assert.deepEqual(f.outputs, outputs);
    assert.ok(f.workers.every(w => w.terminated));
    const next = await schedulerGraph({ direction }); next.send('fresh'); await tick();
    assert.equal(next.requests[0].context, undefined); next.complete(0, 'fresh output'); await next.pipeline.stop(); await next.pipeline.dispose();
  });
  test(`${direction}: context is bounded before storage and invalid updates report an explicit failure`, async () => {
    const f = await schedulerGraph({ direction });
    f.setContext('x'.repeat(4000)); await tick(); assert.equal(f.scheduler.translationContext.length, 4000);
    f.setContext('x'.repeat(4001)); await tick();
    assert.match(f.pipeline.errors[0].message, /context accepts at most 4,000/);
    assert.equal(f.requests.length, 0); await f.pipeline.dispose(); assert.equal(f.scheduler.translationContext, '');
  });
}

test('OPUS-MT has no context capability', () => {
  for (const type of ['OpusMtJaEn', 'OpusMtEnJa']) assert.equal(Object.hasOwn(NODE_TYPES[type].inputs, 'context'), false);
  const node = new TranslationSchedulerNode();
  assert.throws(() => node.receive('context', 'unused'), /Expected TEXT/);
});
