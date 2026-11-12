import { ITEM } from '../web/port-contracts.js';
import { domText } from './fixtures/dom.js';
import { accumulateDisplay } from './fixtures/text-accumulator.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { Pipeline } from '../web/pipeline.js';
import { MONO_16KHZ_PCM, TEXT } from '../web/transcription-nodes.js';
import { TabSession } from '../extension/session.js';
import { defaultGraph, graphNode, edge, GRAPH_VERSION } from '../extension/graph.js';

function fixture({ holdLoad = false, holdSource = false, asyncFlush = false, sourceError, stopError, graph, pageConnectionFactory } = {}) {
  const workers = [], sources = [], views = [];
  const session = new TabSession(view => views.push(view), {
    graph: graph ? (graph) : undefined, pageConnectionFactory,
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

test('Number duration is set before model start; saves during load/capture affect only the next session', async () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('Number', 'duration'));
  graph.nodes.at(-1).settings.value = 2.5;
  graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'));
  const f = fixture({ graph, holdLoad: true });
  const starting = f.session.start(42); await drain();
  assert.equal(f.sources.length, 1);
  assert.equal(f.session.session.speechNodes.get('speech').maxDuration, 2.5);
  graph.nodes.at(-1).settings.value = 3.75; f.session.setGraph((graph));
  f.workers.forEach(w => w.reply({ type: 'ready' })); await starting;
  assert.equal(f.session.session.speechNodes.get('speech').core.simulation.maxSamples, 40000);
  graph.nodes.at(-1).settings.value = 1.25; f.session.setGraph((graph));
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
  assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.outputStatus, /output skipped: no authorized toolbar document/);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop();
  assert.equal((domText(f.session.view.displays.transcript) || ''), 'final text'); assert.deepEqual(sent, []);
  f.session.outputTarget = { tabId: 42, documentId: 'authorized', label: 'Page' };
  await f.session.start(42); assert.match(f.session.view.outputStatus, /connected and authorized/);
  f.session.outputTarget.documentId = 'changed';
  f.sources[1].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop();
  assert.deepEqual(sent.filter(([, action]) => action === 'append').map(([target, , value]) => [target.documentId, value.text]), [['authorized', 'final text']]);
  f.session.tabEnded(42); assert.equal(f.session.outputTarget, null);
});
test('field-only graph reports every unavailable destination without adding a fallback view', async () => {
  const f = fixture({ graph: fieldOutputs({ live: false }), pageConnectionFactory() { assert.fail('Unset targets must not connect'); } });
  await f.session.start(42); assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.outputStatus, /No text destination is active/);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain(); await f.session.stop(); assert.equal((domText(f.session.view.displays.transcript) || ''), '');
});
test('portable Display remains an active destination when a focused field is unavailable', async () => {
  const graph = fieldOutputs({ live: false });
  graph.nodes.push(graphNode('Display', 'portable'));
  graph.edges.push(edge('speech', 'final', 'portable', 'input1'));
  const f = fixture({ graph, pageConnectionFactory() { assert.fail('Unset targets must not connect'); } });
  await f.session.start(42);
  assert.equal(f.session.view.state, 'running');
  assert.match(f.session.view.outputStatus, /output skipped/);
  assert.doesNotMatch(f.session.view.outputStatus, /No text destination is active/);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', id: 1, text: 'Portable output' });
  await drain(); assert.equal(domText(f.session.view.displays.portable), 'Portable output');
  await f.session.stop();
});
test('stale document disables focused output while Live continues; cancellation releases capture and workers', async () => {
  const f = fixture({ graph: fieldOutputs(), pageConnectionFactory: () => ({ request: async () => { throw Error('Permission lost'); }, close() {} }) });
  f.session.outputTarget = { tabId: 42, documentId: 'stale', label: 'Page' };
  await f.session.start(42); assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.outputStatus, /Permission lost/);
  f.session.session.speechNodes.get('speech').receiveEvent({ type: 'final', id: 1, text: 'Live continues' }); await drain(); assert.match((domText(f.session.view.displays.transcript) || ''), /Live continues/);
  f.session.cancel(); await drain(); assert.ok(f.workers.every(worker => worker.terminated)); assert.equal(f.sources[0].stops.at(-1), false);
});

