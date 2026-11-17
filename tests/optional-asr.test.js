import { NUMBER } from '../web/port-contracts.js';
import { domText } from './fixtures/dom.js';
import { accumulateDisplay } from './fixtures/text-accumulator.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { SpeechToTextMoonshineSmallJaNode } from '../web/moonshine-small-ja-node.js';
import { SpeechToTextMoonshineMediumEnNode } from '../web/moonshine-medium-node.js';
import { OptionalAsrCore } from '../web/optional-asr-core.js';
import { MONO_16KHZ_PCM, TEXT } from '../web/transcription-nodes.js';
import { assertGraph, defaultGraph, graphNode, edge, executableGraph, saveGraph, readGraph, ASR_TYPES } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { graphModelRequirements, GraphModelPreparation } from '../extension/graph-model-preparation.js';
import { defineAssetSet } from '../extension/model-asset-cache.js';
import { TabSession } from '../extension/session.js';

const types = [
  ['SpeechToTextMoonshineSmallJa', SpeechToTextMoonshineSmallJaNode, 'moonshine-small-ja', 'moonshineJapaneseWorkerFactory', true],
  ['SpeechToTextMoonshineMediumEn', SpeechToTextMoonshineMediumEnNode, 'moonshine-medium-en', 'moonshineWorkerFactory', true],
];
const tick = () => new Promise(resolve => setImmediate(resolve));
class Worker {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  send(event) { this.onmessage?.({ data: event }); }
  terminate() { this.released = true; }
}
const graph = () => {
  const g = { version: 15, nodes: [graphNode('ChromeTabAudio', 'audio'), ...types.flatMap(([type], i) => [graphNode(type, `asr${i}`), graphNode('Display', `out${i}`)])],
    edges: types.flatMap(([, , , , partial], i) => [edge('audio', 'audio', `asr${i}`, 'audio'), edge(`asr${i}`, 'final', `out${i}`, 'append')]) };
  for (let i = 0; i < types.length; i++) accumulateDisplay(g, `out${i}`);
  return g;
};

