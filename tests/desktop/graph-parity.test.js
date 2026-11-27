import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { _electron, expect } from '@playwright/test';
import { edge, GRAPH_VERSION, graphNode } from '../../extension/graph.js';
import { streamingTtsWorkerFixture, textProcessingWorkerFixture } from '../fixtures/inference-workers.js';
import { moonshineWorkerFixture } from '../fixtures/moonshine-worker.js';
import { observeSpeaker } from '../fixtures/speaker-observer.js';
import { prepareInferenceFixtures } from './graph-inference-fixture.js';

const executable = process.platform === 'darwin'
  ? 'dist/desktop/My Audio to Text.app/Contents/MacOS/my-audio-to-text'
  : 'dist/desktop/my-audio-to-text';
const binary = resolve(process.env.DESKTOP_TEST_BINARY || executable);
const spec = (type, id, settings = {}, x = 20, y = 20) => {
  const node = graphNode(type, id, x, y);
  Object.assign(node.settings, settings);
  return node;
};
const graph = (nodes, edges) => ({ version: GRAPH_VERSION, nodes, edges });
function modelGraph(type, settings = {}) {
  const speech = type.startsWith('SpeechToText'), text = type.startsWith('TextProcessing');
  const streaming = type.endsWith('Streaming'), clip = ['Kokoro', 'Supertonic3'].includes(type);
  const source = speech ? spec('MicrophoneAudio', 'source') : spec('Text', 'source', { value: 'Test input' });
  const sink = spec(streaming ? 'SpeakerOutput' : clip ? 'AudioOutput' : 'Display', 'output', speech ? { inputCount: 2 } : {});
  const output = speech ? 'final' : text ? 'result' : streaming ? 'stream' : clip ? 'audio' : type === 'IfCondition' ? 'yes' : 'text';
  return graph([source, spec(type, 'model', settings), sink], [
    edge('source', speech ? 'audio' : 'value', 'model', speech ? 'audio' : text ? 'input1' : 'text'),
    edge('model', output, 'output', streaming || clip ? 'audio' : 'input1'),
    ...(speech ? [edge('model', 'provisional', 'output', 'input2')] : []),
  ]);
}

const get = page => page.evaluate(() => window.desktop.get());
const phase = async (page, expected) => {
  await expect.poll(async () => (await get(page)).session.phase).toBe(expected);
};
const addLive = async (page, name, graph) => {
  const entry = await page.evaluate(({ name, graph }) => window.desktop.add(name, graph), { name, graph });
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.locator('#live-graph').selectOption(entry.id);
  return entry;
};

async function launch(t, existingProfile) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-graph-parity-'));
  const app = await _electron.launch({
    executablePath: binary, args: ['--user-data-dir=' + (existingProfile || dir)], chromiumSandbox: true, timeout: 30000,
  });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const url = 'local-voice://desktop/desktop/';
  const pages = () => app.windows();
  const management = () => pages().find(page => page.url() === url + 'management.html');
  const runtime = () => pages().find(page => page.url() === url + 'runtime.html');
  await expect.poll(() => Boolean(management() && runtime())).toBe(true);
  const page = management();
  await expect(page.getByRole('heading', { name: 'Saved graphs' })).toBeVisible();
  return { app, page, runtime: runtime(), dir };
}

