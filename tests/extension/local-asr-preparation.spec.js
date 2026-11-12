import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './graph-fixture.js';
import { settleAutoSave } from './ui-controls.js';
import { graphNode, edge, defaultGraph, GRAPH_VERSION } from '../../extension/graph.js';

test('clean offline model-free graphs stay usable; Auto Save prepares exactly the shared ASR requirements without Workers', async ({ graphExtension: f }) => {
  await installAsrDownloadFixture(f);
  const requests = [], workers = [];
  f.context.on('request', r => { if (/fixture\.bin|^https?:/.test(r.url())) requests.push(r.url()); });
  f.context.on('page', page => page.on('worker', worker => workers.push(worker.url())));
  const models = await f.context.newPage(); await models.goto(f.url.replace('recorder.html', 'model-cache.html'));
  for (const id of ['reazon', 'silero', 'whisper', 'zipformer', 'kokoro-japanese']) await expect(models.locator(`#${id}`)).toHaveAttribute('data-state', 'Not downloaded');
  expect(requests).toEqual([]);
  await f.context.setOffline(true);
  const text = graphNode('Text', 'text'); text.settings.value = 'Offline graph';
  const graph = { version: GRAPH_VERSION, nodes: [text, graphNode('Display', 'output', 350, 20)], edges: [edge('text', 'value', 'output', 'input1')] };
  await models.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), graph);
  const editor = await f.context.newPage(); await editor.goto(f.url.replace('recorder.html', 'graph-editor.html'));
  await editor.getByRole('button', { name: 'Select text', exact: true }).click();
  await editor.getByLabel('text value', { exact: true }).fill('Edited offline');
  await settleAutoSave(editor);
  await expect(editor.locator('#graph-models .model-card')).toHaveCount(0);
  expect(requests).toEqual([]); expect(workers).toEqual([]);
  const live = await f.context.newPage(); await live.goto(f.url);
  await expect(live.locator('#model-status')).toHaveText('Ready');
  await expect(live.locator('#start')).toBeEnabled(); await live.locator('#start').click();
  await expect(live.locator('.display-content')).toContainText('Edited offline');
  expect(requests).toEqual([]); expect(workers).toEqual([]);
  await live.close(); await editor.close();
  await f.context.setOffline(false);
  const asr = defaultGraph(); asr.nodes.push(graphNode('SpeechToTextReazonSpeech', 'duplicate'), graphNode('SpeechToTextWhisper', 'parked'));
  await models.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), asr);
  const edit = await f.context.newPage(); await edit.goto(f.url.replace('recorder.html', 'graph-editor.html'));
  await expect(edit.locator('#graph-models .model-card')).toHaveCount(3);
  expect(requests).toEqual([]);
  await edit.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight');
  await settleAutoSave(edit);
  await expect(edit.locator('#graph-models .model-status')).toHaveText(Array(3).fill('Ready · Cached and verified'));
  expect(workers).toEqual([]);
  expect([...f.requests].sort()).toEqual(['/reazon-assets.json', '/silero-assets.json', '/whisper-assets.json']);
  await expect(models.locator('#zipformer')).toHaveAttribute('data-state', 'Not downloaded');
  await expect(models.locator('#parakeet-v3')).toHaveAttribute('data-state', 'Not downloaded');
});

async function installAsrDownloadFixture(f) {
  for (const key of ['reazon', 'silero', 'whisper', 'zipformer', 'kokoro-japanese']) {
    const file = path.join(f.root, 'extension', `${key}-assets.json`);
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.files[0].sourceURL = f.asset(`${key}-assets.json`, Buffer.alloc(8192, 17));
    await writeFile(file, JSON.stringify(manifest));
  }
}