for (const [type, Node, key, factoryKey, partial] of types) {
  test(`${type}: concrete ports, bounded owned PCM, ordered finals, Stop waits for every ack and tail; warm repeat is isolated`, async () => {
    const worker = new Worker(), events = [], output = [];
    const node = new Node({ workerFactory: path => { assert.match(path, key === 'moonshine-small-ja' ? /moonshine-small-ja-worker/ : /moonshine-medium-worker/); return worker; }, onEvent: event => events.push(event) });
    assert.deepEqual(node.inputs, { audio: MONO_16KHZ_PCM });
    assert.deepEqual(node.outputs, partial ? { provisional: TEXT, provisionalId: NUMBER, final: TEXT, finalId: NUMBER } : { final: TEXT, finalId: NUMBER });
    const ready = node.load(); worker.send({ type: 'ready' }); await ready;
    const controller = new AbortController(), context = { signal: controller.signal, emit: (...value) => output.push(value), emitOutputs: values => output.push(...Object.entries(values)), fail: error => { throw error; } };
    await node.start(context);
    const pcm = new Float32Array(3201).fill(0.2); node.receive('audio', pcm);
    assert.equal(worker.messages.filter(m => m.type === 'audio').length, 1);
    assert.notEqual(worker.messages.at(-1).audio.buffer, pcm.buffer); assert.equal(pcm.length, 3201);
    let stopped = false; const stop = node.stop().then(() => { stopped = true; });
    await tick(); assert.equal(stopped, false); assert.equal(worker.messages.some(m => m.type === 'stop'), false);
    for (const [sequence, samples] of [[1, 1600], [2, 1600], [3, 1]]) {
      assert.equal(worker.messages.at(-1).audio.length, samples);
      worker.send({ type: 'consumed', session: 1, sequence });
    }
    assert.equal(worker.messages.at(-1).type, 'stop');
    worker.send({ type: 'final', session: 0, id: 99, text: 'stale' });
    if (partial) worker.send({ type: 'partial', session: 1, id: 0, text: 'interim' });
    for (const id of [0, 0, 1]) worker.send({ type: 'final', session: 1, id, text: 'same real text' });
    worker.send({ type: 'stopped', session: 1 }); await stop;
    assert.deepEqual(output.filter(([port]) => port === 'final'), [['final', 'same real text'], ['final', 'same real text']]);
    assert.equal(node.core.pendingSamples, 0);
    const next = node.nextSession(); await next.start(context);
    worker.send({ type: 'error', session: 1, message: 'old session error' });
    worker.send({ type: 'final', session: 1, id: 2, text: 'stale' });
    worker.send({ type: 'final', session: 2, id: 0, text: 'fresh' });
    assert.deepEqual(output.filter(([port]) => port === 'final').at(-1), ['final', 'fresh']);
    next.dispose(); assert.equal(worker.released, true);
    assert.equal(next.core.pendingSamples, 0); assert.equal(next.core.queue.length, 0);
    assert.throws(() => node.receive('language', 'en'), /Unknown/);
  });

  for (const phase of ['loading', 'running', 'stopping']) test(`${type}: Cancel during ${phase} releases Worker and ignores late output`, async () => {
    const worker = new Worker(), output = [];
    const node = new Node({ workerFactory: () => worker });
    const load = node.load();
    if (phase !== 'loading') { worker.send({ type: 'ready' }); await load; await node.start({ signal: new AbortController().signal, emit: (...v) => output.push(v) }); node.receive('audio', new Float32Array(100)); }
    const stopped = phase === 'stopping' ? node.stop() : Promise.resolve();
    node.dispose();
    if (phase === 'loading') await assert.rejects(load, /disposed/i);
    if (phase === 'stopping') await assert.rejects(stopped, /disposed/i);
    worker.send({ type: 'final', session: 1, id: 0, text: 'late' });
    assert.equal(worker.released, true); assert.deepEqual(output, []);
  });

  test(`${type}: missing assets or runtime errors disable only that processor; pending Stop settles and preview clears`, async () => {
    const worker = new Worker(), output = [], events = [];
    const node = new Node({ workerFactory: () => worker, onEvent: e => events.push(e) });
    const loaded = node.load(); worker.send({ type: 'ready' }); await loaded;
    await node.start({ signal: new AbortController().signal, emit: (...args) => output.push(args), fail: () => assert.fail('peer graph must survive') });
    const stop = node.stop(); worker.send({ type: 'error', session: 1, message: 'missing GPU or corrupt weights; Retry preparation' });
    await stop; assert.equal(events.at(-1).branchUnavailable, true); assert.equal(worker.released, true);
    assert.deepEqual(output, partial ? [['provisional', ''], ['provisional', '']] : []);
    node.receiveEvent({ type: 'final', id: 0, text: 'stale' }); assert.equal(output.some(([, text]) => text === 'stale'), false);
    node.dispose();
  });

  test(`${type}: Save prepares only exact assets (including parked nodes), deduplicates weights, validates hashes and retries failure without changing graph`, async () => {
    const specification = JSON.parse(readFileSync(`extension/${key}-assets.json`, 'utf8'));
    const manifest = defineAssetSet(specification);
    assert.equal(manifest.bytes, specification.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.equal(specification.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)), true);
    const saved = defaultGraph(); saved.nodes.find(n => n.type === 'SpeechToTextMoonshineSmallJa').type = type; if (!partial) saved.edges = saved.edges.filter(e => !['provisional', 'provisionalId'].includes(e.from[1])); saved.nodes.push(graphNode(type, 'parked'), graphNode(type, 'parked2'));
    const original = structuredClone(saved), selected = graphModelRequirements(saved);
    assert.deepEqual(selected.map(item => item.key), [key]);
    assert.equal(executableGraph(saved).nodes.some(node => node.id === 'parked'), false);
    const previous = globalThis.fetch; let attempts = 0;
    globalThis.fetch = async () => ({ ok: true, json: async () => specification });
    try {
      const preparation = new GraphModelPreparation({ createCache: supplied => {
        assert.equal(supplied.id, specification.id);
        return { prepare: async ({ signal }) => { assert.equal(signal.aborted, false); attempts++; return { state: attempts === 1 ? 'Error' : 'Ready', error: attempts === 1 ? 'network unavailable' : '' }; } };
      } });
      preparation.replace(saved); await tick(); assert.equal(preparation.entries[0].view.state, 'Error');
      await preparation.run(preparation.entries[0]); assert.equal(preparation.entries[0].view.state, 'Ready');
      preparation.close(); assert.deepEqual(saved, original);
    } finally { globalThis.fetch = previous; }
  });
}

