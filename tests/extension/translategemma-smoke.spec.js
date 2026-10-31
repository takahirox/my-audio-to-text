import { addDOMFormatters } from '../fixtures/dom-graph.js';
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ordinaryEnglishFixtures } from '../fixtures/translation-en-ja.js';
import { TRANSLATE_GEMMA } from '../../web/translation-models.js';
import { translationContextFixtures } from '../fixtures/translation-context.js';

const fixtures = [...ordinaryEnglishFixtures,
  { text: 'Could you repeat the last point more slowly?', meanings: [/最後|直前/, /もう一度|繰り返/, /ゆっくり/] },
  { text: 'Please do not send the report until Friday.', meanings: [/報告書|レポート/, /金曜/, /送/, /ない|な|ず|控/] },
];

test('real pinned TranslateGemma in packaged MV3: Save preparation, semantic en→ja, source retention, drain, offline fresh Workers and ja→en', async ({}, info) => {
  test.skip(!process.env.TRANSLATEGEMMA_SMOKE, 'Opt in with TRANSLATEGEMMA_SMOKE=1; downloads 3.112 GB and requires several GB RAM/GPU memory.');
  test.setTimeout(1800000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'mv3-gemma-'));
  const profile = path.join(temporary, 'profile'), requests = [], errors = [], runs = [];
  const files = JSON.parse(await readFile('extension/translategemma-assets.json', 'utf8'));
  let context, server, capabilities, cacheState, browser, reuseRequests, publicAccess;
  const mirror = process.env.TRANSLATEGEMMA_ASSET_DIR && path.resolve(process.env.TRANSLATEGEMMA_ASSET_DIR);
  try {
    let root = path.resolve('dist/chrome-extension');
    if (mirror) {
      // Real pinned bytes and unchanged integrity manifest. Change only transport
      // URLs for repeatable local validation; no Worker/runtime/inference mocks.
      const allowed = new Map(files.map(f => [`/${f.path}`, path.join(mirror, f.path)]));
      server = createServer((req, res) => {
        const file = allowed.get(req.url);
        if (!file) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
        createReadStream(file).pipe(res);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      root = path.join(temporary, 'extension'); await cp(path.resolve('dist/chrome-extension'), root, { recursive: true });
      await writeFile(path.join(root, 'extension/translategemma-assets.json'), JSON.stringify(files.map(f => ({ ...f, sourceURL: `http://127.0.0.1:${server.address().port}/${f.path}` }))));
    }
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: !process.env.EXTENSION_HEADED,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    browser = context.browser().version();
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    context.on('request', r => {
      const url = new URL(r.url());
      requests.push({ url: `${url.protocol}//${url.host}${url.pathname}`, method: r.method(), hasBody: r.postData() !== null,
        textInURL: [...fixtures, ...Object.values(translationContextFixtures).flat()].some(f => decodeURIComponent(r.url()).includes(f.text)
          || (f.context && decodeURIComponent(r.url()).includes(f.context))) });
    });
    await context.addInitScript(`window.addDOMFormatters = ${addDOMFormatters.toString()};`);
    const editor = await context.newPage(); editor.on('pageerror', e => errors.push(e.message));
    await editor.goto(`chrome-extension://${id}/extension/graph-editor.html`);
    capabilities = await editor.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      return { browser: navigator.userAgent, isolated: crossOriginIsolated, gpu: !!navigator.gpu, adapter: !!adapter,
        gpuInfo: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture } : null,
        limits: adapter ? { maxBufferSize: adapter.limits.maxBufferSize, maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } : null };
    });
    expect(capabilities.adapter, 'Requires a usable hardware WebGPU adapter; this is not an inference success if unavailable.').toBe(true);
    // Public CORS/COEP remains checked when the large files use a local mirror.
    publicAccess = await editor.evaluate(async model => {
      const url = `https://huggingface.co/${model.id}/resolve/${model.revision}/config.json`;
      const response = await fetch(url, { credentials: 'omit' });
      return { status: response.status, architecture: (await response.json()).architectures[0] };
    }, TRANSLATE_GEMMA);
    expect(publicAccess).toEqual({ status: 200, architecture: 'Gemma3ForCausalLM' });
    await editor.evaluate(async initial => {
      const { graphNode, edge, saveGraph } = await import('./graph.js');
      const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('TranslateGemmaEnJa', 'gemma'),
        graphNode('TextFormatter', 'format'), graphNode('LiveTextDisplay', 'paired'), graphNode('LiveTextDisplay', 'plain'),
        graphNode('TranslateGemmaJaEn', 'parked'), graphNode('Text', 'independent'), graphNode('LiveTextDisplay', 'other')], edges: [
        edge('input', 'value', 'gemma', 'text'), edge('gemma', 'source', 'format', 'input1'), edge('gemma', 'text', 'format', 'input2'), edge('gemma', 'error', 'format', 'input3'),
        edge('format', 'text', 'paired', 'content'), edge('gemma', 'text', 'plain', 'content'), edge('independent', 'value', 'other', 'content'),
      ] };
      graph.nodes[0].settings.value = initial; graph.nodes[2].settings.template = '{1}\n{2}{3}';
      graph.nodes[6].settings.value = 'Independent branch'; saveGraph(localStorage, window.addDOMFormatters(graph));
    }, fixtures[0].text);
    await editor.reload();
    const beforeSave = requests.length;
    await editor.locator('#graph-save').click();
    const card = editor.locator('#graph-models .model-card'); await expect(card).toHaveCount(1);
    await expect(card.locator('.model-status')).toHaveText(/^(Ready.*|Error)$/, { timeout: 1200000 });
    cacheState = { status: await card.locator('.model-status').textContent(), error: await card.locator('.model-error').textContent() };
    expect(cacheState.status, cacheState.error).toContain('Ready');
    const sources = new Set(files.map(f => mirror ? `http://127.0.0.1:${server.address().port}/${f.path}`
      : `https://huggingface.co/${TRANSLATE_GEMMA.id}/resolve/${TRANSLATE_GEMMA.revision}/${f.path}`));
    const downloaded = requests.slice(beforeSave).filter(r => sources.has(r.url));
    expect(downloaded).toHaveLength(files.length);
    const beforeReuse = requests.length;
    await editor.locator('#graph-save').click(); await expect(card.locator('.model-status')).toContainText('Ready', { timeout: 120000 });
    reuseRequests = requests.slice(beforeReuse).filter(r => !r.url.startsWith('chrome-extension:'));
    expect(reuseRequests).toEqual([]);
    for (const [direction, offline] of [['en-ja', false], ['en-ja', true], ['ja-en', true]]) {
      await context.setOffline(offline);
      // A new page and actual graph own a fresh Worker for every run. Cache API
      // entries survive; no hot model or earlier output can satisfy this run.
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`chrome-extension://${id}/extension/recorder.html`);
      const first = requests.length;
      const texts = direction === 'en-ja' ? fixtures.map(f => f.text) : ['会議は金曜日の午前十時に始まります。'];
      const probes = translationContextFixtures[direction];
      const targets = [...texts, ...probes.flatMap(f => [f.text, f.text, f.text])];
      const contexts = [...texts.map(() => ''), ...probes.flatMap(f => ['', f.context, ''])];
      const run = await page.evaluate(async ({ direction, targets, contexts }) => {
        const { readGraph, graphNode, edge } = await import('./graph.js'); const { buildGraph } = await import('./graph-runtime.js');
        const graph = readGraph(localStorage); graph.nodes.find(n => n.id === 'gemma').type = direction === 'en-ja' ? 'TranslateGemmaEnJa' : 'TranslateGemmaJaEn';
        graph.nodes.find(n => n.id === 'input').settings.value = targets[0];
        graph.nodes.push(graphNode('Text', 'context'));
        graph.edges.push(edge('context', 'value', 'gemma', 'context'));
        const displays = {}, states = [], started = performance.now();
        const NativeWorker = Worker, workers = [];
        globalThis.Worker = class extends NativeWorker {
          constructor(...args) { super(...args); workers.push(this); }
          terminate() { this.released = true; super.terminate(); }
        };
        const built = buildGraph(window.addDOMFormatters(graph), { onDisplay: (id, state) => { displays[id] = state.textContent; }, onTranslationState: state => states.push(state) });
        const translated = [], node = built.pipeline.entries.get('gemma').node, start = node.start.bind(node);
        node.start = context => start({ ...context, emitOutputs(values) {
          if (typeof values.text === 'string') translated.push(values.text);
          context.emitOutputs(values);
        } });
        try {
          await built.pipeline.start();
          // First input comes from the production Text Node. Further controlled
          // fixtures traverse that source's real TEXT routes and scheduler FIFO.
          for (let i = 1; i < targets.length; i++) {
            built.pipeline.entries.get('context').context.emit('value', contexts[i]);
            built.pipeline.entries.get('input').context.emit('value', targets[i]);
          }
          await built.pipeline.stop();
          return { direction, displays, translated, states, ms: performance.now() - started, errors: built.pipeline.errors.map(e => e.message) };
        } finally { await built.pipeline.dispose(); if (workers.length !== 1 || !workers.every(w => w.released)) throw Error('Owned Worker was not released or parked Node executed'); }
      }, { direction, targets, contexts });
      run.contextComparisons = probes.map((f, i) => ({ text: f.text, context: f.context,
        official: run.translated[texts.length + i * 3], contextual: run.translated[texts.length + i * 3 + 1], reset: run.translated[texts.length + i * 3 + 2] }));
      run.offline = offline; runs.push(run); console.log(JSON.stringify(run));
      expect(run.errors).toEqual([]); expect(run.states).toContain('Local TranslateGemma 4B ready');
      expect(run.displays.other).toBe('Independent branch');
      expect(run.translated).toHaveLength(targets.length);
      expect(run.displays.plain).toBe(run.translated.join('\n'));
      expect(run.displays.paired).toBe(targets.map((text, i) => `${text}\n${run.translated[i]}`).join('\n'));
      for (let i = 0; i < texts.length; i++) {
        const output = run.translated[i];
        expect(output.trim()).not.toBe(texts[i]);
        for (const meaning of direction === 'en-ja' ? fixtures[i].meanings : [/meeting/i, /Friday/i, /10|ten/i, /start|begin/i]) expect(output, `Meaning of ${texts[i]}: ${meaning}`).toMatch(meaning);
      }
      for (const [i, probe] of probes.entries()) {
        const comparison = run.contextComparisons[i];
        expect(comparison.reset).toBe(comparison.official);
        for (const meaning of probe.meanings) expect(comparison.contextual).toMatch(meaning);
        expect(comparison.contextual).not.toMatch(probe.forbidden);
        expect(comparison.contextual).not.toMatch(/```|"(?:context|text)"\s*:|^(?:translation|context|翻訳|訳文)\s*[:：]/i);
      }
      expect(requests.slice(first).filter(r => !r.url.startsWith('chrome-extension:'))).toEqual([]);
      await page.close();
    }
    expect(errors).toEqual([]);
    expect(requests.every(r => r.method === 'GET' && !r.hasBody)).toBe(true);
    for (const r of requests) {
      const url = new URL(r.url);
      expect(url.protocol === 'chrome-extension:' || url.hostname === '127.0.0.1' || url.hostname === 'huggingface.co' || url.hostname.endsWith('.hf.co')).toBe(true);
      if (url.protocol !== 'chrome-extension:') expect(/\.(?:m?js|wasm)(?:$|\?)/.test(url.pathname)).toBe(false);
      expect(r.textInURL).toBe(false);
    }
  } finally {
    const evidence = { model: TRANSLATE_GEMMA, time: new Date().toISOString(), browser, capabilities, transport: mirror ? 'reviewed real bytes via loopback mirror; packaged manifest sourceURL only changed' : 'pinned public URLs', publicAccess, cacheState, reuseRequests, runs, errors, requests };
    const file = info.outputPath('translategemma-evidence.json'); await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
    await info.attach('translategemma-evidence', { path: file, contentType: 'application/json' });
    await context?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
  }
});