test('packaged desktop extracts a Subgraph and runs Button, Hold and structured keyed history', { timeout: 45000 }, async t => {
  const { page } = await launch(t);
  const source = graph([
    spec('Text', 'left', { value: 'Before' }, 20, 20),
    spec('Text', 'right', { value: '<b>After</b>' }, 20, 170),
    spec('Number', 'key', { value: 42 }, 20, 320),
    spec('Button', 'action', { label: 'Show held text' }, 20, 450),
    spec('Hold', 'hold', {}, 270, 220),
    spec('KeyedTextPair', 'pair', {}, 540, 25),
    spec('KeyedPairedTextAccumulator', 'history', {}, 800, 25),
    spec('Display', 'view', {}, 1070, 25),
  ], [
    edge('left', 'value', 'pair', 'input1'), edge('key', 'value', 'pair', 'id1'),
    edge('key', 'value', 'pair', 'id2'), edge('right', 'value', 'hold', 'input'),
    edge('action', 'trigger', 'hold', 'trigger'), edge('hold', 'value', 'pair', 'input2'),
    edge('pair', 'pair', 'history', 'pair'), edge('history', 'pairs', 'view', 'input1'),
  ]);
  const entry = await page.evaluate(value => window.desktop.add('Action history', value), source);
  await page.getByRole('article', { name: entry.name, exact: true }).getByRole('button', { name: 'Edit' }).click();
  await page.locator('[data-node="pair"] .graph-heading').click();
  await page.locator('[data-node="history"] .graph-heading').click({ modifiers: ['Shift'] });
  await page.getByRole('button', { name: 'Create Subgraph', exact: true }).click();
  await page.getByRole('dialog', { name: 'Create Subgraph' }).getByRole('button', { name: 'Create Subgraph', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Create Subgraph' })).toBeHidden();
  const definitions = (await get(page)).library.graphs;
  const parent = definitions.find(candidate => candidate.id === entry.id);
  assert.equal(parent.graph.nodes.filter(node => node.type === 'Subgraph').length, 1);
  assert.equal(definitions.filter(candidate => candidate.kind === 'subgraph').length, 1);

  await page.getByRole('button', { name: 'Back to graphs' }).click();
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await page.locator('#live-graph').selectOption(entry.id);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await phase(page, 'running');
  const panel = page.getByRole('tabpanel');
  await expect(panel).toContainText('Before');
  await expect(panel).not.toContainText('After');
  await page.getByRole('button', { name: 'Show held text' }).click();
  await expect(panel).toContainText('<b>After</b>');
  assert.deepEqual((await get(page)).items[0].item, [{ id: 42, first: 'Before', second: '<b>After</b>' }]);
  const old = (await get(page)).session.id;
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await phase(page, 'idle');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await phase(page, 'running');
  await page.evaluate(id => window.desktop.press(id, 'action'), old);
  await expect(panel).not.toContainText('After');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await phase(page, 'idle');
});

test('packaged desktop exports a Subgraph draft after Auto Save rejects it', { timeout: 30000 }, async t => {
  const { app, page, dir } = await launch(t);
  const definition = {
    ...graph([spec('Hold', 'hold')], []),
    interface: {
      inputs: [{ id: 'in1', name: 'Text', node: 'hold', port: 'input' }],
      outputs: [{ id: 'out1', name: 'Held text', node: 'hold', port: 'value' }],
    },
  };
  const entry = await page.evaluate(graph => window.desktop.add('Hold text', graph, 'subgraph'), definition);
  await page.getByRole('article', { name: entry.name, exact: true }).getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'inputs in1 name' }).fill('');
  await expect(page.locator('#graph-state')).toHaveText('Save failed');

  const path = join(dir, 'draft.json');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, path);
  await page.getByLabel('Graph actions', { exact: true }).click();
  await page.getByRole('button', { name: 'Export graph JSON', exact: true }).click();
  const expected = structuredClone(entry.graph);
  expected.interface.inputs[0].name = '';
  await expect.poll(() => readFile(path, 'utf8').then(JSON.parse).catch(() => null)).toEqual(expected);
  assert.deepEqual((await get(page)).library.graphs.find(candidate => candidate.id === entry.id), entry);
});