test('current independent paths retain default graphs, save/reload exactly, bind production types and fan out plain TEXT', () => {
  const original = defaultGraph(); assert.equal(original.version, 15); assert.deepEqual(graphModelRequirements(original).map(r => r.key), ['moonshine-small-ja']);
  const description = graph(); description.nodes.push(graphNode('TextFormatter', 'format'), graphNode('TranslateGemmaEnJa', 'translate'), graphNode('FocusedInputTextOutputNode', 'field'));
  description.edges.push(edge('asr0', 'final', 'format', 'input1'), edge('asr1', 'final', 'translate', 'text'), edge('asr0', 'final', 'field', 'text'));
  assertGraph(description);
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  saveGraph(storage, (description)); assert.deepEqual(readGraph(storage), description);
  const built = buildGraph((description), {});
  types.forEach(([type, Node], i) => { assert.equal(ASR_TYPES.includes(type), true); assert.ok(built.speechNodes.get(`asr${i}`) instanceof Node); });
  assert.equal(built.speechNodes.size, 2); assert.equal(built.audioSources.size, 1);
  assert.deepEqual(defaultGraph(), original);
});

test('bounded transport rejects nonfinite PCM, overflow/crashes release one worker without an unbounded inbox', () => {
  for (const failure of ['overflow', 'crash', 'message']) {
    const worker = new Worker(), events = [];
    const core = new OptionalAsrCore(e => events.push(e), { workerFactory: () => worker, workerPath: './model.js', label: 'Optional test ASR' });
    core.load(); worker.send({ type: 'ready' }); core.start();
    assert.throws(() => core.push(new Float32Array([NaN])), /finite/);
    core.push(new Float32Array(480000)); assert.equal(worker.messages.filter(m => m.type === 'audio').length, 1);
    if (failure === 'overflow') core.push(new Float32Array(1));
    else if (failure === 'crash') worker.onerror({ message: 'GPU lost' });
    else worker.onmessageerror();
    assert.equal(worker.released, true); assert.equal(core.queue.length, 0); assert.equal(events.filter(e => e.type === 'error').length, 1);
  }
});

test('session keeps healthy independent optional ASR path alive after peer load failure and releases both on Stop', async () => {
  const workers = [];
  const factory = broken => () => {
    const worker = new Worker(); workers.push(worker);
    worker.postMessage = message => { worker.messages.push(message); queueMicrotask(() => {
      if (message.type === 'load') worker.send(broken ? { type: 'error', message: 'assets missing; Save and Retry' } : { type: 'ready' });
      if (message.type === 'audio') { worker.send({ type: 'final', session: message.session, id: 0, text: 'peer survived' }); worker.send({ type: 'consumed', session: message.session, sequence: message.sequence }); }
      if (message.type === 'stop') worker.send({ type: 'stopped', session: message.session });
    }); };
    return worker;
  };
  let audio, view;
  const session = new TabSession(value => { view = value; }, { graph: (graph()), moonshineJapaneseWorkerFactory: factory(false), moonshineWorkerFactory: factory(false), sourceFactory: (id, onAudio) => ({ start() { audio = onAudio; }, stop() {} }) });
  await session.start(42); assert.equal(view.state, 'running'); workers[0].send({ type: 'error', session: 1, message: 'assets missing; Save and Retry' }); assert.match(view.error, /asr0.*assets missing/);
  audio(new Float32Array(1600)); await tick(); assert.deepEqual(domText(view.displays.out1), 'peer survived');
  await session.stop(); assert.equal(view.state, 'idle'); assert.equal(workers.every(w => w.released), true);
});

