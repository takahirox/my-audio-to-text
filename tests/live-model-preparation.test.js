import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabSession } from '../extension/session.js';
import { graphNode, edge, GRAPH_VERSION, defaultGraph } from '../extension/graph.js';
import { watchGpuDevice } from '../web/gpu-lifecycle.js';
import { domText } from './fixtures/dom.js';

const turn = () => new Promise(resolve => setImmediate(resolve));
function textGraph(type = 'TextSummaryLfm2', gated = false) {
  const source = graphNode('Text', 'source'); source.settings.value = 'Evidence';
  const nodes = [source, graphNode(type, 'model'), graphNode('Display', 'display')];
  const edges = [edge('source', 'value', 'model', 'text'), edge('model', type === 'IfCondition' ? 'yes' : 'summary', 'display', 'input1')];
  if (gated) {
    nodes.push(graphNode('Button', 'button'), graphNode('Hold', 'held'));
    edges[0] = edge('source', 'value', 'held', 'input');
    edges.push(edge('button', 'trigger', 'held', 'trigger'), edge('held', 'value', 'model', 'text'));
  }
  return { version: GRAPH_VERSION, nodes, edges };
}
function fixture(graph, options = {}) {
  const workers = [], captures = [], outputs = [], controls = { hold: false, failure: false }, views = [];
  const workerFactory = url => {
    const worker = { url: String(url), messages: [], released: false,
      terminate() { this.released = true; },
      reply(data) {
        if (data.type === 'load') this.onmessage?.({ data: { id: data.id, type: controls.failure ? 'error' : 'ready', message: 'Controlled model memory failure' } });
        if (data.type === 'summarize') this.onmessage?.({ data: { id: data.id, type: 'result', summary: 'Summary' } });
        if (data.type === 'decide') this.onmessage?.({ data: { id: data.id, type: 'result', branch: 'yes' } });
        if (data.type === 'translate') this.onmessage?.({ data: { id: data.id, type: 'result', texts: ['Translation'] } });
        if (data.type === 'generate') this.onmessage?.({ data: { id: data.id, type: 'result', audio: { samples: new Float32Array(10), sampleRate: 24000, channels: 1 } } });
        if (data.type === 'drain') this.onmessage?.({ data: { id: data.id, type: 'drained' } });
        if (data.type === 'vad-stop') this.onmessage?.({ data: { session: data.session, type: 'vad-stopped' } });
      },
      postMessage(data) {
        this.messages.push(data);
        if (controls.hold && data.type === 'load') return;
        queueMicrotask(() => this.reply(data));
      },
    };
    workers.push(worker); return worker;
  };
  const session = new TabSession(view => views.push(view), { graph, workerFactory, whisperWorkerFactory: workerFactory,
    textSummaryWorkerFactory: workerFactory, ifConditionWorkerFactory: workerFactory, translationWorkerFactory: workerFactory,
    ttsWorkerFactory: workerFactory, prepareTranslation: async () => {}, prepareTts: async () => {},
    sourceFactory: id => ({ start() { captures.push(id); }, stop() {} }),
    onSynthesizedAudio: audio => outputs.push(audio), ...options });
  const messages = type => workers.flatMap(worker => worker.messages.filter(message => message.type === type));
  return { session, workers, captures, outputs, controls, views, messages };
}

test('hand-triggered summary is genuinely warm before Start; first Button action uses the same Worker', async t => {
  const f = fixture(textGraph('TextSummaryLfm2', true)); t.after(() => f.session.close());
  f.controls.hold = true;
  const preparing = f.session.prepareModels(); await turn();
  assert.equal(f.session.view.modelState, 'preparing');
  assert.match(f.session.view.modelStatus, /Preparing models…/);
  await f.session.start(); assert.equal(f.session.session, undefined);
  assert.equal(f.workers.length, 1); assert.equal(f.messages('load').length, 1);
  assert.equal(f.messages('summarize').length, 0); assert.deepEqual(f.session.view.displays, {});
  f.workers[0].reply(f.workers[0].messages[0]); await preparing;
  const runtime = f.session.prepared.pipeline, worker = f.workers[0];
  assert.equal(f.session.view.modelState, 'ready'); assert.equal(runtime.state, 'idle');
  await f.session.start(); await turn();
  assert.equal(f.session.session.pipeline, runtime); assert.equal(f.workers[0], worker);
  assert.equal(f.messages('load').length, 1); assert.equal(f.messages('summarize').length, 0);
  assert.equal(await f.session.pressButton('button'), true);
  assert.equal(f.messages('summarize').length, 1); assert.equal(f.messages('load').length, 1);
  assert.equal(domText(f.session.view.displays.display.input1), 'Summary');
  f.controls.hold = false;
  await f.session.stop();
  assert.equal(worker.released, true); assert.equal(f.session.view.modelState, 'ready');
  assert.equal(f.workers.length, 2); assert.equal(f.messages('summarize').length, 1);
});