test('packaged desktop constructs each AI Node and loads each production Worker to its cache or capability boundary', {
  timeout: 45000,
}, async t => {
  const { runtime } = await launch(t);
  const models = [
    ['SpeechToTextMoonshineSmallJa', 'moonshine-small-ja-worker', 'moonshine-small-ja'],
    ['SpeechToTextMoonshineMediumEn', 'moonshine-medium-worker', 'moonshine-medium-en'],
    ['TranslateGemma4B', 'translategemma-worker', 'translategemma', { cacheOnly: true }],
    ['Plamo3Translate2B', 'plamo-worker', 'plamo-3-translate-2b', { cacheOnly: true }],
    ['TextProcessingLfm2', 'text-summary-worker', 'meeting-summary-lfm2', { processor: 'TextProcessingLfm2' }],
    ['TextProcessingQwen35', 'text-summary-worker', 'meeting-summary-qwen35', { processor: 'TextProcessingQwen35' }],
    ['IfCondition', 'if-condition-worker', 'if-condition', { condition: 'Is this a question?' }],
    ['Supertonic3', 'supertonic3-worker', 'supertonic3:F1', { cacheOnly: true, language: 'en', voice: 'F1' }],
    ['Kokoro', 'kokoro-worker', 'kokoro:af_heart', { cacheOnly: true, voice: 'af_heart' }],
    ['Qwen3TtsStreaming', 'qwen3-tts-worker', 'qwen3-tts'],
    ['CosyVoice3Streaming', 'cosyvoice3-worker', 'cosyvoice3'],
  ].map(([type, worker, key, settings]) => ({ worker, key, settings, graph: modelGraph(type, type === 'Kokoro' ? { voice: 'af_heart' } : {}) }));
  const results = await runtime.evaluate(async models => {
    const { buildGraph } = await import('/extension/graph-runtime.js');
    const { graphModelRequirements } = await import('/extension/graph-model-preparation.js');
    const allowlist = await (await fetch('/desktop/model-sources.json')).json();
    return Promise.all(models.map(async model => {
      const { pipeline, description } = buildGraph(model.graph, {});
      const entry = pipeline.entries.get('model');
      const requirements = graphModelRequirements(description);
      const manifests = await Promise.all(requirements.map(item => item.manifest()));
      const pinned = manifests.every((manifest, index) => manifest.files.every(file =>
        allowlist[requirements[index].key][file.sourceURL] === file.bytes));
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker('/web/' + model.worker + '.js', { type: 'module' });
        const timer = setTimeout(() => finish(reject, Error('Worker did not reach its load boundary')), 15000);
        function finish(callback, value) { clearTimeout(timer); worker.terminate(); callback(value); }
        worker.onerror = event => finish(reject, Error(event.message || 'Worker failed to load'));
        worker.onmessage = ({ data }) => { if (data.type === 'error' || data.type === 'ready') finish(resolve, data); };
        worker.postMessage({ type: 'load', id: 1, ...model.settings });
      });
      await pipeline.dispose();
      return { key: requirements.at(-1).key, pinned, outputs: Object.keys(entry.outputs), result };
    }));
  }, models);
  for (const [index, actual] of results.entries()) {
    const { key } = models[index];
    assert.equal(actual.key, key);
    assert.ok(actual.pinned && actual.outputs.length, key);
    assert.equal(actual.result.type, 'error', key);
    assert.match(actual.result.message, /(?:missing|evicted|WebGPU|WebAssembly JSPI|not (?:downloaded|prepared))/i, key);
    assert.doesNotMatch(actual.result.message, /can't find|failed to fetch|Worker script|requires an extension/i, key);
  }
});

test('packaged desktop delivers deterministic inference through Live Display, Audio player and Speaker', { timeout: 60000 }, async t => {
  const { app, page, runtime } = await launch(t);
  const replyTo = (request, result) => `self.onmessage = ({ data: { type, id, text } }) => {
    if (type === 'load') postMessage({ type: 'ready', id });
    if (type === '${request}') postMessage({ type: 'result', id, ${result} });
    if (type === 'drain') postMessage({ type: 'drained', id });
  };`;
  const models = [
    ['SpeechToTextMoonshineMediumEn', 'moonshine-medium-en', 'moonshine-medium', moonshineWorkerFixture()],
    ['TranslateGemma4B', 'translategemma', 'translategemma', replyTo('translate', 'texts: [text + " translated by Gemma"]'), 'Test input translated by Gemma'],
    ['Plamo3Translate2B', 'plamo-3-translate-2b', 'plamo', replyTo('translate', 'texts: [text + " translated by PLaMo"]'), 'Test input translated by PLaMo', 'plamo'],
    ['TextProcessingQwen35', 'meeting-summary-qwen35', 'text-summary', textProcessingWorkerFixture, 'Ready summary'],
    ['Supertonic3', 'supertonic3:F1', 'supertonic3', replyTo('generate',
      'audio: { samples: new Float32Array(4410).fill(.25), sampleRate: 44100, channels: 1 }'), null, 'supertonic3'],
    ['Qwen3TtsStreaming', 'qwen3-tts', 'qwen3-tts', streamingTtsWorkerFixture],
    ['CosyVoice3Streaming', 'cosyvoice3', 'cosyvoice3', streamingTtsWorkerFixture],
  ].map(([type, key, worker, script, expected, manifest = key]) => ({ type, key, worker, script, expected, manifest, graph: modelGraph(type) }));
  await prepareInferenceFixtures(app, runtime, models);
  await runtime.evaluate(observeSpeaker);

  const start = page.getByRole('button', { name: 'Start', exact: true });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  const item = port => expect.poll(async () => (await get(page)).items.find(item => item.node === 'output' && item.port === port)?.item);
  for (const { type, graph, expected } of models) await t.test(type, async () => {
    await addLive(page, type, graph);
    await runtime.evaluate(() => { window.speakerEvents.length = 0; });
    try {
      await start.click();
      await phase(page, 'running');
      if (type === 'SpeechToTextMoonshineMediumEn') {
        await item('input2').toBe('pending fixture');
      } else if (type === 'Supertonic3') {
        const player = page.getByLabel('Generated speech · output');
        await expect(player).toBeVisible();
        await expect.poll(() => player.evaluate(audio => audio.duration)).toBeCloseTo(.1, 3);
        const [{ node, audio }] = await page.evaluate(() => window.desktop.audio());
        assert.equal(node, 'output');
        assert.equal(audio.sampleRate, 44100);
        assert.equal(audio.channels, 1);
        assert.deepEqual(audio.samples, new Float32Array(4410).fill(.25));
      } else if (type.endsWith('Streaming')) {
        const scheduled = () => runtime.evaluate(() => window.speakerEvents.filter(event => event.type === 'start'));
        await expect.poll(async () => (await scheduled()).length).toBe(3);
        assert.ok((await scheduled()).every(event => Math.abs(event.duration - .1) < .001));
      } else {
        await item('input1').toBe(expected);
        await expect(page.getByRole('tabpanel')).toContainText(expected);
      }
      assert.deepEqual((await get(page)).nodeStatus.filter(status => status.severity === 'error'), []);
      await stop.click();
      await phase(page, 'idle');
      if (type === 'SpeechToTextMoonshineMediumEn') {
        await item('input1').toBe('confirmed fixture');
        await item('input2').toBe('');
      }
      const view = await get(page);
      assert.equal(view.session.error, '');
    } finally {
      if ((await get(page)).session.phase !== 'idle') await page.evaluate(() => window.desktop.cancel());
    }
  });
});