test('Moonshine uses only incomplete native lines as provisional; commits once, bounds 30s history, preserves tails and releases native streams', async () => {
  const { MoonshineStream } = await import('../web/moonshine-stream.js');
  const streams = [], output = [], accepted = [];
  const transcriber = { createStream(options) {
    assert.equal(options.updateInterval, 0.5);
    const stream = { addListener(listener) { this.listener = listener; }, start() {},
      addAudio(pcm, rate) { assert.equal(rate, 16000); accepted.push(pcm.slice()); this.samples = (this.samples || 0) + pcm.length; },
      transcribe() {}, stop() { if (this.samples) this.listener.onLineCompleted({ line: { id: 17, text: 'tail', isComplete: true } }); }, close() { this.closed = true; } };
    streams.push(stream); return stream;
  } };
  const engine = new MoonshineStream(transcriber, e => output.push(e));
  const listener = streams[0].listener;
  listener.onLineStarted({ line: { id: 4, text: 'one', isComplete: false } });
  listener.onLineTextChanged({ line: { id: 4, text: 'one two', isComplete: false } });
  listener.onLineCompleted({ line: { id: 4, text: 'one two three', isComplete: true } });
  listener.onLineCompleted({ line: { id: 4, text: 'duplicate', isComplete: true } });
  listener.onLineTextChanged({ line: { id: 4, text: 'stale', isComplete: false } });
  listener.onLineStarted({ line: { id: 5, text: 'already final', isComplete: true } });
  assert.deepEqual(output.map(e => [e.type, e.text]), [['partial', 'one'], ['partial', 'one two'], ['final', 'one two three']]);
  engine.push(new Float32Array(480013).fill(0.1));
  assert.equal(streams[0].closed, true); assert.equal(streams.length, 2);
  engine.finish(); engine.finish();
  assert.equal(streams.every(s => s.closed), true);
  assert.deepEqual(accepted.map(a => a.length), [480000, 13]);
  assert.deepEqual(output.filter(e => e.type === 'final').map(e => e.id), [0, 1, 2]);
  assert.deepEqual(output.filter(e => e.type === 'final').map(e => e.text), ['one two three', 'tail', 'tail']);
  const canceled = new MoonshineStream(transcriber, () => assert.fail('Cancel must not finalize'));
  canceled.push(new Float32Array(13)); canceled.dispose(); assert.equal(streams.at(-1).closed, true);
});