test('multi-model graph initializes every executable instance without inference/output; parked models stay inert', async t => {
  const graph = textGraph();
  for (const type of ['TextSummaryQwen35', 'IfCondition', 'OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa', 'Supertonic3', 'Kokoro', 'Qwen3TtsStreaming', 'CosyVoice3Streaming']) {
    graph.nodes.push(graphNode(type, type));
    graph.edges.push(edge('source', 'value', type, 'text'));
    const output = ['Supertonic3', 'Kokoro'].includes(type) ? 'audio' : type.endsWith('Streaming') ? 'stream' : type === 'IfCondition' ? 'yes' : type.startsWith('TextSummary') ? 'summary' : 'text';
    const sink = output === 'audio' ? 'AudioOutput' : output === 'stream' ? 'StreamingSpeakerOutput' : 'Display';
    graph.nodes.push(graphNode(sink, type + '-out'));
    graph.edges.push(edge(type, output, type + '-out', sink === 'Display' ? 'input1' : output));
  }
  graph.nodes.push(graphNode('TextSummaryLfm2', 'parked'), graphNode('MicrophoneAudio', 'parked-mic'));
  const f = fixture(graph, { prepareTranslateGemma: async () => {} }); t.after(() => f.session.close());
  await f.session.prepareModels();
  assert.equal(f.session.view.error, ''); assert.equal(f.session.view.modelState, 'ready');
  assert.equal(f.workers.length, 11); assert.equal(f.messages('load').length, 11);
  assert.deepEqual([...new Set(f.workers.flatMap(worker => worker.messages.map(message => message.type)))], ['load']);
  assert.deepEqual(f.outputs, []); assert.deepEqual(f.captures, []); assert.deepEqual(f.session.view.displays, {});
  assert.equal(f.session.prepared.pipeline.entries.has('parked'), false);
  assert.equal(f.session.prepared.pipeline.entries.has('parked-mic'), false);
});

for (const type of ['SpeechToTextWhisper', 'SpeechToTextReazonSpeech']) test(`${type} startup constant precedes initialization, without starting ASR or capture`, async t => {
  const graph = defaultGraph({ enabled: true });
  graph.nodes.find(node => node.id === 'speech').type = type;
  if (type === 'SpeechToTextWhisper') graph.edges = graph.edges.filter(route => route.from[1] !== 'provisional' && route.from[1] !== 'provisionalId');
  const constant = graphNode(type === 'SpeechToTextWhisper' ? 'Text' : 'Number', 'config');
  constant.settings.value = type === 'SpeechToTextWhisper' ? 'ja' : 2.5;
  graph.nodes.push(constant); graph.edges.push(edge('config', 'value', 'speech', type === 'SpeechToTextWhisper' ? 'language' : 'maxDuration'));
  const f = fixture(graph); t.after(() => f.session.close());
  await f.session.prepareModels();
  assert.equal(f.session.view.error, ''); assert.equal(f.session.view.modelState, 'ready');
  const speech = f.session.prepared.speechNodes.get('speech');
  assert.equal(speech.core.state, 'ready'); assert.deepEqual(f.captures, []);
  assert.equal(f.messages('vad-start').length, 0); assert.equal(f.messages('translate').length, 0);
  if (type === 'SpeechToTextWhisper') assert.equal(f.workers.find(worker => worker.url.includes('whisper')).messages[0].language, 'ja');
  else assert.equal(speech.maxDuration, 2.5);
  const count = f.workers.length;
  await f.session.start(42); await turn();
  assert.equal(f.session.view.state, 'running'); assert.equal(f.workers.length, count); assert.equal(speech.core.state, 'running');
  assert.deepEqual(f.captures, [42]); assert.equal(speech.sessionMaxDuration, type === 'SpeechToTextWhisper' ? 6 : 2.5);
  assert.equal(f.session.session.pipeline.errors.length, 0);
});

