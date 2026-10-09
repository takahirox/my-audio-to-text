import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { Pipeline } from '../web/pipeline.js';
import { MONO_16KHZ_PCM, TRANSCRIPT } from '../web/transcription-nodes.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph, graphNode, edge } from '../extension/graph.js';

function fixture({ holdLoad = false, holdSource = false, sourceError, stopError, graph, pageConnectionFactory } = {}) {
  const workers = [], sources = [], views = [];
  const session = new TabSession(view => views.push(view), {
    graph, pageConnectionFactory,
    workerFactory(path) {
      const worker = { path, messages: [], terminated: false,
        postMessage(data) {
          this.messages.push(structuredClone(data));
          queueMicrotask(() => {
            if (data.type === 'load' && !holdLoad) this.reply({ type: 'ready' });
            else if (data.type === 'vad-audio') this.reply({ type: 'vad', session: data.session,
              frames: [{ audio: data.audio, speaking: true }] });
            else if (data.type === 'vad-stop') this.reply({ type: 'vad-stopped', session: data.session });
            else if (data.type === 'decode') {
              this.reply({ type: data.final ? 'final' : 'partial', session: data.session, id: data.id,
                text: data.final ? 'final text' : 'provisional text' });
              this.reply({ type: 'decoded', session: data.session });
            }
          });
        },
        reply(data) { this.onmessage({ data }); },
        terminate() { this.terminated = true; },
      };
      workers.push(worker); return worker;
    },
    sourceFactory(tabId, onAudio, onEnded) {
      const source = { tabId, onAudio, onEnded, stops: [],
        start() {
          if (sourceError) return Promise.reject(new Error(sourceError));
          return holdSource ? new Promise(resolve => { this.grant = resolve; }) : Promise.resolve();
        },
        async stop(flush = true) {
          this.stops.push(flush);
          if (stopError && flush) throw new Error(stopError);
          if (flush) onAudio(new Float32Array(37).fill(0.05));
        },
      };
      sources.push(source); return source;
    },
  });
  return { session, workers, sources, views };
}
const drain = () => new Promise(resolve => setImmediate(resolve));

function fieldOutputs({ live = true } = {}) {
  const graph = defaultGraph({ enabled: false });
  if (!live) {
    graph.nodes = graph.nodes.filter(node => node.type !== 'TranscriptView');
    graph.edges = graph.edges.filter(edge => edge.to[0] !== 'transcript');
  }
  for (const [id, type] of [['focused', 'FocusedInputTextOutputNode'], ['selected', 'SelectedFormFieldTextOutputNode']]) {
    graph.nodes.push(graphNode(type, id)); graph.edges.push(edge('speech', 'final', id, 'final'));
  }
  return graph;
}

test('missing field targets start with actionable skip statuses; Stop drains Live, Cancel releases capture, and retry uses fresh targets', async () => {
  const sent = [];
  const f = fixture({ graph: fieldOutputs(), pageConnectionFactory: target => ({ request: async (action, value) => sent.push([target, action, value]), close() {} }) });
  await f.session.start(42);
  assert.equal(f.session.view.state, 'running'); assert.equal(f.session.view.error, '');
  for (const label of ['Focused input', 'Selected field']) assert.match(f.session.view.targetStatus, new RegExp(`${label} output skipped: no authorized target`));
  assert.match(f.session.view.targetStatus, /Input and output targets.*next session/);
  assert.doesNotMatch(f.session.view.targetStatus, /No text destination/);
  assert.throws(() => f.session.setTarget('focused', {}), /Stop before/);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain();
  await f.session.stop();
  assert.equal(f.session.view.final, 'final text\n'); assert.deepEqual(sent, []);
  f.session.setTarget('focused', { tabId: 99, documentId: 'authorized', label: 'Page' });
  f.session.setTarget('selected', { tabId: 99, documentId: 'authorized', label: 'Page' });
  await f.session.start(42);
  assert.match(f.session.view.targetStatus, /connected and authorized/);
  assert.match(f.session.view.targetStatus, /Selected field output skipped: no selected field/);
  f.sources[1].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop();
  assert.deepEqual(sent.filter(([, action]) => action === 'append').map(([, , value]) => value.text), ['final text']);
  f.session.setTarget('selected', { tabId: 99, documentId: 'authorized', fieldId: 'picked', label: 'Page', fieldLabel: 'Notes' });
  await f.session.start(42); assert.doesNotMatch(f.session.view.targetStatus, /skipped/);
  const before = sent.length; f.session.cancel(); f.sources[2].onAudio(new Float32Array(16000)); await drain();
  assert.equal(sent.length, before); assert.ok(f.workers.every(worker => worker.terminated));
  assert.equal(f.sources[2].stops.at(-1), false);
});