// Replace large inference engines, retaining the production cache adapters and
// their worker-lifetime leases. No capture or recognition runs during preflight.
async function installAsrRuntimeFixture(f) {
  await installAsrDownloadFixture(f);
  for (const [worker, kind] of [['sherpa', 'reazon'], ['silero', 'silero'], ['whisper', 'whisper'], ['zipformer', 'zipformer']]) {
    await writeFile(path.join(f.root, 'web', `${worker}-worker.js`), `
      self.onmessage = async ({ data }) => {
        if (data.type !== 'load') return;
        try {
          const assets = await import('../extension/local-asr-cache.js');
          ${kind === 'whisper' ? 'await assets.cacheOnlyWhisperRuntime({});' : `await assets.sherpaModelFiles('${kind}');`}
          postMessage({ type: 'ready' });
        } catch (error) { postMessage({ type: 'error', message: error.message }); }
      };
    `);
  }
  await f.context.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.modelWorkers = []; window.pendingLoads = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); this.messages = []; modelWorkers.push(this); }
      postMessage(data, ...rest) {
        this.messages.push(data.type);
        if (data.type === 'load') pendingLoads.push(() => super.postMessage(data, ...rest));
        else super.postMessage(data, ...rest);
      }
    };
    window.releaseModels = () => pendingLoads.splice(0).forEach(send => send());
  });
}
function asrGraph(type) {
  return { version: GRAPH_VERSION,
    nodes: [graphNode('ChromeTabAudio', 'audio'), graphNode(type, 'asr'), graphNode('Display', 'display'),
      graphNode('SpeechToTextParakeetV3', 'parked')],
    edges: [edge('audio', 'audio', 'asr', 'audio'), edge('asr', 'final', 'display', 'input1')] };
}
async function saveAsr(f, type) {
  const manager = await f.context.newPage(); await manager.goto(f.url.replace('recorder.html', 'model-cache.html'));
  await manager.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), asrGraph(type));
  return manager;
}
async function asrReady(page) {
  await expect(page.locator('#model-status')).toContainText('Preparing models…');
  await expect(page.locator('#start')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => pendingLoads.length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => modelWorkers.every(worker => worker.messages.join() === 'load'))).toBe(true);
  await page.evaluate(() => releaseModels());
  await expect(page.locator('#model-status')).toHaveText('Ready');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#errors')).toBeEmpty();
}
for (const [kind, type, dependencies] of [
  ['reazon', 'SpeechToTextReazonSpeech', ['silero', 'reazon']],
  ['whisper', 'SpeechToTextWhisper', ['silero', 'whisper']],
  ['zipformer', 'SpeechToTextZipformerEn', ['zipformer']],
]) test(`Live downloads only ${kind}'s migrated dependencies, gates runtime readiness, and preserves worker cache leases`, async ({ graphExtension: f }) => {
  await installAsrRuntimeFixture(f);
  const manager = await saveAsr(f, type);
  f.mode('hold');
  let live = await f.context.newPage(); await live.goto(`${f.url}?tab=42`);
  await expect(live.locator('#model-status')).toContainText('Downloading model…');
  await expect(live.locator('#start')).toBeDisabled();
  expect(await live.evaluate(() => modelWorkers.length)).toBe(0);
  expect(f.requests).toEqual([`/${dependencies[0]}-assets.json`]);
  f.release(); await asrReady(live);
  expect(f.requests).toEqual(dependencies.map(key => `/${key}-assets.json`));
  // The actual ASR/Whisper cache adapters must retain their migrated files for
  // lazy reads until the inference workers terminate, including shared Silero.
  for (const key of dependencies) {
    const view = await manager.evaluate(async key => {
      const { ModelAssetCache } = await import('./model-asset-cache.js');
      const manifests = await import('./local-asr-cache.js');
      return new ModelAssetCache(await manifests[key + 'Manifest']()).remove();
    }, key);
    expect(view.state).toBe('Error'); expect(view.error).toContain('in use');
  }
  await live.close();
  live = await f.context.newPage(); await live.goto(`${f.url}?tab=42`); await asrReady(live);
  expect(f.requests).toHaveLength(dependencies.length);
  await live.close();
  await expect.poll(() => manager.evaluate(async () => (await navigator.locks.query()).held
    .filter(lock => lock.name.startsWith('model-use:')).length)).toBe(0);
  // Same-length corrupt weights are replaced, while intact shared VAD survives.
  await manager.evaluate(async kind => {
    const { MODEL_CACHE_NAME } = await import('./model-asset-cache.js');
    const manifest = await (await import('./local-asr-cache.js'))[kind + 'Manifest']();
    await (await caches.open(MODEL_CACHE_NAME)).put(manifest.files[0].url, new Response(new Uint8Array(manifest.files[0].bytes)));
  }, kind);
  live = await f.context.newPage(); await live.goto(`${f.url}?tab=42`); await asrReady(live);
  expect(f.requests).toEqual([...dependencies, kind].map(key => `/${key}-assets.json`));
});

test('ReazonSpeech and Whisper Live windows share Silero even when its downloading owner closes', async ({ graphExtension: f }) => {
  await installAsrRuntimeFixture(f);
  const manager = await saveAsr(f, 'SpeechToTextReazonSpeech');
  const graphId = await manager.evaluate(async graph => {
    const { GraphLibrary } = await import('./graph-library.js');
    const library = await new GraphLibrary(localStorage).create({ name: 'Whisper peer', graph });
    return library.graphs.at(-1).id;
  }, asrGraph('SpeechToTextWhisper'));
  f.mode('hold');
  const first = await f.context.newPage(); await first.goto(`${f.url}?tab=42`);
  await expect(first.locator('#model-status')).toContainText('Downloading model… Silero');
  const second = await f.context.newPage(); await second.goto(`${f.url}?tab=42&graph=${graphId}`);
  await expect(second.locator('#model-status')).toContainText('Downloading model… Silero');
  await first.close(); f.release(); await asrReady(second);
  expect(f.requests).toEqual(['/silero-assets.json', '/whisper-assets.json']);
});