const mediumAsr = {
  key: 'moonshine-medium-en', worker: 'moonshine-medium', manifest: 'moonshine-medium-en',
  script: moonshineWorkerFixture(), graph: modelGraph('SpeechToTextMoonshineMediumEn'),
};
const japaneseAsr = {
  key: 'moonshine-small-ja', worker: 'moonshine-small-ja', manifest: 'moonshine-small-ja',
  script: moonshineWorkerFixture(), graph: modelGraph('SpeechToTextMoonshineSmallJa'),
};

async function useSyntheticMicrophones(runtime) {
  await runtime.evaluate(async () => {
    const { Microphone } = await import('/web/audio.js');
    // Use the real capture lifecycle with synthetic media tracks.
    delete Microphone.prototype.start;
    window.captureTracks = [];
    Microphone.prototype.getMedia = function () {
      const { stream } = this.context.createMediaStreamDestination();
      window.captureTracks.push(...stream.getAudioTracks());
      return stream;
    };
  });
  return () => runtime.evaluate(() => window.captureTracks.map(track => track.readyState));
}

async function shortcutInference(app, page, runtime, models) {
  await prepareInferenceFixtures(app, runtime, models);
  const tracks = await useSyntheticMicrophones(runtime);
  await runtime.evaluate(() => {
    const NativeWorker = window.Worker;
    window.moonshineWorkers = {};
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        const worker = url.pathname.match(/\/(moonshine-[\w-]+)-worker\.js$/)?.[1];
        if (worker) window.moonshineWorkers[worker] = this;
      }
    };
  });
  await app.evaluate(({ app }) => {
    const { createRequire } = process.getBuiltinModule('node:module');
    const { FocusedTarget } = createRequire(`${app.getAppPath()}/package.json`)('./desktop/focused-target.js');
    const request = FocusedTarget.prototype.request;
    globalThis.testInsertions = [];
    FocusedTarget.prototype.request = function (action, token, text) {
      if (action === 'shortcut-context') globalThis.releaseTestShortcut = shortcut => this.onShortcut(shortcut, text);
      if (action === 'insert') globalThis.testInsertions.push(text);
      if (['authorize', 'insert', 'release'].includes(action)) return Promise.resolve();
      return request.call(this, action, token, text);
    };
  });
  const shortcut = 'Control+Alt+Shift+F8';
  await page.evaluate(value => window.desktop.shortcut(value), shortcut);
  return {
    start: () => app.evaluate((_electron, shortcut) => globalThis.releaseTestShortcut(shortcut), shortcut),
    fail: worker => runtime.evaluate(key => window.moonshineWorkers[key].postMessage({ type: 'fixture-error' }), worker),
    tracks,
    indicator: app.windows().find(page => page.url().endsWith('/indicator.html')),
  };
}