test('a graph without AI becomes ready without starting constants or outputs', async t => {
  const graph = textGraph(); graph.nodes = graph.nodes.filter(node => node.id !== 'model'); graph.edges = [edge('source', 'value', 'display', 'input1')];
  const f = fixture(graph); t.after(() => f.session.close());
  await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
  assert.deepEqual(f.workers, []); assert.deepEqual(f.session.view.displays, {});
  await f.session.start(); await turn(); assert.equal(domText(f.session.view.displays.display.input1), 'Evidence');
});

test('saved changes during preparation dispose obsolete Workers and reject late readiness', async t => {
  const f = fixture(textGraph()); t.after(() => f.session.close());
  f.controls.hold = true;
  const old = f.session.prepareModels(); await turn();
  const worker = f.workers[0], stale = worker.onmessage;
  f.session.setGraph(textGraph('IfCondition')); await turn();
  assert.equal(worker.released, true); assert.equal(f.workers.length, 2);
  stale({ data: { id: 1, type: 'ready' } }); await old;
  assert.equal(f.session.view.modelState, 'preparing');
  f.workers[1].reply(f.workers[1].messages[0]); await f.session.preparing;
  assert.equal(f.session.view.modelState, 'ready');
  assert.equal(f.session.prepared.description.nodes.find(node => node.id === 'model').type, 'IfCondition');
});

test('saved edits never hot-swap an active graph; Stop prepares the latest saved graph', async t => {
  const f = fixture(textGraph('TextSummaryLfm2', true)); t.after(() => f.session.close());
  await f.session.prepareModels(); await f.session.start();
  const owner = f.session.session;
  f.session.setGraph(textGraph('IfCondition'));
  assert.equal(f.session.session, owner); assert.equal(f.workers.length, 1);
  await f.session.stop(); assert.equal(f.session.view.modelState, 'ready');
  assert.equal(f.session.prepared.description.nodes.find(node => node.id === 'model').type, 'IfCondition');
});

test('repeated Start/Stop/Cancel/close release each owner; concurrent prepares and Starts allocate only once', async () => {
  const f = fixture(textGraph('TextSummaryLfm2', true));
  const first = f.session.prepareModels(); assert.equal(f.session.prepareModels(), first); await first;
  for (const end of ['stop', 'cancel', 'stop']) {
    const before = f.workers.length, owner = f.session.prepared;
    await Promise.all([f.session.start(), f.session.start()]);
    assert.equal(f.session.session, owner); assert.equal(f.workers.length, before);
    await f.session[end]();
    assert.equal(f.session.view.modelState, 'ready');
    assert.equal(f.workers.filter(worker => !worker.released).length, 1);
  }
  await f.session.close(); assert.equal(f.session.view.modelState, 'closed'); assert.ok(f.workers.every(worker => worker.released));
  await f.session.start(); await f.session.prepareModels(); assert.equal(f.workers.length, 4);
});

for (const end of ['stop', 'cancel', 'close']) test(`${end} while preparing aborts pending load and cannot publish stale Ready`, async () => {
  const f = fixture(textGraph()); f.controls.hold = true;
  const preparing = f.session.prepareModels(); await turn();
  const worker = f.workers[0], stale = worker.onmessage;
  await f.session[end](); await preparing;
  stale({ data: { id: 1, type: 'ready' } });
  assert.equal(worker.released, true); assert.equal(f.session.view.modelState, end === 'close' ? 'closed' : 'canceled');
  if (end !== 'close') {
    f.controls.hold = false; await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
  }
  await f.session.close();
});

test('load failure blocks the whole Live graph and retry recovers without hiding the per-Node error', async t => {
  const f = fixture(textGraph()); t.after(() => f.session.close()); f.controls.failure = true;
  await f.session.prepareModels();
  assert.equal(f.session.view.modelState, 'error'); assert.match(f.session.view.error, /model.*memory failure/);
  assert.match(f.session.view.error, /Save.*Models.*Retry models/); assert.equal(f.session.view.modelRecovery, true);
  assert.ok(f.workers.every(worker => worker.released)); await f.session.start(); assert.equal(f.session.session, undefined);
  f.controls.failure = false; await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
});

