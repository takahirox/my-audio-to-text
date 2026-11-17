import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('real packaged PLaMo graph: CPU WASM, both directions, explicit auto target, Stop and release', async ({}, info) => {
  test.skip(process.env.PLAMO_EXTENSION_SMOKE !== '1', 'Opt-in real official 1.81 GB model on desktop Chromium.');
  test.setTimeout(900000);
  const weight = path.resolve('.cache/plamo-review/plamo-3-translate-2b-Q4_K_M.gguf');
  try { await stat(weight); } catch { execFileSync('python3', ['scripts/review-plamo-assets.py'], { stdio: 'inherit' }); }
  const root = path.resolve('.cache/plamo-review/real-extension');
  await mkdir(root, { recursive: true }); await cp('dist/chrome-extension', root, { recursive: true });
  // Static asset delivery only, never an inference server. Bytes retain the
  // production 1 MiB hashes and canonical immutable cache key. This isolates
  // extension/CSP/runtime testing from a second multi-GB WAN transfer.
  const server = createServer((request, response) => {
    if (request.url !== '/weights.gguf') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Length': '1807203040', 'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'application/octet-stream' });
    createReadStream(weight).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const manifestPath = path.join(root, 'extension/plamo-assets.json'), files = JSON.parse(await readFile(manifestPath));
  files[0].sourceURL = `http://127.0.0.1:${server.address().port}/weights.gguf`;
  await writeFile(manifestPath, JSON.stringify(files));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.resolve('.cache/plamo-review/extension-profile'), {
      channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/extension/model-cache.html`);
    const result = await page.evaluate(async () => {
      const { graphNode, edge } = await import('./graph.js'), { buildGraph } = await import('./graph-runtime.js');
      const { prepareGraphModelAssets } = await import('./graph-model-preparation.js');
      const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('Text', 'source'), graphNode('Text', 'target'),
        graphNode('Plamo3Translate2B', 'plamo'), graphNode('Display', 'out')], edges: [edge('input', 'value', 'plamo', 'text'),
        edge('source', 'value', 'plamo', 'source_lang'), edge('target', 'value', 'plamo', 'target_lang'), edge('plamo', 'text', 'out', 'input1')] };
      graph.nodes.find(node => node.id === 'source').settings.value = 'auto';
      graph.nodes.find(node => node.id === 'target').settings.value = 'en';
      const started = performance.now(); await prepareGraphModelAssets(graph); const preparedMs = performance.now() - started;
      const outputs = [], states = [];
      const built = buildGraph(graph, { onDisplay: (id, fragment) => { if (fragment.textContent) outputs.push(fragment.textContent); },
        onTranslationState: state => states.push(state) });
      await built.pipeline.start(); await built.translations[0].ready;
      if (built.translations[0].error) throw Error(built.translations[0].error);
      const loadedMs = performance.now() - started - preparedMs, runs = [];
      for (const sample of [
        { text: '会議は来週の月曜日に変更されました。', source: 'auto', target: 'en' },
        { text: 'The weather is nice today.', source: 'en', target: 'ja' },
        { text: 'Please open the project dashboard.', source: 'auto', target: 'ja' },
      ]) {
        const before = performance.now();
        built.pipeline.entries.get('source').context.emit('value', sample.source);
        built.pipeline.entries.get('target').context.emit('value', sample.target);
        built.pipeline.entries.get('input').context.emit('value', sample.text);
        await new Promise(resolve => setTimeout(resolve, 0)); await built.translations[0].working;
        runs.push({ ...sample, output: outputs.at(-1), inferenceMs: performance.now() - before });
      }
      await built.pipeline.stop(); await built.pipeline.dispose();
      return { preparedMs, loadedMs, runs, states, disposed: built.translations[0].disposed,
        capabilities: { userAgent: navigator.userAgent, isolated: crossOriginIsolated, jspi: !!WebAssembly.Suspending } };
    });
    console.log(JSON.stringify(result));
    await writeFile(info.outputPath('plamo-extension-evidence.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile('.cache/plamo-review/extension-evidence.json', JSON.stringify(result, null, 2) + '\n');
    expect(result.runs[0].output).toMatch(/meeting.*(?:next Monday|Monday next week)/i);
    expect(result.runs[1].output).toMatch(/今日.*(?:天気|晴)/);
    expect(result.runs[2].output).toMatch(/ダッシュボード|管理画面/);
    expect(result.states.filter(state => /configuration:|unavailable:/i.test(state))).toEqual([]);
    expect(result.disposed).toBe(true); expect(errors).toEqual([]);
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