test('packaged desktop shows recording with one live microphone during Start and Stop', { timeout: 30000 }, async t => {
  const { app, page, runtime } = await launch(t);
  await prepareInferenceFixtures(app, runtime, [mediumAsr]);
  const tracks = await useSyntheticMicrophones(runtime);
  await addLive(page, 'Two microphones', graph([
    ...mediumAsr.graph.nodes, spec('MicrophoneAudio', 'second-source'),
    spec('SpeechToTextMoonshineMediumEn', 'second-model'), spec('Display', 'second-output'),
  ], [
    ...mediumAsr.graph.edges, edge('second-source', 'audio', 'second-model', 'audio'),
    edge('second-model', 'final', 'second-output', 'input1'),
  ]));
  await runtime.evaluate(async () => {
    const { Microphone } = await import('/web/audio.js');
    const { getMedia, stop } = Microphone.prototype;
    Microphone.prototype.getMedia = async function () {
      if (window.captureTracks.length === 1) await new Promise(resolve => { window.resumeCaptureStart = resolve; });
      return getMedia.call(this);
    };
    Microphone.prototype.stop = async function (flush = true) {
      if (flush && window.captureTracks.filter(track => track.readyState === 'ended').length === 1) {
        await new Promise(resolve => { window.resumeCaptureStop = resolve; });
      }
      return stop.call(this, flush);
    };
  });
  const indicator = app.windows().find(page => page.url().endsWith('/indicator.html')).locator('body');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await runtime.waitForFunction(() => Boolean(window.resumeCaptureStart));
  await phase(page, 'preparing');
  assert.deepEqual(await tracks(), ['live']);
  const duringStart = await indicator.getAttribute('data-recording');

  await runtime.evaluate(() => window.resumeCaptureStart());
  await phase(page, 'running');
  assert.deepEqual(await tracks(), ['live', 'live']);
  await expect(indicator).toHaveAttribute('data-recording', 'true');

  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await runtime.waitForFunction(() => Boolean(window.resumeCaptureStop));
  await phase(page, 'stopping');
  assert.deepEqual((await tracks()).sort(), ['ended', 'live']);
  const duringStop = await indicator.getAttribute('data-recording');

  await runtime.evaluate(() => window.resumeCaptureStop());
  await phase(page, 'idle');
  assert.deepEqual(await tracks(), ['ended', 'ended']);
  assert.equal((await get(page)).session.error, '');
  await expect(indicator).toHaveAttribute('data-recording', 'false');
  assert.deepEqual({ duringStart, duringStop }, { duringStart: 'true', duringStop: 'true' });
});

test('packaged desktop stops default shortcut dictation, releases capture and shows the fatal Japanese ASR error', {
  timeout: 30000,
}, async t => {
  const { app, page, runtime } = await launch(t);
  const shortcut = await shortcutInference(app, page, runtime, [japaneseAsr]);
  await shortcut.start();
  await phase(page, 'running');
  await expect(shortcut.indicator.locator('#state')).toHaveText('Recording');
  assert.deepEqual(await shortcut.tracks(), ['live']);

  await shortcut.fail(japaneseAsr.worker);
  await expect(shortcut.indicator.locator('#state')).toContainText('Controlled worker failure');
  await phase(page, 'idle');
  await expect(shortcut.indicator.locator('body')).toHaveAttribute('data-recording', 'false');
  assert.deepEqual(await shortcut.tracks(), ['ended']);
  assert.deepEqual(await app.evaluate(() => globalThis.testInsertions), []);
});

