import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { Pipeline } from '../web/pipeline.js';
import { MONO_16KHZ_PCM, TEXT } from '../web/transcription-nodes.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph, graphNode, edge } from '../extension/graph.js';

function fixture({ holdLoad = false, holdSource = false, asyncFlush = false, sourceError, stopError, graph, pageConnectionFactory } = {}) {
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
          if (flush && asyncFlush) await drain();
          if (flush) onAudio(new Float32Array(37).fill(0.05));
        },
      };
      sources.push(source); return source;
    },
  });
  return { session, workers, sources, views };
}
const drain = () => new Promise(resolve => setImmediate(resolve));

test('Number duration is set before capture; saves during load/capture affect only the next session', async () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('Number', 'duration'));
  graph.nodes.at(-1).settings.value = 2.5;
  graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'));
  const f = fixture({ graph, holdLoad: true });
  const starting = f.session.start(42); await drain();
  assert.equal(f.sources.length, 0);
  assert.equal(f.session.session.speechNodes.get('speech').maxDuration, 2.5);
  graph.nodes.at(-1).settings.value = 3.75; f.session.setGraph(graph);
  f.workers.forEach(w => w.reply({ type: 'ready' })); await starting;
  assert.equal(f.session.session.speechNodes.get('speech').core.simulation.maxSamples, 40000);
  graph.nodes.at(-1).settings.value = 1.25; f.session.setGraph(graph);
  f.sources[0].onAudio(new Float32Array(40000).fill(0.05)); await drain();
  assert.equal(f.workers[0].messages.find(m => m.type === 'decode').audio.length, 40000);
  await f.session.stop();
  const next = f.session.start(42); await drain();
  f.workers.slice(-2).forEach(w => w.reply({ type: 'ready' })); await next;
  assert.equal(f.session.session.speechNodes.get('speech').core.simulation.maxSamples, 20000);
  f.session.cancel(); await drain(); assert.ok(f.workers.every(w => w.terminated));
});

function fieldOutputs({ live = true } = {}) {
  const graph = defaultGraph({ enabled: false });
  if (!live) {
    graph.nodes = graph.nodes.filter(node => node.id !== 'transcript');
    graph.edges = graph.edges.filter(edge => edge.to[0] !== 'transcript');
  }
  graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'focused'));
  graph.edges.push(edge('speech', 'final', 'focused', 'text'));
  return graph;
}

