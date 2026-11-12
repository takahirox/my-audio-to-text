import { settleAutoSave } from './ui-controls.js';
import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';
import { startReadyLive, expectPreparedIdle } from './live-lifecycle.js';

// Opt-in production validation for #239. Only capture hardware is replaced.
// Save verifies pinned bytes served from loopback; Live runs with network blocked.
const cases = ['asr-translation', 'held-summary', 'kokoro-en', 'kokoro-ja'];
for (const kind of cases) test(`real Live preparation: ${kind}`, async ({}, info) => {
  test.skip(!process.env.LIVE_MODEL_REAL, 'Prepare pinned assets and build; set LIVE_MODEL_REAL=1.');
  test.setTimeout(600000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'live-model-real-'));
  const root = path.join(temporary, 'extension'), assets = new Map(), requests = [], errors = [], sourceSHA256 = {};
  let context, page, server;
  try {
    await cp('dist/chrome-extension', root, { recursive: true });
    for (const name of ['extension/session.js', 'extension/recorder.js', 'extension/graph-runtime.js', 'web/text-summary-worker.js', 'web/whisper-worker.js', 'web/opus-mt-worker.js', 'web/kokoro-worker.js', 'web/kokoro-english.js', 'web/tts-assets/phonemizer.js']) {
      const bytes = await readFile(name);
      expect((await readFile(path.join(root, name))).equals(bytes), `Rebuild changed source: ${name}`).toBe(true);
      sourceSHA256[name] = createHash('sha256').update(bytes).digest('hex');
    }
    const manifests = kind === 'asr-translation' ? [['opus-mt-assets.json', '.cache/opus-mt']]
      : kind === 'held-summary' ? [['meeting-summary-lfm2-assets.json', '.cache/meeting-summary/01b5a0a33d22253d5ee52b367d2375eeb113b7cd']]
      : [['kokoro-assets.json', '.cache/tts-models/Kokoro-82M-v1.0-ONNX']];
    server = createServer((request, response) => {
      const file = assets.get(decodeURIComponent(request.url));
      if (!file) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Length': file.bytes });
      createReadStream(file.local).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const [name, directory] of manifests) {
      const file = path.join(root, 'extension', name), entries = JSON.parse(await readFile(file, 'utf8'));
      for (const entry of entries) {
        const route = '/' + entry.path;
        assets.set(route, { bytes: entry.bytes, local: path.resolve(directory, entry.path) });
        entry.sourceURL = `http://127.0.0.1:${server.address().port}${route}`;
      }
      await writeFile(file, JSON.stringify(entries));
    }
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'],
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    const base = `chrome-extension://${id}/extension/`;
    await context.addInitScript(() => {
      const NativeWorker = Worker;
      window.graphWorkers = []; window.workerEvents = []; window.permissionCalls = 0;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (...args) => { permissionCalls++; return getUserMedia(...args); };
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args); this.url = String(args[0]); this.messages = []; this.released = false;
          graphWorkers.push(this);
          this.addEventListener('message', ({ data }) => {
            if (data.type !== 'progress') workerEvents.push({ url: this.url, type: data.type, message: data.message, at: performance.now() });
          });
        }
        postMessage(data, ...rest) { this.messages.push({ type: data.type, language: data.language }); super.postMessage(data, ...rest); }
        terminate() { this.released = true; super.terminate(); }
      };
    });
    const editor = await context.newPage(); await editor.goto(base + 'graph-editor.html');
    const text = graphNode('Text', 'text'); text.settings.value = 'The city opened a park in April. Volunteers maintain its shaded trails.';
    let graph;
    if (kind === 'asr-translation') {
      text.settings.value = 'ja';
      graph = { version: GRAPH_VERSION, nodes: [text, graphNode('ChromeTabAudio', 'audio'), graphNode('SpeechToTextWhisper', 'asr'), graphNode('OpusMtJaEn', 'translation'), graphNode('Display', 'output')],
        edges: [edge('text', 'value', 'asr', 'language'), edge('audio', 'audio', 'asr', 'audio'), edge('asr', 'final', 'translation', 'text'), edge('translation', 'text', 'output', 'input1')] };
    } else {
      const model = graphNode(kind === 'held-summary' ? 'TextSummaryLfm2' : 'Kokoro', 'model');
      if (kind.startsWith('kokoro')) {
        model.settings.voice = kind === 'kokoro-en' ? 'af_heart' : 'jf_alpha';
        text.settings.value = kind === 'kokoro-en' ? 'Hello. It is a beautiful day today.' : 'こんにちは。今日は良い天気です。';
      } else model.settings = { language: 'en', prompt: 'Summarize in one short sentence.' };
      graph = { version: GRAPH_VERSION, nodes: [text, graphNode('Button', 'button'), graphNode('Hold', 'hold'), model, graphNode(kind === 'held-summary' ? 'Display' : 'AudioOutput', 'output')],
        edges: [edge('text', 'value', 'hold', 'input'), edge('button', 'trigger', 'hold', 'trigger'), edge('hold', 'value', 'model', 'text'), edge('model', kind === 'held-summary' ? 'summary' : 'audio', 'output', kind === 'held-summary' ? 'input1' : 'audio')] };
    }
    await editor.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), graph);
    await editor.reload(); await settleAutoSave(editor);

    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await expect(editor.locator('#graph-models .model-card')).toHaveAttribute('data-state', 'Ready', { timeout: 180000 });
    expect(await editor.evaluate(() => graphWorkers.length)).toBe(0);
    await context.setOffline(true);
    context.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + 'recorder.html' + (kind === 'asr-translation' ? '?tab=42' : ''));
    await expect(page.locator('#model-status')).toContainText('Preparing models');
    await expect(page.locator('#start')).toBeDisabled();
    const opened = Date.now();
    await expect(page.locator('#model-status')).toHaveText('Ready', { timeout: 180000 });
    const prepareMs = Date.now() - opened;
    const prepared = await page.evaluate(() => ({ workers: graphWorkers.map(w => ({ url: w.url, messages: w.messages })), replies: workerEvents, permissions: permissionCalls }));
    expect(prepared.permissions).toBe(0);
    expect(prepared.workers).toHaveLength(kind === 'asr-translation' ? 3 : 1);
    expect(prepared.workers.every(w => w.messages.length === 1 && w.messages[0].type === 'load')).toBe(true);
    expect(prepared.replies.filter(e => e.type === 'ready')).toHaveLength(prepared.workers.length);
    if (kind === 'asr-translation') {
      expect(prepared.workers.find(w => w.url.endsWith('/whisper-worker.js')).messages[0].language).toBe('ja');
      // Preserve the real audio/VAD/ASR path, substituting only the tab source.
      await page.evaluate(async () => {
        const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
        ExtensionTabAudioNode.prototype.start = function(context) { window.feedAudio = pcm => context.emit('audio', Float32Array.from(pcm)); };
        ExtensionTabAudioNode.prototype.stop = function() {};
      });
    }
    const runs = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      await startReadyLive(page, { timeout: 180000 });
      await expect(page.locator('#session-state')).toHaveAttribute('data-state', 'running');
      const count = await page.evaluate(() => graphWorkers.length);
      if (kind === 'asr-translation') {
        const wav = await readFile('.cache/reazon-ja-en/test_wavs/test_ja_1.wav');
        const fixtures = JSON.parse(await readFile('scripts/reazon-ja-en-assets.json', 'utf8')).fixtures;
        expect(createHash('sha256').update(wav).digest('hex')).toBe(fixtures.find(f => f.path === 'test_wavs/test_ja_1.wav').sha256);
        let sampleRate, pcm;
        for (let offset = 12; offset + 8 <= wav.length;) {
          const size = wav.readUInt32LE(offset + 4), tag = wav.toString('ascii', offset, offset + 4);
          if (tag === 'fmt ') sampleRate = wav.readUInt32LE(offset + 12);
          if (tag === 'data') pcm = Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(offset + 8 + i * 2) / 32768);
          offset += 8 + size + size % 2;
        }
        await page.evaluate(async ({ pcm, sampleRate }) => {
          const { Resampler, joinAudio } = await import('../web/audio.js');
          const resampler = new Resampler(sampleRate), audio = joinAudio([resampler.push(Float32Array.from(pcm)), resampler.flush()]);
          for (let i = 0; i < audio.length; i += 2048) { feedAudio(audio.slice(i, i + 2048)); await new Promise(resolve => setTimeout(resolve, 16)); }
        }, { pcm, sampleRate });
      } else {
        expect(await page.evaluate(() => graphWorkers.filter(w => !w.released).flatMap(w => w.messages).filter(m => ['summarize', 'generate'].includes(m.type)))).toEqual([]);
        await page.locator('#graph-action-buttons button').click();
        if (kind === 'held-summary') await expect(page.locator('#live-displays')).toContainText(/park/i, { timeout: 180000 });
        else {
          await expect(page.locator('#audio-outputs audio')).toHaveCount(1, { timeout: 180000 });
          const waveform = await page.locator('#audio-outputs audio').evaluate(async player => {
            const bytes = await (await fetch(player.src)).arrayBuffer(), context = new AudioContext();
            const buffer = await context.decodeAudioData(bytes), samples = buffer.getChannelData(0);
            const result = { duration: buffer.duration, finite: samples.every(Number.isFinite), rms: Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / samples.length) };
            await context.close(); return result;
          });
          expect(waveform.finite).toBe(true); expect(waveform.rms).toBeGreaterThan(.00001); expect(waveform.duration).toBeGreaterThan(.25);
          runs.push({ repeat, waveform });
        }
        if (kind === 'held-summary') runs.push({ repeat, output: await page.locator('.display-content').textContent() });
      }
      expect(await page.evaluate(() => graphWorkers.length)).toBe(count);
      expect(await page.evaluate(() => lastSessionWorkers.every(w => w.messages.filter(m => m.type === 'load').length === 1))).toBe(true);
      await page.locator('#stop').click();
      await expectPreparedIdle(page, { timeout: 180000 });
      await expect(page.locator('#errors')).toBeEmpty();
      if (kind === 'asr-translation') {
        const output = await page.locator('.display-content').textContent();
        expect(output).toMatch(/[A-Za-z]{3}/); runs.push({ repeat, output });
      }
    }
    await page.evaluate(() => dispatchEvent(new Event('pagehide')));
    await expect.poll(() => page.evaluate(() => graphWorkers.every(w => w.released))).toBe(true);
    await expect(page.locator('#start')).toBeDisabled();
    expect(requests).toEqual([]); expect(errors).toEqual([]);
    await writeFile(info.outputPath('live-real-evidence.json'), JSON.stringify({ kind, time: new Date().toISOString(), sourceSHA256, prepareMs, prepared, runs, requests, errors,
      host: await page.evaluate(() => ({ browser: navigator.userAgent, isolated: crossOriginIsolated })), gpu: (await cdp.send('SystemInfo.getInfo')).gpu,
      cleanup: await page.evaluate(() => graphWorkers.map(w => ({ url: w.url, released: w.released, messages: w.messages }))),
      scope: 'Real production Workers/runtimes and pinned weights. Tab hardware replaced by pinned speech. Worker termination observed; VRAM reclamation is not directly measured.' }, null, 2));
  } finally {
    if (page) await writeFile(info.outputPath('diagnostics.json'), JSON.stringify(await page.evaluate(() => ({ status: document.querySelector('#model-status')?.textContent, errors: document.querySelector('#errors')?.textContent, events: workerEvents })).catch(() => null), null, 2));
    await context?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