test('packaged desktop releases capture after the last ASR route fails and keeps an independent focused action running', {
  timeout: 30000,
}, async t => {
  const { app, page, runtime } = await launch(t);
  const shortcut = await shortcutInference(app, page, runtime, [mediumAsr, japaneseAsr]);
  const mixed = graph([...mediumAsr.graph.nodes,
    spec('Text', 'phrase', { value: 'Independent text' }), spec('Button', 'action', { label: 'Insert text' }),
    spec('Hold', 'hold'), spec('FocusedInputTextOutputNode', 'focused'),
    spec('SpeechToTextMoonshineSmallJa', 'japanese'), spec('Display', 'japanese-output'),
  ], [...mediumAsr.graph.edges,
    edge('phrase', 'value', 'hold', 'input'), edge('action', 'trigger', 'hold', 'trigger'),
    edge('hold', 'value', 'focused', 'text'),
    edge('source', 'audio', 'japanese', 'audio'), edge('japanese', 'final', 'japanese-output', 'input1'),
  ]);
  await page.evaluate(async mixed => {
    const entry = await window.desktop.add('Mixed dictation and action', mixed);
    await window.desktop.select(entry.id);
  }, mixed);
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await shortcut.start();
  await phase(page, 'running');
  const action = page.getByRole('button', { name: 'Insert text' });
  await expect(action).toBeEnabled();

  await shortcut.fail(mediumAsr.worker);
  await expect(page.locator('#node-status [data-severity="error"]')).toHaveText(/model · .*Controlled worker failure/);
  await expect(shortcut.indicator.locator('#state')).toHaveText('Recording');
  assert.deepEqual(await shortcut.tracks(), ['live']);
  await runtime.evaluate(key => window.moonshineWorkers[key].postMessage({ type: 'fixture-final', id: 0, text: 'Remaining route' }), japaneseAsr.worker);
  await expect.poll(async () => (await get(page)).items.find(item => item.node === 'japanese-output')?.item).toBe('Remaining route');

  await shortcut.fail(japaneseAsr.worker);
  await expect(shortcut.indicator.locator('#state')).toContainText('Controlled worker failure');
  await expect(shortcut.indicator.locator('body')).toHaveAttribute('data-recording', 'false');
  await expect(page.locator('#live-state')).toHaveText('Running');
  assert.deepEqual(await shortcut.tracks(), ['ended']);
  assert.equal((await get(page)).session.phase, 'running');
  await action.click();
  await expect.poll(() => app.evaluate(() => globalThis.testInsertions)).toEqual(['Independent text']);
  await expect(page.locator('#live-models')).toContainText('Moonshine Medium');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await phase(page, 'idle');
  assert.equal((await get(page)).session.error, '');
});

test('packaged Live shows models for the executable graph and retains them across a save during recording', {
  timeout: 30000,
}, async t => {
  const { app, page, runtime } = await launch(t);
  await prepareInferenceFixtures(app, runtime, [mediumAsr]);
  await useSyntheticMicrophones(runtime);
  const entry = await addLive(page, 'Editable Live graph', mediumAsr.graph);
  const badges = page.locator('#live-models button');
  await expect(badges).toHaveText([/Moonshine Medium/]);
  const start = page.getByRole('button', { name: 'Start', exact: true });
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await start.click();
  await phase(page, 'running');

  const replacement = graph([
    spec('Text', 'source', { value: 'Saved text' }), spec('Display', 'output'), spec('SpeechToTextMoonshineSmallJa', 'parked'),
  ], [
    edge('source', 'value', 'output', 'input1'),
  ]);
  await page.evaluate(({ entry, replacement }) => window.desktop.save(entry.id, entry.revision, replacement), { entry, replacement });
  await expect(badges).toHaveText([/Moonshine Medium.*Ready/]);
  await expect(page.locator('#live-state')).toHaveText('Recording');
  await stop.click();
  await phase(page, 'idle');
  await expect(page.locator('#live-models')).toBeHidden();

  await start.click();
  await phase(page, 'running');
  await expect(page.getByRole('tabpanel')).toContainText('Saved text');
  await expect(page.locator('#live-models')).toBeHidden();
  await stop.click();
  await phase(page, 'idle');
});

