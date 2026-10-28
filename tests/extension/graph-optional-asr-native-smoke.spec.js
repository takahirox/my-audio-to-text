import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('real concurrent Parakeet v3 and Moonshine Medium: native tab capture, Live/formatter/focused field, repeat and resource release', async ({}, info) => {
  test.skip(!process.env.OPTIONAL_ASR_SMOKE, 'Opt in with OPTIONAL_ASR_SMOKE=1 after optional ASR validation asset preparation.');
  test.setTimeout(300000);
  const specs = await Promise.all(['parakeet-v3', 'moonshine-medium-en'].map(async key => ({ key, spec: JSON.parse(await readFile(`extension/${key}-assets.json`, 'utf8')) })));
  const files = new Map();
  for (const { key, spec } of specs) for (const entry of spec.files) files.set(`/${key}/${entry.path}`, path.resolve(`.cache/new-asr/${key}/${entry.path}`));
  const wav = await readFile('.cache/zipformer-en/test_wavs/0.wav');
  const zip = JSON.parse(await readFile('scripts/zipformer-assets.json', 'utf8'));
  expect(createHash('sha256').update(wav).digest('hex')).toBe(zip.files.find(file => file.path === 'test_wavs/0.wav').sha256);
  const server = createServer((req, res) => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    if (files.has(req.url)) { res.writeHead(200, headers); createReadStream(files.get(req.url)).pipe(res); }
    else if (req.url === '/speech.wav') { res.writeHead(200, { ...headers, 'Content-Type': 'audio/wav' }); res.end(wav); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Optional ASR capture check</title><button>Play</button><audio src="/speech.wav"></audio><textarea>prefix</textarea><script>document.querySelector("button").onclick=()=>document.querySelector("audio").play()</script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await mkdtemp(path.join(tmpdir(), 'native-optional-asr-')); const runs = [], requests = [], errors = []; let context, host;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'], args: ['--enable-unsafe-extension-debugging'] });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: path.resolve('dist/chrome-extension') });
    const resources = async () => {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const pids = processInfo.map(p => p.id).filter(id => Number.isSafeInteger(id) && id > 0);
      const rssKiB = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' }).trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0);
      return { cpuSeconds: processInfo.reduce((sum, p) => sum + p.cpuTime, 0), rssKiB };
    };
    await context.addInitScript(() => {
      const NativeWorker = Worker; window.workers = [];
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); window.workers.push(this); }
        terminate() { this.released = true; super.terminate(); }
      };
    });
    const live = await context.newPage(); live.on('pageerror', e => errors.push(e.message));
    await live.goto(`chrome-extension://${id}/extension/recorder.html`);
    host = await live.evaluate(async () => {
      const adapter = await navigator.gpu.requestAdapter();
      return { browser: navigator.userAgent, isolated: crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency,
        gpu: { vendor: adapter?.info.vendor, architecture: adapter?.info.architecture, description: adapter?.info.description, features: [...adapter.features] } };
    });
    await live.evaluate(async ({ specs, port }) => {
      const { defineAssetSet, ModelAssetCache } = await import('./model-asset-cache.js');
      for (const { key, spec } of specs) {
        const manifest = defineAssetSet({ ...spec, files: spec.files.map(file => ({ ...file, sourceURL: `http://127.0.0.1:${port}/${key}/${file.path}` })) });
        const view = await new ModelAssetCache(manifest).prepare(); if (view.state !== 'Ready') throw Error(JSON.stringify(view));
      }
      const { defaultGraph, graphNode, edge, saveGraph, GRAPH_KEY } = await import('./graph.js');
      const graph = defaultGraph(); graph.nodes[1].type = 'SpeechToTextParakeetV3'; graph.edges = graph.edges.filter(e => e.from[1] !== 'provisional');
      graph.nodes.push(graphNode('SpeechToTextMoonshineMediumEn', 'moonshine'), graphNode('TextFormatter', 'format'), graphNode('LiveTextDisplay', 'medium'), graphNode('FocusedInputTextOutputNode', 'field'), graphNode('TextAccumulator', 'medium-accumulator'));
      graph.nodes.find(n => n.id === 'format').settings.template = 'Moonshine: {1}';
      graph.edges.push(edge('audio', 'audio', 'moonshine', 'audio'), edge('moonshine', 'final', 'format', 'input1'), edge('format', 'text', 'medium-accumulator', 'append'), edge('medium-accumulator', 'text', 'medium', 'content'), edge('moonshine', 'provisional', 'medium-accumulator', 'preview'), edge('speech', 'final', 'field', 'text'));
      saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
      for (const [module, name] of [['parakeet-v3-node', 'SpeechToTextParakeetV3Node'], ['moonshine-medium-node', 'SpeechToTextMoonshineMediumEnNode']]) {
        const Node = (await import(`../web/${module}.js`))[name], receive = Node.prototype.receiveEvent;
        Node.prototype.receiveEvent = function(event) { window.events.push({ node: name, ...event, ms: performance.now() }); return receive.call(this, event); };
      }
      window.events = [];
    }, { specs, port: server.address().port });
    // Verify browser CORS for the official Moonshine host before offline inference.
    expect(await live.evaluate(async () => (await fetch('https://download.moonshine.ai/model/medium-streaming-en/quantized_26_07_30/streaming_config.json')).status)).toBe(200);
    const website = await context.newPage(); await website.goto(`http://127.0.0.1:${server.address().port}/`);
    context.on('request', req => { if (/^https?:/.test(req.url())) requests.push({ url: req.url(), method: req.method(), hasBody: req.postData() !== null }); });
    await context.route(/^https?:/, route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    for (let repeat = 0; repeat < 2; repeat++) {
      await website.locator('textarea').fill('prefix');
      await live.evaluate(() => { window.events = []; });
      const before = await resources(), start = Date.now();
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
      await cdp.send('Extensions.triggerAction', { id, targetId: targetInfos.find(t => t.url === website.url()).targetId });
      await expect(live.locator('#status')).toHaveText('Transcription active', { timeout: 120000 });
      await expect(live.locator('#errors')).toBeEmpty(); const loaded = Date.now(), samples = [await resources()];
      expect(await live.evaluate(() => window.workers.filter(w => !w.released).length)).toBe(2);
      await website.locator('button').click(); await website.locator('textarea').click();
      await expect(live.locator('#signal')).toContainText('Audio signal detected');
      await expect.poll(() => website.locator('audio').evaluate(audio => audio.ended), { timeout: 30000 }).toBe(true);
      samples.push(await resources()); const stop = Date.now();
      await live.locator('#stop').click(); await expect(live.locator('#status')).toContainText('Stopped', { timeout: 120000 });
      samples.push(await resources()); await expect(live.locator('#errors')).toBeEmpty();
      const parakeet = (await live.locator('[data-display="transcript"] .display-content').textContent()).split('\n').filter(Boolean);
      const moonshine = (await live.locator('[data-display="medium"] .display-content').textContent()).split('\n').filter(Boolean);
      expect(parakeet.join(' ')).toMatch(/yellow lamps/i); expect(moonshine.join(' ')).toMatch(/Moonshine:.*yellow lamps/i);
      await expect(website.locator('textarea')).toHaveValue('prefix' + parakeet.join(''));
      expect(await live.evaluate(() => window.workers.every(w => w.released))).toBe(true);
      expect(await live.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(t => t.status === 'active').length)).toBe(0);
      const events = await live.evaluate(() => window.events);
      runs.push({ repeat, loadMs: loaded - start, stopDrainMs: Date.now() - stop, cpuSeconds: samples.at(-1).cpuSeconds - before.cpuSeconds,
        observedMaxRssKiB: Math.max(before.rssKiB, ...samples.map(s => s.rssKiB)), parakeet, moonshine, events });
      console.log(JSON.stringify({ ...runs.at(-1), events: events.length }));
    }
    expect(requests.every(req => new URL(req.url).hostname === '127.0.0.1' && req.method === 'GET' && !req.hasBody)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    const evidence = info.outputPath('optional-asr-native-evidence.json');
    await writeFile(evidence, JSON.stringify({ time: new Date().toISOString(), host, runs, requests, errors,
      method: 'Real native toolbar/tabCapture and production graph/Workers. Shared normalized capture feeds two independent ASRs. CPU sums CDP Chrome process CPU seconds including startup; sampled RSS sums Chrome processes (shared pages may be counted twice), not model-only peak. GPU memory not directly measured.' }, null, 2));
    await info.attach('native-concurrent-evidence', { path: evidence, contentType: 'application/json' });
    await context?.close(); await rm(profile, { recursive: true, force: true }); await new Promise(resolve => server.close(resolve));
  }
});