test('selected media fails explicitly without selection or tab capture; an independent text path survives', async () => {
  const graph = defaultGraph(); graph.nodes[0].type = 'SelectedPageMediaAudio';
  const f = fixture({ graph });
  await f.session.start();
  assert.equal(f.session.view.state, 'idle');
  assert.match(f.session.view.error, /audio: SelectedPageMediaAudio is temporarily unavailable/);
  assert.match(f.session.view.error, /Choose ChromeTabAudio in Graph Editor/);
  assert.equal(f.session.view.error.split('\n').length, 1);
  assert.equal(f.sources.length, 0);
  graph.nodes.push(graphNode('Text', 'peer'), graphNode('Display', 'peer-output'));
  graph.nodes.at(-2).settings.value = 'Independent output';
  graph.edges.push(edge('peer', 'value', 'peer-output', 'input1'));
  f.session.setGraph(graph);
  await f.session.start(); await drain();
  assert.equal(f.session.view.state, 'running');
  assert.match(f.session.view.error, /SelectedPageMediaAudio/);
  assert.equal(domText(f.session.view.displays['peer-output']), 'Independent output');
  await f.session.stop();
  graph.nodes = graph.nodes.filter(node => node.id !== 'audio');
  graph.edges = graph.edges.filter(route => route.from[0] !== 'audio');
  f.session.setGraph(graph);
  await f.session.start();
  assert.equal(f.session.view.error, '');
  assert.equal(f.session.nodeErrors.size, 0);
  await f.session.stop();
});

test('selected-media limitation is explicit even before a dependent model finishes loading', async () => {
  const graph = defaultGraph(); graph.nodes[0].type = 'SelectedPageMediaAudio';
  const f = fixture({ graph, holdLoad: true });
  const starting = f.session.start(); await drain();
  assert.equal(f.session.view.state, 'loading');
  assert.match(f.session.view.error, /audio: SelectedPageMediaAudio is temporarily unavailable/);
  f.session.cancel(); await starting;
  assert.equal(f.sources.length, 0);
});

test('an unavailable selected-media branch cannot keep a healthy ended capture session running', async () => {
  const graph = defaultGraph();
  graph.nodes.push(graphNode('SelectedPageMediaAudio', 'selected'), graphNode('SpeechToTextReazonSpeech', 'selected-speech'), graphNode('Display', 'selected-output'));
  graph.edges.push(edge('selected', 'audio', 'selected-speech', 'audio'), edge('selected-speech', 'final', 'selected-output', 'input1'));
  const f = fixture({ graph });
  await f.session.start(42);
  assert.equal(f.session.view.state, 'running');
  assert.match(f.session.view.error, /selected: SelectedPageMediaAudio/);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05));
  await drain();
  const owner = f.session.session;
  f.sources[0].onEnded();
  await owner.stopping;
  assert.equal(f.session.view.state, 'idle');
  assert.equal(f.session.session, null);
  assert.equal(domText(f.session.view.displays.transcript), 'final text');
});

