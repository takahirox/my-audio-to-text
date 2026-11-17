import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { plamoSmokeSamples } from '../plamo-smoke-samples.js';
import { PLAMO_3_TRANSLATE_2B } from '../../web/plamo-policy.js';
import { servePlamoSmokeWeight } from '../plamo-smoke-fixture.js';

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
  const server = await servePlamoSmokeWeight(weight);
  const manifestPath = path.join(root, 'extension/plamo-assets.json'), files = JSON.parse(await readFile(manifestPath));
  files[0].sourceURL = server.url;
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
    const result = await page.evaluate(async samples => {
      const { graphNode, edge, GRAPH_VERSION } = await import('./graph.js'), { buildGraph } = await import('./graph-runtime.js');
      const { prepareGraphModelAssets } = await import('./graph-model-preparation.js');
      const graphFor = sample => {
        const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'input'),
          graphNode('Plamo3Translate2B', 'plamo'), graphNode('Display', 'out')],
          edges: [edge('input', 'value', 'plamo', 'text'), edge('plamo', 'text', 'out', 'input1')] };
        // The first two samples have genuinely unconnected language ports.
        for (const port of ['source', 'target']) if (sample[port] !== '') {
          const language = graphNode('Text', port); language.settings.value = sample[port];
          graph.nodes.push(language); graph.edges.push(edge(port, 'value', 'plamo', `${port}_lang`));
        }
        return graph;
      };
      const started = performance.now(); await prepareGraphModelAssets(graphFor(samples[0]));
      const preparedMs = performance.now() - started, runs = [], states = [];
      for (const sample of samples) {
        const outputs = [], graph = graphFor(sample);
        const built = buildGraph(graph, { onDisplay: (id, fragment) => { if (fragment.textContent) outputs.push(fragment.textContent); },
          onTranslationState: state => states.push(state) });
        try {
          const beforeLoad = performance.now();
          await built.pipeline.start(); await built.translations[0].ready;
          if (built.translations[0].error) throw Error(built.translations[0].error);
          const loadedMs = performance.now() - beforeLoad, before = performance.now();
          built.pipeline.entries.get('input').context.emit('value', sample.text);
          await built.pipeline.stop();
          runs.push({ ...sample, output: outputs.at(-1), loadedMs, inferenceMs: performance.now() - before });
        } finally { await built.pipeline.dispose(); }
        if (!built.translations[0].disposed) throw Error('PLaMo Worker was not released');
      }
      return { preparedMs, runs, states, disposed: true,
        capabilities: { userAgent: navigator.userAgent, isolated: crossOriginIsolated, secure: isSecureContext, jspi: !!WebAssembly.Suspending } };
    }, plamoSmokeSamples.map(({ expected, ...sample }) => sample));
    result.model = PLAMO_3_TRANSLATE_2B;
    result.browser = context.browser().version();
    console.log(JSON.stringify(result));
    await writeFile(info.outputPath('plamo-extension-evidence.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile('.cache/plamo-review/extension-evidence.json', JSON.stringify(result, null, 2) + '\n');
    for (const [index, sample] of plamoSmokeSamples.entries()) expect(result.runs[index].output).toMatch(sample.expected);
    expect(result.states.filter(state => /configuration:|unavailable:/i.test(state))).toEqual([]);
    expect(result.disposed).toBe(true); expect(errors).toEqual([]);
  } finally {
    await context?.close(); await server.close();
  }
});