test('packaged model preparation rejects foreign requests, cancels, retries and detects corrupt pinned bytes', {
  timeout: 45000,
}, async t => {
  const { app, page, runtime } = await launch(t);
  const active = 'if-condition', other = 'moonshine-small-ja';
  const [source, otherSource] = await runtime.evaluate(async ({ active, other }) => {
    const allowlist = await (await fetch('/desktop/model-sources.json')).json();
    return [Object.keys(allowlist[active])[0], Object.keys(allowlist[other])[0]];
  }, { active, other });
  await app.evaluate((_electron, pinned) => {
    globalThis.desktopTestFetches = [];
    globalThis.fetch = async (url, { signal }) => {
      globalThis.desktopTestFetches.push(String(url));
      if (String(url) !== pinned) throw Error('Unexpected URL');
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          if (globalThis.desktopTestCorrupt) {
            controller.enqueue(new TextEncoder().encode('corrupt fixture bytes'));
            controller.close();
          }
        },
      }));
    };
  }, source);
  const preparing = page.evaluate(key => window.desktop.model('modelPrepare', key), active);
  await expect.poll(() => app.evaluate(() => globalThis.desktopTestFetches.length)).toBe(1);
  const tryAsset = (page, source) => page.evaluate(async source => {
    const url = '/model-asset?source=' + encodeURIComponent(source);
    return fetch(url, { signal: AbortSignal.timeout(2000) }).then(response => response.status).catch(error => error.name);
  }, source);
  assert.equal(await tryAsset(runtime, otherSource), 404);
  assert.equal(await tryAsset(runtime, source + '?modified=true'), 404);
  assert.notEqual(await tryAsset(page, source), 'TimeoutError');
  assert.equal(await app.evaluate(() => globalThis.desktopTestFetches.length), 1);
  await page.evaluate(key => window.desktop.model('modelCancel', key), active);
  assert.equal((await preparing).state, 'Canceled');
  await app.evaluate(() => { globalThis.desktopTestCorrupt = true; });
  const corrupt = await page.evaluate(key => window.desktop.model('modelPrepare', key), active);
  assert.equal(corrupt.state, 'Error');
  assert.match(corrupt.error, /Incomplete asset|Incorrect size|Corrupt asset/);
  assert.equal((await page.evaluate(key => window.desktop.model('modelStatus', key), active)).state, 'Not downloaded');
  assert.equal((await page.evaluate(key => window.desktop.model('modelStatus', key), other)).state, 'Not downloaded');
});

test('packaged Kokoro Worker initializes Open JTalk from its prepared Japanese voice', { timeout: 45000 }, async t => {
  const { app, page, runtime } = await launch(t);
  const voice = await page.evaluate(() => window.desktop.model('modelPrepare', 'kokoro-japanese'));
  assert.equal(voice.state, 'Ready', voice.error);
  await app.evaluate(() => {
    globalThis.fetch = () => { throw Error('Voice preparation is already complete'); };
  });

  const workerReady = runtime.waitForEvent('worker', { timeout: 5000 });
  await runtime.evaluate(() => { window.kokoroWorker = new Worker('/web/kokoro-worker.js', { type: 'module' }); });
  const worker = await workerReady;
  const phonemes = await worker.evaluate(async () => {
    const { createJapanesePhonemizer } = await import('/web/kokoro-japanese.js');
    const phonemize = await createJapanesePhonemizer();
    return phonemize('こんにちは。');
  });
  assert.match(phonemes, /^k.+[.!?]$/);
  await runtime.evaluate(() => window.kokoroWorker.terminate());
});

test('packaged Models inspect the selected cache after switching during a check', { timeout: 30000 }, async t => {
  const { app, page, runtime } = await launch(t);
  const key = 'kokoro:af_heart';
  await prepareInferenceFixtures(app, runtime, [{
    key, worker: 'kokoro', script: '', manifest: 'kokoro',
    graph: modelGraph('Kokoro', { voice: 'af_heart' }),
  }]);
  await runtime.evaluate(() => {
    const open = CacheStorage.prototype.open;
    CacheStorage.prototype.open = function (name) {
      return new Promise(resolve => {
        window.releaseInspection = () => {
          CacheStorage.prototype.open = open;
          resolve(open.call(this, name));
        };
      });
    };
  });
  const status = page.locator('#model-status');
  await page.getByRole('button', { name: 'Models', exact: true }).click();
  await runtime.waitForFunction(() => Boolean(window.releaseInspection));
  await expect(status).toHaveText('Checking cache…');
  await page.getByLabel('Model', { exact: true }).selectOption(key);
  await expect(status).toHaveText('Unchecked');
  await runtime.evaluate(() => window.releaseInspection());
  await expect(status).toHaveText('Ready');
  await expect(page.locator('#delete-model')).toBeEnabled();
});