test('model timeout releases pending initialization and permits retry', async t => {
  const f = fixture(textGraph(), { modelLoadTimeoutMs: 5 }); t.after(() => f.session.close()); f.controls.hold = true;
  await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'error'); assert.match(f.session.view.error, /timed out/);
  assert.ok(f.workers.every(worker => worker.released));
  f.controls.hold = false; await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
});

test('idle GPU/Worker failure invalidates Ready and releases all models', async t => {
  const f = fixture(textGraph()); t.after(() => f.session.close());
  await f.session.prepareModels(); f.workers[0].onmessage({ data: { type: 'error', fatal: true, message: 'GPU device lost' } }); await turn();
  assert.equal(f.session.view.modelState, 'error'); assert.match(f.session.view.error, /GPU device lost/); assert.ok(f.workers.every(worker => worker.released));
  await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
});

test('missing/evicted assets block readiness without capture, Worker allocation or automatic download/retry', async t => {
  let inspections = 0;
  const graph = defaultGraph({ enabled: true });
  const f = fixture(graph, { prepareTranslation: async () => { inspections++; throw Error('Translation files missing or corrupt.'); } });
  t.after(() => f.session.close());
  await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'error');
  assert.match(f.session.view.error, /translation.*files missing or corrupt/);
  assert.equal(inspections, 1); assert.deepEqual(f.captures, []);
  assert.ok(f.workers.every(worker => worker.released));
  await f.session.start(42); await turn(); assert.equal(inspections, 1);
});

test('ASR retains inactive configuration intent and accepts constant-fed formatting before model initialization', async t => {
  const graph = defaultGraph(); graph.nodes.find(node => node.id === 'speech').type = 'SpeechToTextWhisper';
  graph.edges = graph.edges.filter(route => !['provisional', 'provisionalId'].includes(route.from[1]));
  const language = graphNode('Text', 'language'); language.settings.value = 'ja';
  graph.nodes.push(language, graphNode('TextFormatter', 'format'));
  graph.edges.push(edge('language', 'value', 'format', 'input1'), edge('format', 'text', 'speech', 'language'));
  const f = fixture(graph); t.after(() => f.session.close());
  await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
  assert.equal(f.workers.find(worker => worker.url.includes('whisper')).messages[0].language, 'ja');
  await f.session.start(42); await turn(); assert.equal(f.session.session.pipeline.errors.length, 0);
  await f.session.stop();
  graph.nodes.push(graphNode('SpeechToTextWhisper', 'inactive'));
  graph.edges = graph.edges.filter(route => route.from[0] !== 'language');
  graph.edges.push(edge('inactive', 'final', 'format', 'input1'));
  const before = f.workers.length;
  f.session.setGraph(graph); await f.session.preparing;
  assert.equal(f.session.view.modelState, 'error'); assert.match(f.session.view.error, /speech.*Startup configuration is unavailable/);
  assert.equal(f.workers.length, before, 'must not initialize using the default language');
});

test('multiple same-model instances keep separate state and transfer each ready Worker once', async t => {
  const graph = textGraph('TextSummaryLfm2', true);
  graph.nodes.push(graphNode('TextSummaryLfm2', 'second'), graphNode('Display', 'second-display'));
  graph.edges.push(edge('held', 'value', 'second', 'text'), edge('second', 'summary', 'second-display', 'input1'));
  const f = fixture(graph); t.after(() => f.session.close());
  await f.session.prepareModels(); assert.equal(f.workers.length, 2);
  const first = f.session.prepared.pipeline.entries.get('model').node, second = f.session.prepared.pipeline.entries.get('second').node;
  assert.notEqual(first.worker, second.worker); assert.notEqual(first.pending, second.pending);
  await f.session.start(); await turn(); await f.session.pressButton('button');
  assert.equal(f.messages('load').length, 2); assert.equal(f.messages('summarize').length, 2);
});

