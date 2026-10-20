import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { windowGraph, windowTranscript, closedWindows } from '../fixtures/windowed-translation.js';
import { TRANSLATE_GEMMA } from '../../web/translation-models.js';

test('real packaged TranslateGemma: baseline, bounded batches and revisable windows on the same transcript', async ({}, info) => {
  test.skip(!process.env.WINDOW_TRANSLATION_SMOKE, 'WINDOW_TRANSLATION_SMOKE=1: real WebGPU, 3.112 GB download, several GB RAM/GPU and 7 GB storage.');
  test.setTimeout(1800000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'window-translation-'));
  const evidence = { model: TRANSLATE_GEMMA, time: new Date().toISOString(), fixture: windowTranscript, cadenceMs: 150, runs: [], requests: [], errors: [] };
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    evidence.browser = context.browser().version();
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: path.resolve('dist/chrome-extension') });
    context.on('request', r => {
      const u = new URL(r.url()); evidence.requests.push({ url: `${u.protocol}//${u.host}${u.pathname}`, method: r.method(), hasBody: r.postData() !== null });
    });
    const editor = await context.newPage(); editor.on('pageerror', e => evidence.errors.push(e.message));
    await editor.goto(`chrome-extension://${id}/extension/graph-editor.html`);
    evidence.capabilities = await editor.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      return { adapter: !!a, gpu: a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null, isolated: crossOriginIsolated, userAgent: navigator.userAgent };
    });
    expect(evidence.capabilities.adapter, 'A missing GPU is a missing real-model check, not a passed experiment.').toBe(true);
    await editor.evaluate(async graph => { const { saveGraph } = await import('./graph.js'); saveGraph(localStorage, graph); }, windowGraph('revisable'));
    await editor.reload(); await editor.locator('#graph-save').click();
    const card = editor.locator('#graph-models .model-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.model-status')).toHaveText(/^(Ready.*|Error)$/, { timeout: 1200000 });
    evidence.preparation = { status: await card.locator('.model-status').textContent(), error: await card.locator('.model-error').textContent() };
    expect(evidence.preparation.status, evidence.preparation.error).toContain('Ready');
    await context.setOffline(true);
    for (const mode of ['baseline', 'window', 'revisable', 'revisable-preview']) {
      const page = await context.newPage(); page.on('pageerror', e => evidence.errors.push(e.message));
      await page.goto(`chrome-extension://${id}/extension/recorder.html`);
      const first = evidence.requests.length;
      const run = await page.evaluate(async ({ graph, texts, mode }) => {
        const { buildGraph } = await import('./graph-runtime.js');
        const started = performance.now(), now = () => performance.now() - started;
        const inferences = [], emissions = [], displayEvents = [], inputs = [], workers = [];
        const NativeWorker = Worker;
        const workerFactory = url => {
          const worker = new NativeWorker(url, { type: 'module' }), post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
          worker.postMessage = (data, ...rest) => { if (data.type === 'translate') inferences.push({ id: data.id, source: data.text, sentMs: now() }); post(data, ...rest); };
          worker.addEventListener('message', ({ data }) => { if (data.type === 'result' || data.type === 'error') {
            const request = inferences.find(r => r.id === data.id); if (request) Object.assign(request, { completedMs: now(), texts: data.texts, error: data.message });
          } });
          worker.terminate = () => { worker.released = true; terminate(); }; workers.push(worker); return worker;
        };
        let display;
        const built = buildGraph(graph, { translationWorkerFactory: workerFactory,
          onDisplay: (_, s) => { display = s; displayEvents.push({ ms: now(), ...s }); } });
        const scheduler = built.translations[0], emit = scheduler.emit.bind(scheduler);
        scheduler.emit = (job, text, error) => {
          if (!job.provisional || job.revision === scheduler.revision) emissions.push({ ms: now(), source: job.source, provisional: !!job.provisional, text, error });
          emit(job, text, error);
        };
        try {
          await built.pipeline.start(); await scheduler.ready;
          const readyMs = now();
          for (const text of texts) {
            inputs.push({ text, ms: now() }); built.pipeline.entries.get('input').context.emit('value', text);
            if (mode === 'revisable-preview' && !/[.!?]$/.test(text)) {
              // A deliberate pause experiment, separate from the equal-cadence
              // comparison: let a real open-window preview become visible.
              const deadline = performance.now() + 20000;
              const previous = emissions.length;
              while (!emissions.slice(previous).some(e => e.provisional) || !display?.preview) {
                if (performance.now() > deadline) throw Error('Real open-window preview did not arrive.');
                await new Promise(resolve => setTimeout(resolve, 25));
              }
            }
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          const stopMs = now(); await built.pipeline.stop();
          return { mode, readyMs, stopMs, totalMs: now(), inputs, inferences, emissions, displayEvents, display,
            errors: built.pipeline.errors.map(e => e.message), inferenceCount: inferences.length };
        } finally {
          await built.pipeline.dispose();
          if (workers.length !== 1 || !workers.every(w => w.released)) throw Error('Translator Worker ownership violation.');
        }
      }, { graph: (() => {
        const graph = windowGraph(mode === 'revisable-preview' ? 'revisable' : mode);
        if (mode === 'revisable-preview') graph.nodes.find(n => n.id === 'window').settings.maxWaitMs = 30000;
        return graph;
      })(), texts: windowTranscript, mode });
      evidence.runs.push(run);
      expect(run.errors).toEqual([]);
      const finals = run.emissions.filter(e => !e.provisional && e.source);
      expect(finals.map(e => e.source)).toEqual(mode === 'baseline' ? windowTranscript : closedWindows);
      expect(run.display.items.filter(Boolean)).toEqual(finals.map(e => e.text));
      expect(run.display.preview).toBe(''); expect(finals.every(e => e.text?.trim() && !e.error)).toBe(true);
      if (mode === 'revisable-preview') expect(run.displayEvents.some(e => e.preview)).toBe(true);
      for (let i = 1; i < run.displayEvents.length; i++) {
        const previous = run.displayEvents[i - 1].items;
        expect(run.displayEvents[i].items.slice(0, previous.length)).toEqual(previous);
      }
      expect(run.display.items.filter(Boolean).slice(mode === 'baseline' ? 2 : 1, mode === 'baseline' ? 4 : 3)[0])
        .toBe(run.display.items.filter(Boolean)[mode === 'baseline' ? 3 : 2]);
      expect(evidence.requests.slice(first).filter(r => !r.url.startsWith('chrome-extension:'))).toEqual([]);
      console.log(JSON.stringify({ mode, inferences: run.inferenceCount, totalMs: run.totalMs, display: run.display }));
      await page.close();
    }
    expect(evidence.errors).toEqual([]);
    expect(evidence.requests.every(r => r.method === 'GET' && !r.hasBody)).toBe(true);
    const batched = evidence.runs[1].display.items, revisable = evidence.runs[2].display.items;
    expect(revisable).toEqual(batched);
    expect(evidence.runs[3].display.items).toEqual(batched);
  } finally {
    const file = info.outputPath('window-translation-evidence.json'); await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
    await info.attach('window-translation-evidence', { path: file, contentType: 'application/json' });
    await context?.close(); await rm(temporary, { recursive: true, force: true });
  }
});