test('field-only graph starts without fallback views and reports when every text destination is inactive', async () => {
  const f = fixture({ graph: fieldOutputs({ live: false }), pageConnectionFactory() { assert.fail('Unset targets must not connect'); } });
  await f.session.start(42);
  assert.equal(f.session.view.state, 'running'); assert.equal(f.session.view.error, '');
  assert.match(f.session.view.targetStatus, /No text destination is active/);
  assert.equal(f.session.session.pipeline.entries.has('transcript'), false);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop();
  assert.equal(f.session.view.final, ''); assert.equal(f.session.view.state, 'idle');
});

test('target snapshot precedes model loading and stale field startup leaves an authorized peer running', async () => {
  const sent = [], f = fixture({ graph: fieldOutputs({ live: false }), holdLoad: true,
    pageConnectionFactory: target => ({ request: async (action, value) => {
      if (target.documentId === 'stale') throw Error('Permission lost');
      sent.push([target.documentId, action, value]);
    }, close() {} }) });
  f.session.setTarget('selected', { tabId: 99, documentId: 'stale', fieldId: 'picked', label: 'Page' });
  const starting = f.session.start(42);
  f.session.targets.focused = { tabId: 99, documentId: 'later', label: 'Page' };
  f.session.targets.selected.documentId = 'later';
  f.workers.forEach(worker => worker.reply({ type: 'ready' })); await starting;
  assert.equal(f.session.view.state, 'running'); assert.deepEqual(sent, []);
  assert.match(f.session.view.targetStatus, /Permission lost/); assert.match(f.session.view.targetStatus, /No text destination is active/);
  await f.session.stop();
  const retry = f.session.start(42); f.workers.slice(2).forEach(worker => worker.reply({ type: 'ready' })); await retry;
  assert.doesNotMatch(f.session.view.targetStatus, /skipped|No text destination/);
  const selected = f.session.session.pipeline.entries.get('selected').node;
  selected.failure('Page removed');
  assert.equal(f.session.view.state, 'running'); assert.doesNotMatch(f.session.view.targetStatus, /No text destination/);
  f.session.session.pipeline.entries.get('focused').node.failure('Permission lost');
  assert.match(f.session.view.targetStatus, /No text destination is active/);
  f.session.cancel();
});

test('selected media input still requires its target before model or capture startup', async () => {
  const graph = fieldOutputs(); graph.nodes[0].type = 'SelectedPageMediaAudio';
  const f = fixture({ graph }); await f.session.start(42);
  assert.match(f.session.view.error, /Select and authorize.*audio/);
  assert.equal(f.workers.length, 0); assert.equal(f.sources.length, 0);
});

test('extension session emits provisional/final output, flushes once and clears repeat transcripts', async () => {
  const { session, workers, sources } = fixture();
  await session.start(42);
  assert.equal(session.view.state, 'running');
  const graph = session.session.pipeline;
  assert.ok(graph instanceof Pipeline);
  assert.deepEqual(graph.order.map(entry => entry.node.constructor.name),
    ['ExtensionTabAudioNode', 'SpeechToTextNode', 'TranscriptOutputNode']);
  assert.equal(graph.entries.get('audio').outputs.audio, MONO_16KHZ_PCM);
  assert.equal(graph.entries.get('speech').inputs.audio, MONO_16KHZ_PCM);
  assert.equal(graph.entries.get('transcript').inputs.provisional, TRANSCRIPT);
  assert.equal(graph.entries.get('transcript').inputs.final, TRANSCRIPT);
  sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain();
  assert.equal(session.view.partial, 'provisional text');
  await session.start(99); assert.equal(sources.length, 1, 'live capture cannot be retargeted');
  await Promise.all([session.stop(), session.stop()]); await drain();
  assert.equal(session.view.final, 'final text\n');
  assert.equal(session.view.partial, ''); assert.equal(session.view.state, 'idle');
  assert.deepEqual(sources[0].stops, [true]);
  assert.equal(workers[1].messages.filter(m => m.type === 'vad-stop').length, 1);
  assert.ok(workers.every(w => w.terminated));
  await session.start(99);
  assert.equal(session.view.final, ''); assert.equal(session.view.partial, '');
  const before = workers[3].messages.length;
  sources[0].onAudio(new Float32Array(16000)); sources[0].onEnded();
  workers[0].reply({ type: 'error', message: 'stale error' });
  await drain();
  assert.equal(workers[3].messages.length, before);
  assert.equal(session.view.state, 'running'); assert.equal(session.view.error, '');
  session.cancel(); assert.deepEqual(sources[1].stops, [false]);
  assert.ok(workers.every(w => w.terminated));
});