test('runtime packaging pins release artifacts and original/patched sources; CSP adapter preserves closures without new Function', { skip: !existsSync('.cache/moonshine-voice-wasm-v016.tar.gz') && 'Run prepare:optional-asr-assets to check the runtime archive (no model weights).' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('python3', ['-c', `
import importlib.util, json, hashlib
from pathlib import Path
spec = importlib.util.spec_from_file_location('csp', 'scripts/moonshine-csp.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
manifest=json.loads(Path('scripts/optional-asr-runtime.json').read_text())
assert manifest['archive']['sha256'] == '47a8b94f0b10f9b0687491d86e4606a3cd2b332e566766774f8eb0f984d0ed42'
assert all(f['path'].startswith('moonshine/') for f in manifest['files'])
entry=next(f for f in manifest['files'] if f['path']=='moonshine/moonshine.mjs')
import tarfile
with tarfile.open(Path('.cache')/manifest['archive']['cache']) as package: source=package.extractfile(entry['source']).read()
assert hashlib.sha256(source).hexdigest()==entry['sha256']
patched=module.patch(source.decode()).encode()
assert hashlib.sha256(patched).hexdigest()==entry['packagedSha256']
assert b'new Function' not in patched and b'eval(' not in patched
assert b'function(...values)' in patched
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('production Moonshine Worker reports the original inference error even if native cleanup also throws', async () => {
  const { runInNewContext } = await import('node:vm');
  const code = readFileSync('web/moonshine-worker.js', 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function') + '\ninstallMoonshineWorker();';
  const events = [], self = {}; let streamClosed = false, modelClosed = false;
  runInNewContext(code, { self, postMessage: event => events.push(event),
    moonshineManifest: async () => ({}), optionalAsrFiles: async () => new Map(), ModelArch: { MediumStreaming: 5 },
    Transcriber: { load: async () => ({ close() { modelClosed = true; throw Error('secondary model cleanup'); } }) },
    MoonshineStream: class { push() { throw Error('original inference failure'); } dispose() { streamClosed = true; throw Error('secondary stream cleanup'); } },
  });
  self.onmessage({ data: { type: 'load' } }); await tick();
  self.onmessage({ data: { type: 'start', session: 1 } }); await tick();
  self.onmessage({ data: { type: 'audio', session: 1, audio: new Float32Array(1), sequence: 1 } }); await tick();
  assert.equal(streamClosed, true); assert.equal(modelClosed, true);
  assert.equal(events.filter(e => e.type === 'error').length, 1);
  assert.equal(events.at(-1).message, 'original inference failure');
});

test('each production Worker selects its own verified tokenizer/files and architecture; only Japanese raises the token guard', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = readFileSync('web/moonshine-worker.js', 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
  for (const japanese of [false, true]) {
    const events = [], self = {}, selected = [], files = new Map([['tokenizer.bin', new Uint8Array([japanese ? 2 : 1])]]);
    let config;
    runInNewContext(source + `\ninstallMoonshineWorker({ japanese: ${japanese} });`, {
      self, postMessage: event => events.push(event),
      moonshineManifest: async () => 'en', moonshineJapaneseManifest: async () => 'ja',
      optionalAsrFiles: async manifest => { selected.push(manifest); return files; },
      ModelArch: { MediumStreaming: 5, SmallStreaming: 4 },
      Transcriber: { load: async options => { config = options; assert.equal(options.files.get('tokenizer.bin')[0], japanese ? 2 : 1); return {}; } },
    });
    self.onmessage({ data: { type: 'load' } }); await tick();
    assert.deepEqual(selected, [japanese ? 'ja' : 'en']);
    assert.equal(config.modelArch, japanese ? 4 : 5);
    assert.equal(config.options.max_tokens_per_second, japanese ? '13' : undefined);
    assert.equal(config.options.identify_speakers, 'false');
    assert.equal(config.options.return_audio_data, 'false');
    assert.equal(files.size, 0);
    assert.equal(events.find(event => event.type === 'configuration').language, japanese ? 'ja' : 'en');
    assert.equal(events.at(-1).type, 'ready');
  }
});

test('unsupported graph types fail normal validation without substitution; both supported models round-trip', () => {
  const supported = graph();
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.deepEqual(ASR_TYPES, ['SpeechToTextMoonshineMediumEn', 'SpeechToTextMoonshineSmallJa']);
  saveGraph(storage, supported); assert.deepEqual(readGraph(storage), supported);
  const unsupported = structuredClone(supported); unsupported.nodes.find(node => node.id === 'asr0').type = 'UnsupportedRecognizer';
  assert.throws(() => assertGraph(unsupported), /Unknown Node type: UnsupportedRecognizer.*Recreate or reset/);
  assert.equal(unsupported.nodes.find(node => node.id === 'asr0').type, 'UnsupportedRecognizer');
});