test('extension session emits provisional/final output, flushes once and clears repeat transcripts', async () => {
  const { session, workers, sources } = fixture();
  await session.start(42);
  assert.equal(session.view.state, 'running');
  const graph = session.session.pipeline;
  assert.ok(graph instanceof Pipeline);
  assert.deepEqual(graph.order.map(entry => entry.node.constructor.name),
    ['ExtensionTabAudioNode', 'SpeechToTextNode', 'KeyedTextCoalesceNode', 'KeyedTextPairNode', 'KeyedPairedTextAccumulatorNode', 'DisplayNode']);
  assert.equal(graph.entries.get('audio').outputs.audio, MONO_16KHZ_PCM);
  assert.equal(graph.entries.get('speech').inputs.audio, MONO_16KHZ_PCM);
  assert.equal(graph.entries.get('coalesce').inputs.input2, TEXT);
  assert.equal(graph.entries.get('transcript').inputs.input1, ITEM);
  sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain();
  assert.equal((domText(session.view.displays.transcript) || ''), 'provisional text');
  await session.start(99); assert.equal(sources.length, 1, 'live capture cannot be retargeted');
  await Promise.all([session.stop(), session.stop()]); await drain();
  assert.equal((domText(session.view.displays.transcript) || ''), 'final text');
  assert.equal((domText(session.view.displays.transcript) || ''), 'final text'); assert.equal(session.view.state, 'idle');
  assert.deepEqual(sources[0].stops, [true]);
  assert.equal(workers[1].messages.filter(m => m.type === 'vad-stop').length, 1);
  assert.ok(workers.every(w => w.terminated));
  await session.start(99);
  assert.equal((domText(session.view.displays.transcript) || ''), ''); assert.equal((domText(session.view.displays.transcript) || ''), '');
  const before = workers[3].messages.length;
  sources[0].onAudio(new Float32Array(16000)); sources[0].onEnded();
  workers[0].reply({ type: 'error', message: 'stale error' });
  await drain();
  assert.equal(workers[3].messages.length, before);
  assert.equal(session.view.state, 'running'); assert.equal(session.view.error, '');
  await session.cancel(); assert.deepEqual(sources[1].stops, [false]);
  assert.ok(workers.every(w => w.terminated));
});

for (const mode of ['source', 'stop', 'asr']) {
  test(`extension ${mode} failure releases workers/capture and allows retry`, async () => {
    const f = fixture({ sourceError: mode === 'source' ? 'capture failed' : undefined,
      stopError: mode === 'stop' ? 'flush failed' : undefined });
    await f.session.start(42);
    if (mode === 'stop') await f.session.stop();
    if (mode === 'asr') {
      f.workers[0].reply({ type: 'error', message: 'ASR failed' }); await drain();
      assert.equal(f.session.view.state, 'running'); assert.match(f.session.view.error, /ASR failed/);
      await f.session.stop();
    }
    await drain();
    assert.equal(f.session.view.state, 'idle'); assert.match(f.session.view.error, /failed/);
    assert.ok(f.workers.every(w => w.terminated));
    assert.equal(f.sources[0].stops.at(-1), mode === 'asr');
  });
}

