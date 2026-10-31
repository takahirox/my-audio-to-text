import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

function pcm16(wav) {
  let pcm;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (id === 'fmt ') expect([wav.readUInt16LE(offset + 8), wav.readUInt16LE(offset + 10), wav.readUInt32LE(offset + 12), wav.readUInt16LE(offset + 22)]).toEqual([1, 1, 16000, 16]);
    if (id === 'data') pcm = Array.from({ length: size / 2 }, (_, i) => wav.readInt16LE(offset + 8 + i * 2) / 32768);
    offset += 8 + size + size % 2;
  }
  return pcm;
}
for (const [key, type, module, className, partials] of [
  ['parakeet-v3', 'SpeechToTextParakeetV3', 'parakeet-v3-node', 'SpeechToTextParakeetV3Node', false],
  ['moonshine-medium-en', 'SpeechToTextMoonshineMediumEn', 'moonshine-medium-node', 'SpeechToTextMoonshineMediumEnNode', true],
]) test(`real packaged ${key}: local finals, Stop, Cancel and repeat`, async ({}, info) => {
  test.skip(!process.env.OPTIONAL_ASR_SMOKE, 'Opt in: prepare optional ASR validation weights, build, then npm run test:optional-asr-real.');
  test.setTimeout(600000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'optional-asr-'));
  const files = new Map(), requests = [], errors = [], runs = [];
  const spec = JSON.parse(await readFile(`extension/${key}-assets.json`, 'utf8'));
  for (const file of spec.files) files.set('/' + file.path, path.resolve(`.cache/new-asr/${key}/${file.path}`));
  const server = createServer((req, res) => {
    const file = files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context, host;
  try {
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const id = (await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: path.resolve('dist/chrome-extension') })).id;
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') console.log(key, msg.text().slice(0, 1000)); });
    await page.goto(`chrome-extension://${id}/extension/recorder.html`);
    host = await page.evaluate(async () => ({ browser: navigator.userAgent, isolated: crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency,
      gpu: (await navigator.gpu?.requestAdapter())?.info?.description }));
    // Production cache machinery verifies the exact pinned bytes served by a
    // local test mirror. No runtime/model/manifest in the package is replaced.
    await page.evaluate(async ({ spec, port }) => {
      const { defineAssetSet, ModelAssetCache } = await import('./model-asset-cache.js');
      const manifest = defineAssetSet({ ...spec, files: spec.files.map(file => ({ ...file, sourceURL: `http://127.0.0.1:${port}/${file.path}` })) });
      const view = await new ModelAssetCache(manifest).prepare();
      if (view.state !== 'Ready') throw Error(JSON.stringify(view));
    }, { spec, port: server.address().port });
    context.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
    await context.route(/^https?:/, route => route.abort());
    await page.evaluate(async ({ type, module, className }) => {
      const { graphNode, edge, assertGraph } = await import('./graph.js');
      const { TabSession } = await import('./session.js');
      const Node = (await import(`../web/${module}.js`))[className];
      const receive = Node.prototype.receiveEvent;
      Node.prototype.receiveEvent = function(event) {
        window.events.push({ ...event, ms: performance.now(), fed: window.fed || 0 });
        return receive.call(this, event);
      };
      const NativeWorker = window.Worker; window.workers = [];
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); window.workers.push(this); }
        terminate() { this.released = true; super.terminate(); }
      };
      const graph = assertGraph({ version: 15, nodes: [graphNode('ChromeTabAudio', 'audio'), graphNode(type, 'speech'), graphNode('TextAccumulator','acc'), graphNode('TextToDOM','dom'), graphNode('LiveTextDisplay', 'out'), ...(type.includes('Moonshine') ? [graphNode('TextToDOM', 'preview'), graphNode('DOMCombiner', 'combined')] : [])],
        edges: [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'final', 'acc', 'append'),edge('acc','text','dom','text'),...(type.includes('Moonshine') ? [edge('speech', 'provisional', 'preview', 'text'), edge('dom', 'dom', 'combined', 'first'), edge('preview', 'dom', 'combined', 'second'), edge('combined', 'dom', 'out', 'dom')] : [edge('dom', 'dom', 'out', 'dom')])] });
      window.session = new TabSession(view => { window.view = view; }, { graph,
        sourceFactory: (tabId, onAudio) => ({ start() { window.feed = onAudio; }, stop() {} }) });
      window.events = [];
    }, { type, module, className });
    const fixtureSpec = JSON.parse(await readFile('scripts/zipformer-assets.json', 'utf8'));
    for (const fixture of ['0.wav', '1.wav', '0.wav']) {
      const wav = await readFile(`.cache/zipformer-en/test_wavs/${fixture}`);
      expect(createHash('sha256').update(wav).digest('hex')).toBe(fixtureSpec.files.find(f => f.path === `test_wavs/${fixture}`).sha256);
      const pcm = pcm16(wav);
      const loadMs = await page.evaluate(async () => { window.events = []; window.fed = 0; const at = performance.now(); await window.session.start(42); if (window.view.state !== 'running') throw Error(JSON.stringify(window.view)); return performance.now() - at; });
      const feedAt = await page.evaluate(() => performance.now());
      await page.evaluate(async ({ pcm, paced }) => {
        for (let offset = 0; offset < pcm.length; offset += 1600) {
          const end = Math.min(pcm.length, offset + 1600); window.feed(Float32Array.from(pcm.slice(offset, end))); window.fed = end;
          await new Promise(resolve => setTimeout(resolve, paced ? 100 : 10));
        }
      }, { pcm, paced: partials });
      const stopAt = await page.evaluate(() => performance.now());
      await page.evaluate(async () => { await window.session.stop(); if (window.view.error) throw Error(window.view.error); });
      const result = await page.evaluate(() => ({ events: window.events, displays: Object.fromEntries(Object.entries(window.view.displays).map(([id,dom])=>[id,dom.textContent])), workersReleased: window.workers.every(w => w.released), end: performance.now() }));
      const finals = result.events.filter(e => e.type === 'final');
      runs.push({ fixture, loadMs, feedAt, stopAt, ...result });
      console.log(key, fixture, JSON.stringify({ loadMs, finals, partials: result.events.filter(e => e.type === 'partial').length, drainMs: result.end - stopAt }));
      expect(finals.length).toBeGreaterThan(0);
      expect(finals.map(e => e.text).join(' ')).toMatch(fixture === '0.wav' ? /yellow lamps.*light.*quarter/i : /direct consequence.*lovely child.*heaven/i);
      expect(new Set(finals.map(e => e.id)).size).toBe(finals.length);
      expect(result.displays.out).toBe(finals.map(e => e.text).join('\n'));
      expect(result.workersReleased).toBe(true);
      if (partials) {
        const firstFinal = result.events.findIndex(e => e.type === 'final');
        const interim = result.events.slice(0, firstFinal).filter(e => e.type === 'partial' && e.text);
        expect(new Set(interim.map(e => e.text)).size).toBeGreaterThan(1);
        expect(interim[0].fed).toBeLessThan(pcm.length);
      } else expect(result.events.some(e => e.type === 'partial')).toBe(false);
    }
    await page.evaluate(async () => { await window.session.start(42); window.feed(new Float32Array(16000)); window.session.cancel(); });
    const canceled = await page.evaluate(() => ({ events: window.events.length, released: window.workers.every(w => w.released) }));
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.events.length)).toBe(canceled.events);
    expect(canceled.released).toBe(true);
    expect(requests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    const evidence = info.outputPath(`${key}-evidence.json`);
    await writeFile(evidence, JSON.stringify({ time: new Date().toISOString(), host, spec: { ...spec, files: spec.files.map(({ sha256Chunks, ...file }) => file) }, inference: 'Production packaged MV3 TabSession/graph/Node/Worker/backend. Pinned English PCM replaces capture hardware. No production runtime replacements.', runs, requests, errors }, null, 2));
    await info.attach('real-model-evidence', { path: evidence, contentType: 'application/json' });
    await context?.close(); await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
  }
});