test('missing toolbar document skips only focused output; Live drains, retry snapshots the same-tab document', async () => {
  const sent = [], f = fixture({ graph: fieldOutputs(), pageConnectionFactory: target => ({ request: async (action, value) => { sent.push([target, action, value]); return { inserted: true }; }, close() {} }) });
  await f.session.start(42);
  assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.targetStatus, /output skipped: no authorized toolbar document/);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop();
  assert.equal((f.session.view.displays.transcript?.items.map(text => text + '\n').join('') || ''), 'final text\n'); assert.deepEqual(sent, []);
  f.session.outputTarget = { tabId: 42, documentId: 'authorized', label: 'Page' };
  await f.session.start(42); assert.match(f.session.view.targetStatus, /connected and authorized/);
  f.session.outputTarget.documentId = 'changed';
  f.sources[1].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop();
  assert.deepEqual(sent.filter(([, action]) => action === 'append').map(([target, , value]) => [target.documentId, value.text]), [['authorized', 'final text']]);
  f.session.tabEnded(42); assert.equal(f.session.outputTarget, null);
});
test('field-only graph reports every unavailable destination without adding a fallback view', async () => {
  const f = fixture({ graph: fieldOutputs({ live: false }), pageConnectionFactory() { assert.fail('Unset targets must not connect'); } });
  await f.session.start(42); assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.targetStatus, /No text destination is active/);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop(); assert.equal((f.session.view.displays.transcript?.items.map(text => text + '\n').join('') || ''), '');
});
test('stale document disables focused output while Live continues; cancellation releases capture and workers', async () => {
  const f = fixture({ graph: fieldOutputs(), pageConnectionFactory: () => ({ request: async () => { throw Error('Permission lost'); }, close() {} }) });
  f.session.outputTarget = { tabId: 42, documentId: 'stale', label: 'Page' };
  await f.session.start(42); assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.targetStatus, /Permission lost/);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', id: 1, text: 'Live continues' }); await drain(); assert.match((f.session.view.displays.transcript?.items.map(text => text + '\n').join('') || ''), /Live continues/);
  f.session.cancel(); await drain(); assert.ok(f.workers.every(worker => worker.terminated)); assert.equal(f.sources[0].stops.at(-1), false);
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
    ['ExtensionTabAudioNode', 'SpeechToTextNode', 'LiveTextDisplayNode']);
  assert.equal(graph.entries.get('audio').outputs.audio, MONO_16KHZ_PCM);
  assert.equal(graph.entries.get('speech').inputs.audio, MONO_16KHZ_PCM);
  assert.equal(graph.entries.get('transcript').inputs.replace, TEXT);
  assert.equal(graph.entries.get('transcript').inputs.append, TEXT);
  sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain();
  assert.equal((session.view.displays.transcript?.preview || ''), 'provisional text');
  await session.start(99); assert.equal(sources.length, 1, 'live capture cannot be retargeted');
  await Promise.all([session.stop(), session.stop()]); await drain();
  assert.equal((session.view.displays.transcript?.items.map(text => text + '\n').join('') || ''), 'final text\n');
  assert.equal((session.view.displays.transcript?.preview || ''), ''); assert.equal(session.view.state, 'idle');
  assert.deepEqual(sources[0].stops, [true]);
  assert.equal(workers[1].messages.filter(m => m.type === 'vad-stop').length, 1);
  assert.ok(workers.every(w => w.terminated));
  await session.start(99);
  assert.equal((session.view.displays.transcript?.items.map(text => text + '\n').join('') || ''), ''); assert.equal((session.view.displays.transcript?.preview || ''), '');
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
  assert.equal(f.session.view.state, 'idle'); assert.equal((f.session.view.displays.transcript?.items.map(text => text + '\n').join('') || ''), 'final text\n');
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
  assert.equal(created[0].focused, false, 'new Live prepares page focus before taking window focus');
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
    whisper = root / 'web' / 'vendor' / 'whisper' / 'tiny'
    whisper.mkdir(parents=True)
    (whisper / 'fixture.onnx').write_bytes(b'pinned Whisper fixture')
    (root / 'scripts').mkdir()
    import hashlib
    (root / 'scripts' / 'whisper-assets.json').write_text(json.dumps({'files': [{'path': 'fixture.onnx', 'bytes': 22, 'sha256': hashlib.sha256(b'pinned Whisper fixture').hexdigest()}]}))
    zipformer = root / 'web/vendor/zipformer-en'
    zipformer.mkdir()
    content = b'pinned online fixture'
    (zipformer / 'sherpa-onnx-wasm-main-asr.data').write_bytes(content)
    zip_entries = [{'path': 'sherpa-onnx-wasm-main-asr.data', 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}]
    zip_spec = {'files': [], 'bundle': zip_entries}
    (root / 'scripts/zipformer-assets.json').write_text(json.dumps(zip_spec))
    (zipformer / 'manifest.json').write_text(json.dumps({'specification': zip_spec, 'files': zip_entries}))
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

function concurrentGraph({ fanout = false } = {}) {
  const graph = defaultGraph();
  graph.nodes.push(graphNode('ChromeTabAudio', 'second-audio'), graphNode('SpeechToTextReazonSpeech', 'second-speech'), graphNode('LiveTextDisplay', 'second-display'));
  graph.edges.push(edge(fanout ? 'audio' : 'second-audio', 'audio', 'second-speech', 'audio'), edge('second-speech', 'final', 'second-display', 'append'));
  return graph;
}