test('closing/navigating a target or ending capture finalizes; unrelated tabs do not stop it', async () => {
  const f = fixture(); await f.session.start(42);
  f.sources[0].onAudio(new Float32Array(16000).fill(0.05)); await drain();
  f.session.tabEnded(99); assert.equal(f.session.view.state, 'running');
  f.session.tabEnded(42); f.sources[0].onEnded(); await drain();
  assert.equal(f.session.view.state, 'idle'); assert.equal((domText(f.session.view.displays.transcript) || ''), 'final text');
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

test('toolbar Open remembers its selection and preserves invoking tabs in distinct windows', async () => {
  let invoke, menu; const created = [], items = [];
  const listener = () => ({ addListener() {} });
  let defaultId = 'a';
  const chrome = {
    action: { onClicked: { addListener(callback) { invoke = callback; } } },
    contextMenus: { onClicked: { addListener(callback) { menu = callback; } }, removeAll: async () => {}, create(item, done) { items.push(item); done(); } },
    runtime: { getURL: path => `chrome-extension://id/${path}`, onMessage: listener(), onStartup: listener(), onInstalled: listener() },
    windows: { create: async options => created.push(options) },
  };
  let seq = 0;
  runInNewContext(readFileSync('extension/background.js', 'utf8').replace(/^import .*\n/, ''), {
    chrome, URLSearchParams, crypto: { randomUUID: () => `session-${++seq}` },
    requestLaunchLibrary: async (op, id) => {
      if (op === 'live-check') return id;
      if (op === 'live-open') defaultId = id;
      return { defaultId, graphs: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
    },
  });
  await drain(); assert.equal(created.length, 0);
  invoke({ id: 42 }); menu({ menuItemId: 'live-run:b' }, { id: 99 }); invoke({ id: 12 });
  await drain(); assert.equal(created.length, 3);
  const launches = created.map(item => new URL(item.url).searchParams);
  assert.deepEqual(launches.map(p => [p.get('graph'), p.get('tab')]), [['a', '42'], ['b', '99'], ['b', '12']]);
  assert.equal(new Set(launches.map(p => p.get('session'))).size, 3);
  assert.ok(created.every(item => item.type === 'popup' && item.focused === false));
  assert.equal(defaultId, 'b');
  menu({ menuItemId: 'live-default:a' }, { id: 100 }); await drain();
  assert.equal(defaultId, 'b'); assert.equal(created.length, 3);
  invoke({ id: 77 }); await drain();
  assert.equal(new URL(created[3].url).searchParams.get('graph'), 'b');
  assert.ok(items.some(item => item.id === 'live-graphs' && item.title === 'Graphs'));
  assert.ok(items.some(item => item.id === 'live-open' && item.parentId === 'live-graphs' && item.title === 'Open'));
  assert.ok(items.some(item => item.id === 'live-library' && item.parentId === 'live-graphs'));
  assert.ok(items.filter(item => item.id.startsWith('live-run:')).every(item => item.parentId === 'live-open' && item.type === 'radio' && ['A', 'B'].includes(item.title)));
  assert.ok(!items.some(item => /Live graphs|Default for left-click|Live default/.test(item.title)));
  assert.ok(items.every(item => item.contexts.join() === 'action'));
  assert.ok(items.filter(item => !item.parentId).every(item => item.id === 'live-graphs'));
});

test('failed toolbar selection opens only an error, restores checked state, and serializes refresh storms', async () => {
  const events = {}, items = new Map(), windows = [];
  let creating = false, rejectSelection, empty = false, selected = 'a';
  const event = name => ({ addListener(callback) { events[name] = callback; } });
  const chrome = {
    action: { onClicked: event('action') },
    contextMenus: {
      onClicked: event('menu'),
      async removeAll() { assert.equal(creating, false); items.clear(); },
      create(item, done) {
        assert.equal(creating, false); assert.equal(items.has(item.id), false);
        creating = true; items.set(item.id, item);
        queueMicrotask(() => { creating = false; done(); });
      },
    },
    runtime: { id: 'id', getURL: path => `chrome-extension://id/${path}`, onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
    windows: { create: async options => windows.push(options) },
  };
  runInNewContext(readFileSync('extension/background.js', 'utf8').replace(/^import .*\n/, ''), {
    chrome, URLSearchParams, crypto: { randomUUID: () => 'session' },
    requestLaunchLibrary: (op, id) => {
      if (op === 'live-open') return new Promise((resolve, reject) => { rejectSelection = reject; });
      return Promise.resolve({ defaultId: empty ? null : selected, graphs: empty ? [] : [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    },
  });
  await drain();
  events.menu({ menuItemId: 'live-run:b' }, { id: 81 }); await drain();
  assert.equal(windows.length, 0, 'selection must commit before a launch');
  rejectSelection(Error('Storage quota exceeded')); await drain();
  assert.equal(windows.length, 1);
  const failed = new URL(windows[0].url).searchParams;
  assert.equal(failed.get('tab'), '81'); assert.equal(failed.has('graph'), false);
  assert.match(failed.get('error'), /selection could not be confirmed.*Storage quota.*Graph Library/);
  assert.equal(items.get('live-run:a').checked, true);
  assert.equal(items.get('live-run:b').checked, false);
  // A change during creation schedules another complete pass; only one menu
  // creation/removal may run at once and the final state is the latest one.
  events.startup(); events.installed();
  for (let i = 0; i < 5; i++) events.message({ type: 'graph-library-changed' }, { id: 'id', url: chrome.runtime.getURL('extension/graph-editor.html') });
  selected = 'b'; await drain();
  assert.equal(items.get('live-run:a').checked, false); assert.equal(items.get('live-run:b').checked, true);
  empty = true; events.action({ id: 82 }); await drain();
  const noGraphs = new URL(windows[1].url).searchParams;
  assert.equal(noGraphs.has('graph'), false); assert.match(noGraphs.get('error'), /No runnable graphs.*Graph Library/);
  assert.equal(items.get('live-empty').enabled, false);
  assert.equal(items.get('live-empty').parentId, 'live-open'); assert.equal(items.get('live-library').parentId, 'live-graphs');
});

test('extension artifact allowlist excludes stale weights in every runtime directory and audits all output', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, shutil, json, hashlib
spec = importlib.util.spec_from_file_location('build', 'scripts/build-extension.py')
build = importlib.util.module_from_spec(spec); spec.loader.exec_module(build)
original = build.ROOT
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp); build.ROOT = root
    shutil.copytree(original / 'extension', root / 'extension')
    (root / 'web').mkdir(); (root / 'scripts').mkdir()
    for name in build.SHARED_FILES:
        shutil.copy2(original / 'web' / name, root / 'web' / name)
    shutil.copytree(original / 'web/licenses', root / 'web/licenses')
    entries = []
    for name in ['vendor/sherpa-ja-en', 'vendor/whisper/tiny', 'vendor/zipformer-en', 'vendor/optional-asr', 'vendor/translation', 'tts-assets']:
        directory = root / 'web' / name; directory.mkdir(parents=True)
        # Old generated/checkpoint files must never leak through directory copies.
        for filename in ['model.onnx', 'model.data', 'model.bin', 'model.safetensors', 'voice.htsvoice']:
            (directory / filename).write_bytes(b'old model weights')
        asset = directory / 'engine.wasm'; asset.write_bytes(b'weight-free runtime fixture')
        entries.append(dict(path=str(asset.relative_to(root / 'web')), bytes=asset.stat().st_size, sha256=hashlib.sha256(asset.read_bytes()).hexdigest()))
    (root / 'scripts/extension-runtime-assets.json').write_text(json.dumps(dict(files=entries)))
    build.main()
    target = root / 'dist/chrome-extension'
    inventory = json.loads((target / 'asset-inventory.json').read_text())
    assert inventory['modelWeights'] == 0
    assert not any(p.suffix in build.FORBIDDEN_SUFFIXES for p in target.rglob('*'))
    for name in build.SHARED_FILES:
        assert (target / 'web' / name).read_bytes() == (original / 'web' / name).read_bytes()
    manifest = json.loads((target / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert manifest['options_ui'] == dict(page='extension/model-cache.html', open_in_tab=True)
    assert set(manifest['permissions']) == {'activeTab', 'tabCapture', 'scripting', 'storage', 'offscreen', 'contextMenus'}
    assert 'host_permissions' not in manifest
    assert set(manifest['optional_host_permissions']) == {'http://*/*', 'https://*/*'}
    assert 'wasm-unsafe-eval' in manifest['content_security_policy']['extension_pages']
    # Inventory also fails on accidental weight/preload files outside runtime dirs.
    (target / 'accidental.onnx').write_bytes(b'weights')
    try:
        build.inventory(target); raise AssertionError('weights not detected')
    except RuntimeError:
        pass
    (target / 'accidental.onnx').unlink()
    (target / 'preload.js').write_text('loadPackage({files:[]})')
    try:
        build.inventory(target); raise AssertionError('preload not detected')
    except RuntimeError:
        pass
    (root / 'web' / entries[0]['path']).write_bytes(b'changed runtime')
    try:
        build.main(); raise AssertionError('runtime pin not checked')
    except SystemExit:
        pass
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

function concurrentGraph({ fanout = false } = {}) {
  const graph = defaultGraph();
  graph.nodes.push(graphNode('ChromeTabAudio', 'second-audio'), graphNode('SpeechToTextReazonSpeech', 'second-speech'), graphNode('Display', 'second-display'));
  graph.edges.push(edge(fanout ? 'audio' : 'second-audio', 'audio', 'second-speech', 'audio'), edge('second-speech', 'final', 'second-display', 'append'));
  return accumulateDisplay(graph, 'second-display');
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
      assert.deepEqual(domText(f.session.view.displays.transcript), ['final text'].join('\n'));
      assert.deepEqual(domText(f.session.view.displays['second-display']), ['final text'].join('\n'));
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
  assert.deepEqual(domText(f.session.view.displays.transcript), ['remote'].join('\n'));
  assert.deepEqual(domText(f.session.view.displays['second-display']), ['local'].join('\n'));
  active.audioSources.get('audio').end(); await active.branchDrain;
  assert.equal(f.session.view.state, 'running');
  assert.equal(active.pipeline.entries.get('speech').closed, true);
  assert.equal(active.pipeline.entries.get('second-speech').closed, false);
  assert.equal(f.workers.filter(worker => worker.terminated).length, 2);
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 1, text: 'still local' }); await drain();
  assert.deepEqual(domText(f.session.view.displays['second-display']), ['local', 'still local'].join('\n'));
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
  assert.deepEqual(domText(f.session.view.displays.transcript), ['final text'].join('\n'));
  assert.deepEqual(domText(f.session.view.displays['second-display']), ['final text'].join('\n'));
});

test('parked and incomplete nodes do not load models, request microphone permission or capture', async () => {
  const graph = defaultGraph();
  for (const [type, id] of [['MicrophoneAudio', 'parked-mic'], ['SpeechToTextWhisper', 'parked-model'], ['TextFormatter', 'unfinished'], ['Kokoro', 'parked-tts'], ['Display', 'parked-output']]) graph.nodes.push(graphNode(type, id));
  graph.edges.push(edge('parked-model', 'final', 'unfinished', 'input1'), edge('unfinished', 'text', 'parked-output', 'input1'));
  const f = fixture({ graph }); await f.session.start(42);
  assert.equal(f.session.view.state, 'running'); assert.equal(f.workers.length, 2); assert.equal(f.sources.length, 1);
  assert.deepEqual([...f.session.session.pipeline.entries.keys()], ['audio', 'speech', 'coalesce', 'pair', 'history', 'transcript']);
  assert.deepEqual(f.session.graph, graph); await f.session.stop();
  const draft = { version: GRAPH_VERSION, nodes: graph.nodes.slice(3), edges: [] };
  f.session.setGraph(draft); await f.session.start(42, { microphoneGesture: true });
  assert.match(f.session.view.error, /No executable path/); assert.equal(f.session.view.state, 'idle');
  assert.equal(f.workers.length, 2); assert.equal(f.sources.length, 1);
});

test('a shared formatter stays live after one input path ends', async () => {
  const graph = concurrentGraph(); graph.nodes.push(graphNode('TextFormatter', 'shared'), graphNode('Display', 'combined'));
  graph.nodes.at(-2).settings.template = '{1}/{2}';
  graph.edges.push(edge('speech', 'final', 'shared', 'input1'), edge('second-speech', 'final', 'shared', 'input2'), edge('shared', 'text', 'combined', 'input1'));
  const f = fixture({ graph }); await f.session.start(42); const active = f.session.session;
  active.audioSources.get('audio').end(); await active.branchDrain;
  assert.equal(active.pipeline.entries.get('shared').closed, false);
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 0, text: 'peer' }); await drain();
  assert.match(domText(f.session.view.displays.combined), /peer/); await f.session.stop();
});

for (const mode of ['stop', 'cancel']) test(`held state survives its source ending until session ${mode}; restart clears it`, async () => {
  const graph = concurrentGraph();
  graph.nodes.push(graphNode('Hold', 'held'), graphNode('TextFormatter', 'shared'), graphNode('Display', 'combined'));
  graph.nodes.at(-2).settings.template = '{1}/{2}';
  graph.edges.push(edge('speech', 'final', 'held', 'input'), edge('held', 'value', 'shared', 'input1'),
    edge('second-speech', 'final', 'shared', 'input2'), edge('shared', 'text', 'combined', 'input1'));
  const f = fixture({ graph }); await f.session.start(42); const active = f.session.session;
  const held = active.pipeline.entries.get('held');
  active.speechNodes.get('speech').receiveEvent({ type: 'final', id: 100, text: 'retained' });
  await drain();
  assert.equal(domText(f.session.view.displays.combined), '', 'updating Hold does not trigger its consumer');
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 100, text: 'before' });
  await drain(); assert.equal(domText(f.session.view.displays.combined), 'retained/before');

  active.audioSources.get('audio').end(); await active.branchDrain;
  assert.equal(active.pipeline.entries.get('speech').closed, true);
  assert.equal(f.workers.filter(worker => worker.terminated).length, 2, 'ended source processors are released');
  assert.equal(held.closed, true, 'the ended state input is drained');
  assert.equal(held.node.readOutput('value'), 'retained');
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 101, text: 'after' });
  await drain(); assert.equal(domText(f.session.view.displays.combined), 'retained/after');
  assert.equal(f.session.view.state, 'running'); assert.equal(f.session.view.error, '');

  await f.session[mode]();
  assert.equal(held.node.readOutput('value'), '', 'full-session cleanup releases retained state');
  assert.ok(f.workers.every(worker => worker.terminated));
  await f.session.start(42);
  const next = f.session.session;
  assert.equal(next.pipeline.entries.get('held').node.readOutput('value'), '');
  next.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 100, text: 'fresh' });
  await drain(); assert.equal(domText(f.session.view.displays.combined), '/fresh');
  await f.session.cancel();
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