for (const mode of ['source', 'stop', 'asr']) {
  test(`extension ${mode} failure releases workers/capture and allows retry`, async () => {
    const f = fixture({ sourceError: mode === 'source' ? 'capture failed' : undefined,
      stopError: mode === 'stop' ? 'flush failed' : undefined });
    await f.session.start(42);
    if (mode === 'stop') await f.session.stop();
    if (mode === 'asr') f.workers[0].reply({ type: 'error', message: 'ASR failed' });
    await drain();
    assert.equal(f.session.view.state, 'idle'); assert.match(f.session.view.error, /failed/);
    assert.ok(f.workers.every(w => w.terminated));
    assert.equal(f.sources[0].stops.at(-1), false);
  });
}

test('closing/navigating a target or ending capture finalizes; unrelated tabs do not stop it', async () => {
  const f = fixture(); await f.session.start(42);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain();
  f.session.tabEnded(99); assert.equal(f.session.view.state, 'running');
  f.session.tabEnded(42); f.sources[0].onEnded(); await drain();
  assert.equal(f.session.view.state, 'idle'); assert.equal(f.session.view.final, 'final text\n');
  assert.deepEqual(f.sources[0].stops, [true]);
});

test('Stop while loading settles start and rejects late worker readiness', async () => {
  const f = fixture({ holdLoad: true }); const starting = f.session.start(42);
  await f.session.stop(); await starting;
  f.workers.forEach(w => w.reply({ type: 'ready' }));
  assert.equal(f.sources.length, 0); assert.ok(f.workers.every(w => w.terminated));
  assert.equal(f.session.view.state, 'idle');
});

test('late capture setup cannot revive a stopped or replacement session', async () => {
  const f = fixture({ holdSource: true }); const starting = f.session.start(42);
  await drain(); assert.equal(f.session.view.state, 'starting');
  await f.session.stop(); await drain();
  const replacement = f.session.start(99); await drain();
  f.sources[1].grant(); await replacement;
  f.sources[0].grant(); await starting;
  f.sources[0].onEnded(); f.sources[0].onAudio(new Float32Array(16000));
  assert.equal(f.session.view.state, 'running'); assert.equal(f.session.view.tabId, 99);
  assert.equal(f.session.view.error, ''); f.session.cancel();
});

test('Stop before the producer starts drains the graph without requesting capture', async () => {
  const f = fixture();
  const render = f.session.render;
  f.session.render = view => {
    render(view);
    if (view.state === 'starting') queueMicrotask(() => { void f.session.stop(); });
  };
  await f.session.start(42); await f.session.stop();
  assert.equal(f.sources.length, 0);
  assert.equal(f.session.view.state, 'idle'); assert.equal(f.session.view.error, '');
  assert.ok(f.workers.every(w => w.terminated));
});

test('stream end during pending capture setup settles startup and drains once', async () => {
  const f = fixture({ holdSource: true }); const starting = f.session.start(42);
  await drain(); f.sources[0].onEnded();
  await starting; await f.session.stop();
  assert.equal(f.session.view.state, 'idle'); assert.equal(f.session.view.error, '');
  assert.deepEqual(f.sources[0].stops, [true]);
  assert.ok(f.workers.every(w => w.terminated));
  f.sources[0].grant(); await drain();
  assert.equal(f.session.view.state, 'idle');
});