for (const composed of ['KeyedTextCoalesce', 'TextFormatter', 'TextWindow']) test(`Whisper accepts startup ${composed} composition before one model load`, async t => {
  const graph = defaultGraph({ enabled: true });
  graph.nodes.find(node => node.id === 'speech').type = 'SpeechToTextWhisper';
  graph.edges = graph.edges.filter(route => !['provisional', 'provisionalId'].includes(route.from[1]));
  const language = graphNode('Text', 'language'); language.settings.value = 'ja';
  const other = graphNode(composed === 'TextFormatter' ? 'Text' : 'Number', 'other');
  other.settings.value = composed === 'TextFormatter' ? '' : composed === 'TextWindow' ? 0.005 : 1;
  const compose = graphNode(composed, 'compose');
  if (composed === 'TextFormatter') compose.settings.template = '{1}{2}';
  graph.nodes.push(language, other, compose, graphNode('Display', 'config-display'));
  graph.edges.push(edge('language', 'value', 'compose', composed === 'TextWindow' ? 'text' : 'input1'),
    edge('other', 'value', 'compose', composed === 'KeyedTextCoalesce' ? 'id1' : composed === 'TextWindow' ? 'maxWaitSeconds' : 'input2'),
    edge('compose', 'text', 'speech', 'language'), edge('compose', 'text', 'config-display', 'input1'));
  const f = fixture(graph); t.after(() => f.session.close());
  await f.session.prepareModels();
  assert.equal(f.session.view.error, ''); assert.equal(f.session.view.modelState, 'ready');
  const worker = f.workers.find(worker => worker.url.includes('whisper'));
  assert.equal(worker.messages[0].language, 'ja');
  assert.equal(worker.messages.filter(message => message.type === 'load').length, 1);
  assert.deepEqual(f.session.view.displays, {}); assert.deepEqual(f.captures, []);
  await f.session.start(42); await turn();
  if (composed === 'TextWindow') await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.session.view.state, 'running'); assert.equal(f.session.view.error, '');
  assert.equal(worker.messages.filter(message => message.type === 'load').length, 1);
  assert.equal(domText(f.session.view.displays['config-display'].input1), 'ja');
});

for (const close of [false, true]) test(`successive Saves retain pending teardown${close ? ' through close' : ' before Ready'}`, async () => {
  const f = fixture(textGraph());
  await f.session.prepareModels();
  const node = f.session.prepared.pipeline.entries.get('model').node;
  const dispose = node.dispose.bind(node); let release;
  node.dispose = () => new Promise(resolve => { release = () => { dispose(); resolve(); }; });
  f.session.setGraph(textGraph('IfCondition')); await turn();
  f.session.setGraph(textGraph('TextSummaryQwen35')); await turn();
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].released, false);
  assert.equal(f.session.view.modelState, 'preparing');
  let closed = false;
  const closing = close ? f.session.close().then(() => { closed = true; }) : null;
  await turn(); assert.equal(closed, false);
  release(); await f.session.preparing; await closing;
  assert.equal(f.workers[0].released, true);
  assert.equal(f.workers.length, close ? 1 : 2);
  assert.equal(f.session.view.modelState, close ? 'closed' : 'ready');
  await f.session.close(); assert.ok(f.workers.every(worker => worker.released));
});

test('ReazonSpeech receives a composed numeric startup output before loading', async t => {
  const graph = defaultGraph();
  const text = graphNode('Text', 'text'); text.settings.value = 'keyed value';
  const key = graphNode('Number', 'key'); key.settings.value = 2.5;
  graph.nodes.push(text, key, graphNode('KeyedTextCoalesce', 'compose'));
  graph.edges.push(edge('text', 'value', 'compose', 'input1'), edge('key', 'value', 'compose', 'id1'),
    edge('compose', 'id', 'speech', 'maxDuration'));
  const f = fixture(graph); t.after(() => f.session.close());
  await f.session.prepareModels();
  assert.equal(f.session.view.error, ''); assert.equal(f.session.view.modelState, 'ready');
  const speech = f.session.prepared.speechNodes.get('speech');
  assert.equal(speech.maxDuration, 2.5); assert.deepEqual(f.captures, []);
  await f.session.start(42); await turn();
  assert.equal(speech.sessionMaxDuration, 2.5); assert.equal(f.messages('load').length, 2);
});