test('one concurrent model load failure leaves an independent ready model running', async () => {
  const f = fixture({ graph: concurrentGraph(), holdLoad: true });
  const starting = f.session.start(42); await drain(); assert.equal(f.workers.length, 4);
  f.workers[0].reply({ type: 'error', message: 'Model readiness failed' });
  f.workers.slice(2).forEach(worker => worker.reply({ type: 'ready' }));
  await starting; await drain();
  assert.match(f.session.view.error, /Model readiness failed/);
  assert.equal(f.session.view.state, 'running');
  assert.ok(f.workers.slice(0,2).every(worker => worker.terminated));
  f.session.session.speechNodes.get('second-speech').receiveEvent({type:'final',text:'healthy',id:0});
  await drain(); assert.equal(domText(f.session.view.displays['second-display']), 'healthy');
  await f.session.cancel(); assert.ok(f.workers.every(worker => worker.terminated));
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


test('Button paths survive one audio source ending; startup constants do not prevent that ASR branch draining', async () => {
  const graph = concurrentGraph();
  graph.nodes.push(graphNode('Number', 'duration'), graphNode('Button', 'action'), graphNode('Hold', 'manual'), graphNode('Display', 'manual-display'));
  graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'), edge('speech', 'final', 'manual', 'input'),
    edge('action', 'trigger', 'manual', 'trigger'), edge('manual', 'value', 'manual-display', 'input1'));
  const f = fixture({ graph }); await f.session.start(42); const active = f.session.session;
  active.speechNodes.get('speech').receiveEvent({ type: 'final', id: 0, text: 'retained snapshot' }); await drain();
  active.audioSources.get('audio').end(); await active.branchDrain;
  assert.equal(active.pipeline.entries.get('speech').closed, true, 'Number startup configuration cannot keep ASR open');
  assert.equal(active.pipeline.entries.get('action').closed, false);
  assert.equal(active.pipeline.entries.get('manual').closed, false);
  assert.equal(f.session.view.state, 'running');
  assert.equal(await f.session.pressButton('action'), true);
  assert.equal(domText(f.session.view.displays['manual-display']), 'retained snapshot');
  active.speechNodes.get('second-speech').receiveEvent({ type: 'final', id: 0, text: 'still live' }); await drain();
  assert.equal(domText(f.session.view.displays['second-display']), 'still live'); await f.session.stop();
});