test('packaged desktop runs prepared CPU and WebGPU models offline and saves real speech as WAV', {
  skip: process.env.DESKTOP_REAL_GRAPH_MODELS !== '1', timeout: 600000,
}, async t => {
  const { app, page, runtime, dir } = await launch(t, process.env.DESKTOP_GRAPH_TEST_PROFILE);
  const status = (action, key) => page.evaluate(({ action, key }) => window.desktop.model(action, key), { action, key });
  const capability = await runtime.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    return { isolated: crossOriginIsolated, f16: adapter?.features.has('shader-f16') };
  });
  assert.deepEqual(capability, { isolated: true, f16: true });
  for (const key of ['if-condition', 'meeting-summary-lfm2', 'kokoro:af_heart']) {
    const view = await status('modelPrepare', key);
    assert.equal(view.state, 'Ready', JSON.stringify({ key, view }));
  }
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.desktopTestOfflineAttempts = 0;
    globalThis.fetch = () => { ++globalThis.desktopTestOfflineAttempts; throw Error('Network disabled by offline smoke'); };
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/runtime.html')).webContents.setAudioMuted(true);
  });

  const classify = graph([
    spec('Text', 'question', { value: 'What time does the meeting begin?' }),
    spec('IfCondition', 'classifier'), spec('Display', 'decision', { inputCount: 2 }),
  ], [
    edge('question', 'value', 'classifier', 'text'), edge('classifier', 'yes', 'decision', 'input1'),
    edge('classifier', 'no', 'decision', 'input2'),
  ]);
  const summarize = graph([
    spec('Text', 'notes', { value: 'The project meeting is on Monday. Review last week’s budget.' }),
    spec('TextProcessingLfm2', 'summary', { prompt: 'Summarize Input 1 in one sentence in English.' }),
    spec('Display', 'result'),
  ], [edge('notes', 'value', 'summary', 'input1'), edge('summary', 'result', 'result', 'input1')]);
  const speech = graph([
    spec('Text', 'phrase', { value: 'Hello from the desktop application.' }),
    spec('Kokoro', 'synthesis', { voice: 'af_heart' }), spec('AudioOutput', 'player'), spec('SpeakerOutput', 'speaker'),
  ], [
    edge('phrase', 'value', 'synthesis', 'text'), edge('synthesis', 'audio', 'player', 'audio'),
    edge('synthesis', 'audio', 'speaker', 'audio'),
  ]);

  const combined = graph([...classify.nodes, ...summarize.nodes], [...classify.edges, ...summarize.edges]);
  await addLive(page, 'Offline CPU classification and WebGPU summarization', combined);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const item = node => expect.poll(async () => (await get(page)).items.find(item => item.node === node)?.item, { timeout: 120000 });
  await item('decision').toBe('What time does the meeting begin?');
  await item('result').toMatch(/\S/);
  await assert.rejects(status('modelDelete', 'if-condition'), /Stop the active session/);
  await assert.rejects(status('modelDelete', 'meeting-summary-lfm2'), /Stop the active session/);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await phase(page, 'idle');
  await runtime.evaluate(() => {
    const resume = AudioContext.prototype.resume;
    const createSource = AudioContext.prototype.createBufferSource;
    let started = false, outputAvailable = false;
    AudioContext.prototype.resume = function () {
      if (started) outputAvailable = true;
      started = true;
      return resume.call(this);
    };
    AudioContext.prototype.createBufferSource = function () {
      if (!outputAvailable) throw Error('Test device refused the first playback source');
      return createSource.call(this);
    };
  });
  await addLive(page, 'Offline Kokoro playback and WAV', speech);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  const player = page.getByLabel('Generated speech · player');
  await expect(player).toBeVisible({ timeout: 120000 });
  await expect.poll(() => player.evaluate(element => element.readyState)).toBeGreaterThan(0);
  const speaker = page.getByRole('button', { name: 'Enable speaker' });
  await expect(speaker).toBeVisible();
  await speaker.click();
  await expect(speaker).toBeHidden();
  const file = join(dir, 'speech.wav');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, file);
  await page.getByRole('button', { name: 'Save WAV' }).click();
  await expect.poll(async () => (await readFile(file).catch(() => Buffer.alloc(0))).length).toBeGreaterThan(44);
  const wav = await readFile(file);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await phase(page, 'idle');
  assert.equal((await get(page)).session.error, '');
  assert.equal(await app.evaluate(() => globalThis.desktopTestOfflineAttempts), 0);
  assert.equal((await status('modelStatus', 'meeting-summary-lfm2')).state, 'Ready');
  assert.equal((await status('modelDelete', 'if-condition')).state, 'Not downloaded');
  assert.equal((await status('modelStatus', 'kokoro:af_heart')).state, 'Ready');
});