for (const end of ['close', 'timeout']) test(`${end} interrupts pending startup composition before allocating ASR`, async t => {
  const graph = defaultGraph(); graph.nodes.find(node => node.id === 'speech').type = 'SpeechToTextWhisper';
  graph.edges = graph.edges.filter(route => !['provisional', 'provisionalId'].includes(route.from[1]));
  const language = graphNode('Text', 'language'); language.settings.value = 'ja';
  graph.nodes.push(language, graphNode('TextWindow', 'window'));
  graph.edges.push(edge('language', 'value', 'window', 'text'), edge('window', 'text', 'speech', 'language'));
  const f = fixture(graph, { modelLoadTimeoutMs: end === 'timeout' ? 5 : 180000 }); t.after(() => f.session.close());
  const preparing = f.session.prepareModels(); await turn();
  if (end === 'close') await f.session.close();
  await preparing;
  assert.deepEqual(f.workers, []); assert.deepEqual(f.captures, []);
  assert.equal(f.session.view.modelState, end === 'close' ? 'closed' : 'error');
  if (end === 'timeout') assert.match(f.session.view.error, /Startup configuration timed out/);
});

test('a Save during Cancel waits for the old GPU owner to finish releasing before allocating replacements', async t => {
  const f = fixture(textGraph('TextSummaryLfm2', true)); t.after(() => f.session.close());
  await f.session.prepareModels(); await f.session.start();
  const node = f.session.session.pipeline.entries.get('model').node;
  const dispose = node.dispose.bind(node); let release;
  node.dispose = () => new Promise(resolve => { release = () => { dispose(); resolve(); }; });
  const canceled = f.session.cancel(); await turn();
  f.session.setGraph(textGraph('IfCondition')); await turn();
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].released, false);
  release(); await canceled; await f.session.preparing;
  assert.equal(f.workers[0].released, true); assert.equal(f.workers.length, 2);
  assert.equal(f.session.view.modelState, 'ready');
});

test('preloading never requests microphone/speaker permissions; canceled Start releases a late grant and its warm resources', async t => {
  let permissions = 0, grant, stopped = 0, contexts = 0;
  const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => { permissions++; return new Promise(resolve => { grant = resolve; }); } } });
  t.after(() => { if (previous) Object.defineProperty(navigator, 'mediaDevices', previous); else delete navigator.mediaDevices; });
  const graph = defaultGraph(); graph.nodes.find(node => node.id === 'audio').type = 'MicrophoneAudio';
  const text = graphNode('Text', 'source'); text.settings.value = 'Speech';
  graph.nodes.push(text, graphNode('Kokoro', 'tts'), graphNode('SpeakerOutput', 'speaker'));
  graph.edges.push(edge('source', 'value', 'tts', 'text'), edge('tts', 'audio', 'speaker', 'audio'));
  const f = fixture(graph, { speakerContextFactory: () => { contexts++; return { state: 'running', resume() {}, close() {} }; } });
  t.after(() => f.session.close());
  await f.session.prepareModels(); assert.equal(f.session.view.modelState, 'ready');
  assert.equal(permissions, 0); assert.equal(contexts, 0);
  await f.session.start(); assert.equal(permissions, 0); assert.equal(contexts, 0);
  const starting = f.session.start(undefined, { microphoneGesture: true, speakerGesture: true });
  assert.equal(permissions, 1); assert.equal(contexts, 1);
  const old = [...f.workers]; await f.session.cancel();
  assert.ok(old.every(worker => worker.released)); assert.equal(f.session.view.modelState, 'ready');
  grant({ getTracks: () => [{ stop() { stopped++; } }] }); await starting;
  assert.equal(stopped, 1); assert.equal(f.session.session, null); assert.deepEqual(f.captures, []);
  const nextStart = f.session.start(undefined, { microphoneGesture: true, speakerGesture: true });
  await f.session.close(); // Close must not await the permission grant.
  assert.equal(f.session.view.modelState, 'closed'); assert.ok(f.workers.every(worker => worker.released));
  grant({ getTracks: () => [{ stop() { stopped++; } }] }); await nextStart;
  assert.equal(stopped, 2);
});

test('GPU lifecycle observes loss of the existing device without inference', async () => {
  let lost, error;
  watchGpuDevice({ device: Promise.resolve({ lost: new Promise(resolve => { lost = resolve; }) }) }, value => { error = value; });
  await turn(); assert.equal(error, undefined);
  lost({ message: 'adapter removed' }); await turn(); assert.match(error.message, /GPU device lost: adapter removed/);
});