test('toolbar action passes the invoked tab to a persistent window and reuses it', async () => {
  let invoke; const created = [], sent = [], focused = []; let contexts = [];
  const chrome = {
    action: { onClicked: { addListener(callback) { invoke = callback; } } },
    runtime: { getURL: path => `chrome-extension://id/${path}`, getContexts: async () => contexts,
      sendMessage: async message => sent.push(message) },
    windows: { create: async options => created.push(options), update: async (...args) => focused.push(args) },
  };
  runInNewContext(readFileSync('extension/background.js', 'utf8'), { chrome });
  assert.equal(created.length, 0, 'only a user action opens capture UI');
  await invoke({ id: 42 });
  assert.equal(created[0].url, 'chrome-extension://id/extension/recorder.html?tab=42');
  assert.equal(created[0].type, 'popup');
  contexts = [{ documentUrl: created[0].url, windowId: 7 }];
  await invoke({ id: 99 });
  assert.equal(created.length, 1); assert.equal(sent[0].tabId, 99);
  assert.equal(focused[0][0], 7);
});

test('extension package retains byte-identical Web core/models and minimum permissions', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util
from pathlib import Path
import tempfile
import shutil
import json
spec = importlib.util.spec_from_file_location('build', 'scripts/build-extension.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
original = build.ROOT
with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp)
    build.ROOT = root
    shutil.copytree(original / 'extension', root / 'extension')
    (root / 'web').mkdir()
    for name in build.SHARED_FILES:
        shutil.copy2(original / 'web' / name, root / 'web' / name)
    shutil.copytree(original / 'web' / 'licenses', root / 'web' / 'licenses')
    vendor = root / 'web' / 'vendor' / 'sherpa-ja-en'
    vendor.mkdir(parents=True)
    (vendor / 'sherpa-onnx-wasm-main-vad-asr.data').write_bytes(b'pinned model fixture')
    translation = root / 'web' / 'vendor' / 'translation'
    translation.mkdir()
    for name in ('transformers.js', 'ort-wasm-simd-threaded.asyncify.mjs',
                 'ort-wasm-simd-threaded.asyncify.wasm', 'transformers-LICENSE'):
        (translation / name).write_bytes(b'pinned runtime fixture')
    tts = root / 'web' / 'tts-assets'
    tts.mkdir()
    for name in ('ort.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm',
                 'transformers.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm',
                 'phonemizer.js', 'phonemizer-engine.mjs', 'phonemizer-source.tar.gz',
                 'openjtalk-wasm-wrapper-D6E3BSJO.js', 'openjtalk-wasm.wasm',
                 'open_jtalk_dic_utf_8-1.11.tar.gz', 'openjtalk-voice.htsvoice'):
        (tts / name).write_bytes(b'pinned TTS runtime fixture')
    build.main()
    target = root / 'dist' / 'chrome-extension'
    assert {'pipeline.js', 'transcription-nodes.js'} <= set(build.SHARED_FILES)
    assert (target / 'extension' / 'tab-audio-node.js').is_file()
    assert (target / 'web' / 'tts-assets' / 'phonemizer-source.tar.gz').is_file()
    assert (target / 'extension' / 'graph-editor.js').is_file()
    assert (target / 'extension' / 'graph-editor.html').is_file()
    assert (target / 'extension' / 'graph-page.js').is_file()
    assert (target / 'extension' / 'navigation.js').is_file()
    assert (target / 'extension' / 'model-cache.html').is_file()
    assert (target / 'extension' / 'cache-demo' / 'weights.bin').stat().st_size == 16384
    for name in build.SHARED_FILES:
        assert (target / 'web' / name).read_bytes() == (original / 'web' / name).read_bytes()
    assert (target / 'web' / 'vendor' / 'sherpa-ja-en' / 'sherpa-onnx-wasm-main-vad-asr.data').read_bytes() == b'pinned model fixture'
    assert (target / 'web' / 'vendor' / 'translation' / 'transformers.js').read_bytes() == b'pinned runtime fixture'
    manifest = json.loads((target / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert manifest['options_ui'] == {'page': 'extension/model-cache.html', 'open_in_tab': True}
    assert set(manifest['permissions']) == {'activeTab', 'tabCapture', 'scripting'}
    assert 'host_permissions' not in manifest and 'content_scripts' not in manifest
    assert (target / manifest['background']['service_worker']).is_file()
    assert 'wasm-unsafe-eval' in manifest['content_security_policy']['extension_pages']
    assert manifest['cross_origin_embedder_policy']['value'] == 'require-corp'
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