for (const mode of ['stop', 'native-end', 'tab-navigation']) {
  test(`shared tab capture delivers identical final PCM to both ASRs on ${mode}`, async () => {
    const f = fixture({ graph: concurrentGraph(), asyncFlush: true });
    for (let repeat = 0; repeat < 2; repeat++) {
      await f.session.start(42);
      const source = f.sources.at(-1), workers = f.workers.slice(-4);
      assert.equal(f.sources.length, repeat + 1, 'both sources share one native capture');
      // No earlier audio: the only transcript must come from the Stop tail.
      if (mode === 'tab-navigation') {
        const active = f.session.session;
        f.session.tabEnded(42);
        await active.stopping;
      } else if (mode === 'native-end') {
        const active = f.session.session;
        source.onEnded();
        await active.stopping;
      } else await f.session.stop();
      assert.equal(f.session.view.error, '');
      assert.deepEqual(f.session.view.displays.transcript.items, ['final text']);
      assert.deepEqual(f.session.view.displays['second-display'].items, ['final text']);
      const deliveries = workers.filter(worker => worker.path.includes('silero')).map(worker =>
        worker.messages.filter(message => message.type === 'vad-audio').map(message => message.audio));
      assert.deepEqual(deliveries, [[new Float32Array(37).fill(0.05)], [new Float32Array(37).fill(0.05)]]);
      assert.deepEqual(source.stops, [true], 'flush the native capture once');
      assert.ok(workers.every(worker => worker.terminated));
    }
  });
}

test('independent same-type ASRs route, drain on branch end, Stop, Cancel and repeat without losing peers', async () => {
  const f = fixture({ graph: concurrentGraph() });
  await f.session.start(42);
  assert.equal(f.workers.length, 4); assert.equal(f.sources.length, 1);
  const active = f.session.session;
  active.speechNodes.get('speech').receiveEvent({ type: 'final', id: 0, text: 'remote' });
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 0, text: 'local' });
  await drain();
  assert.deepEqual(f.session.view.displays.transcript.items, ['remote']);
  assert.deepEqual(f.session.view.displays['second-display'].items, ['local']);
  active.audioSources.get('audio').end(); await active.branchDrain;
  assert.equal(f.session.view.state, 'running');
  assert.equal(active.pipeline.entries.get('speech').closed, true);
  assert.equal(active.pipeline.entries.get('second-speech').closed, false);
  assert.equal(f.workers.filter(worker => worker.terminated).length, 2);
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 1, text: 'still local' }); await drain();
  assert.deepEqual(f.session.view.displays['second-display'].items, ['local', 'still local']);
  await f.session.stop(); assert.ok(f.workers.every(worker => worker.terminated));
  assert.ok(f.sources.every(source => source.stops.length === 1));
  await f.session.start(42); assert.equal(f.workers.length, 8);
  f.session.cancel(); await drain(); assert.ok(f.workers.every(worker => worker.terminated));
});

test('fan-out uses one capture with independent same-type model processors and settings', async () => {
  const graph = concurrentGraph({ fanout: true });
  graph.nodes.push(graphNode('Number', 'duration'));
  graph.nodes.at(-1).settings.value = 1.5;
  graph.edges.push(edge('duration', 'value', 'second-speech', 'maxDuration'));
  const f = fixture({ graph }); await f.session.start(42);
  assert.equal(f.sources.length, 1); assert.equal(f.workers.length, 4);
  assert.equal(f.session.session.speechNodes.get('speech').maxDuration, 6);
  assert.equal(f.session.session.speechNodes.get('second-speech').maxDuration, 1.5);
  f.sources[0].onAudio(new Float32Array(3200).fill(.1)); await drain();
  await f.session.stop();
  assert.deepEqual(f.session.view.displays.transcript.items, ['final text']);
  assert.deepEqual(f.session.view.displays['second-display'].items, ['final text']);
});

test('parked and incomplete nodes do not load models, request microphone permission or capture', async () => {
  const graph = defaultGraph();
  for (const [type, id] of [['MicrophoneAudio', 'parked-mic'], ['SpeechToTextWhisper', 'parked-model'], ['TextFormatter', 'unfinished'], ['Kokoro', 'parked-tts'], ['LiveTextDisplay', 'parked-output']]) graph.nodes.push(graphNode(type, id));
  graph.edges.push(edge('parked-model', 'final', 'unfinished', 'input1'), edge('unfinished', 'text', 'parked-output', 'append'));
  const f = fixture({ graph }); await f.session.start(42);
  assert.equal(f.session.view.state, 'running'); assert.equal(f.workers.length, 2); assert.equal(f.sources.length, 1);
  assert.deepEqual([...f.session.session.pipeline.entries.keys()], ['audio', 'speech', 'transcript']);
  assert.deepEqual(f.session.graph, graph); await f.session.stop();
  const draft = { version: 8, nodes: graph.nodes.slice(3), edges: [] };
  f.session.setGraph(draft); await f.session.start(42, { microphoneGesture: true });
  assert.match(f.session.view.error, /No executable path/); assert.equal(f.session.view.state, 'idle');
  assert.equal(f.workers.length, 2); assert.equal(f.sources.length, 1);
});

