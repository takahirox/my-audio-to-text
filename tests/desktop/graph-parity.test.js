import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { _electron, expect } from '@playwright/test';
import { edge, GRAPH_VERSION, graphNode } from '../../extension/graph.js';

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
  ].map(([type, worker, key, settings]) => {
    const speech = type.startsWith('SpeechToText'), text = type.startsWith('TextProcessing');
    const streaming = type.endsWith('Streaming'), clip = ['Kokoro', 'Supertonic3'].includes(type);
    const source = spec(speech ? 'MicrophoneAudio' : 'Text', 'source');
    const sink = spec(streaming ? 'SpeakerOutput' : clip ? 'AudioOutput' : 'Display', 'output');
    return { worker, key, settings, graph: graph([source, spec(type, 'model', type === 'Kokoro' ? { voice: 'af_heart' } : {}), sink], [
      edge('source', speech ? 'audio' : 'value', 'model', speech ? 'audio' : text ? 'input1' : 'text'),
      edge('model', speech ? 'final' : text ? 'result' : streaming ? 'stream' : clip ? 'audio' : type === 'IfCondition' ? 'yes' : 'text',
        'output', streaming || clip ? 'audio' : 'input1'),
    ]) };
  });
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