test('a shared formatter stays live after one input path ends', async () => {
  const graph = concurrentGraph(); graph.nodes.push(graphNode('TextFormatter', 'shared'), graphNode('LiveTextDisplay', 'combined'));
  graph.nodes.at(-2).settings.template = '{1}/{2}';
  graph.edges.push(edge('speech', 'final', 'shared', 'input1'), edge('second-speech', 'final', 'shared', 'input2'), edge('shared', 'text', 'combined', 'replace'));
  const f = fixture({ graph }); await f.session.start(42); const active = f.session.session;
  active.audioSources.get('audio').end(); await active.branchDrain;
  assert.equal(active.pipeline.entries.get('shared').closed, false);
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 0, text: 'peer' }); await drain();
  assert.match(f.session.view.displays.combined.preview, /peer/); await f.session.stop();
});

test('active microphone permission requires a gesture; Cancel releases a late grant before models load', async () => {
  const graph = defaultGraph(); graph.nodes[0].type = 'MicrophoneAudio';
  const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  let grant, requests = 0, stops = 0;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia() { requests++; return new Promise(resolve => { grant = resolve; }); } } });
  try {
    const f = fixture({ graph }); await f.session.start();
    assert.match(f.session.view.status, /Press Start/); assert.equal(requests, 0);
    const starting = f.session.start(undefined, { microphoneGesture: true });
    assert.equal(requests, 1); assert.equal(f.workers.length, 0);
    f.session.cancel(); grant({ getTracks: () => [{ stop() { stops++; } }] }); await starting;
    assert.equal(stops, 1); assert.equal(f.workers.length, 0); assert.equal(f.session.view.state, 'idle');
  } finally { if (original) Object.defineProperty(navigator,'mediaDevices',original); else delete navigator.mediaDevices; }
});

test('one concurrent model load failure cancels all models before capture and permits retry', async () => {
  const f = fixture({ graph: concurrentGraph(), holdLoad: true });
  const starting = f.session.start(42); await drain(); assert.equal(f.workers.length, 4);
  f.workers[0].reply({ type: 'error', message: 'Model readiness failed' }); await starting; await drain();
  assert.match(f.session.view.error, /speech.*Model readiness failed/);
  assert.ok(f.workers.every(worker => worker.terminated)); assert.equal(f.sources.length, 0);
  const retry = f.session.start(42); await drain();
  f.workers.slice(4).forEach(worker => worker.reply({ type: 'ready' })); await retry;
  assert.equal(f.session.view.state, 'running'); f.session.cancel(); await drain();
  assert.ok(f.workers.every(worker => worker.terminated));
});

test('source status preserves valid IDs that also name Object prototype properties', async () => {
  const graph = defaultGraph(); graph.nodes[0].id = 'toString'; graph.edges[0].from[0] = 'toString';
  const f = fixture({ graph }); await f.session.start(42);
  assert.match(f.session.view.signal, /toString: No audio signal yet/);
  f.sources[0].onAudio(new Float32Array([.1]));
  assert.equal(f.session.view.signal, 'toString: Audio signal detected.'); await f.session.stop();
});

test('one source ending during concurrent model preload waits for startup before draining its Nodes', async () => {
  const f = fixture({ graph: concurrentGraph(), holdLoad: true });
  const starting = f.session.start(42); await drain(); const active = f.session.session;
  active.audioSources.get('audio').end(); const branch = f.session.sourceEnded(active, 'audio');
  await drain(); assert.equal(f.session.view.state, 'loading'); assert.equal(f.session.view.error, '');
  assert.ok(f.workers.every(worker => !worker.terminated));
  f.workers.forEach(worker => worker.reply({ type: 'ready' })); await starting; await branch;
  assert.equal(f.session.view.state, 'running'); assert.equal(active.pipeline.entries.get('speech').closed, true);
  assert.equal(active.pipeline.entries.get('second-speech').closed, false); assert.equal(f.sources.length, 1);
  f.session.cancel(); await drain(); assert.ok(f.workers.every(worker => worker.terminated));
});
