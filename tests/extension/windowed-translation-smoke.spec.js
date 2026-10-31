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
    for (const mode of ['baseline', 'window', 'revisable', 'direct-asr']) {
      const page = await context.newPage(); page.on('pageerror', e => evidence.errors.push(e.message));
      await page.goto(`chrome-extension://${id}/extension/recorder.html`);
      const first = evidence.requests.length;
      const run = await page.evaluate(async ({ graph, texts, mode }) => {
        const { buildGraph } = await import('./graph-runtime.js');
        const started = performance.now(), now = () => performance.now() - started;
        const inferences = [], emissions = [], displayEvents = [], inputs = [], workers = [], previews = [];
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
        // Only direct-ASR recognition/capture are controlled. TranslateGemma
        // uses the actual packaged Worker, runtime and checksum-verified weights.
        const built = buildGraph(graph, { translationWorkerFactory: workerFactory,
          tabId: 42, sourceFactory: () => ({ start() {}, stop() {} }),
          workerFactory: () => ({ postMessage(m) {
            if (m.type === 'load') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } }));
            if (m.type === 'vad-stop') queueMicrotask(() => this.onmessage?.({ data: { type: 'vad-stopped', session: m.session } }));
          }, terminate() {} }),
          onDisplay: (id, s) => { if (id === 'display') display = s.textContent; else previews.push(s.textContent); displayEvents.push({ id, ms: now(), text: s.textContent }); } });
        const scheduler = built.translations[0], emit = scheduler.emit.bind(scheduler);
        scheduler.emit = (job, text, error) => {
          if (!job.provisional || job.revision === scheduler.revision) emissions.push({ ms: now(), source: job.source, provisional: !!job.provisional, text, error });
          emit(job, text, error);
        };
        try {
          await built.pipeline.start(); await scheduler.ready;
          const readyMs = now();
          if (mode === 'direct-asr') {
            built.speechNodes.get('input').receiveEvent({ type: 'partial', text: 'Please' });
            const deadline = performance.now() + 30000;
            while (!previews.at(-1)) {
              if (performance.now() > deadline) throw Error('Real direct-ASR preview did not arrive.');
              await new Promise(r => setTimeout(r, 25));
            }
          }
          let finalId = 0;
          for (const text of texts) {
            inputs.push({ text, ms: now() });
            if (mode === 'direct-asr') built.speechNodes.get('input').receiveEvent({ type: 'final', text, id: finalId++ });
            else built.pipeline.entries.get('input').context.emit('value', text);
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          const stopMs = now(); await built.pipeline.stop();
          return { mode, readyMs, stopMs, totalMs: now(), inputs, inferences, emissions, displayEvents, display, preview: previews.at(-1) ?? '',
            errors: built.pipeline.errors.map(e => e.message), inferenceCount: inferences.length };
        } finally {
          await built.pipeline.dispose();
          if (workers.length !== 1 || !workers.every(w => w.released)) throw Error('Translator Worker ownership violation.');
        }
      }, { graph: (() => {
        const graph = windowGraph(mode === 'direct-asr' ? 'revisable' : mode);
        // Keep the real-model comparison on fixed length/Stop boundaries;
        // deadline behavior is covered by controlled and browser checks.
        if (mode !== 'baseline') graph.nodes.find(n => n.id === 'window-wait').settings.value = 30;
        if (mode === 'direct-asr') {
          graph.nodes = graph.nodes.filter(n => !['window', 'window-chars', 'window-wait'].includes(n.id));
          Object.assign(graph.nodes.find(n => n.id === 'input'), { type: 'SpeechToTextReazonSpeech', settings: {} });
          graph.nodes.push({ id: 'audio', type: 'ChromeTabAudio', settings: {}, position: { x: 0, y: 0 } });
          graph.edges = graph.edges.filter(e => e.to[0] !== 'window');
          for (const e of graph.edges) if (e.from[0] === 'window') e.from = ['input', e.from[1] === 'text' ? 'final' : 'provisional'];
          graph.edges.push({ from: ['audio', 'audio'], to: ['input', 'audio'] }, { from: ['input', 'provisional'], to: ['translator', 'provisional'] });
        }
        return graph;
      })(), texts: mode === 'direct-asr' ? ['Please wait.', 'Please wait.'] : windowTranscript, mode });
      evidence.runs.push(run);
      expect(run.errors).toEqual([]);
      const finals = run.emissions.filter(e => !e.provisional && e.source);
      expect(finals.map(e => e.source)).toEqual(mode === 'direct-asr' ? ['Please wait.', 'Please wait.'] : mode === 'baseline' ? windowTranscript : closedWindows);
      const accepted = run.emissions.filter(e => !e.provisional && !e.error && typeof e.text === 'string');
      expect(run.display).toBe(accepted.map(e => e.text).join('\n'));
      expect(run.preview).toBe(''); expect(finals.every(e => e.text?.trim() && !e.error)).toBe(true);
      if (['direct-asr', 'baseline'].includes(mode)) {
        const repeatedIndex = mode === 'direct-asr' ? 0 : 2;
        expect(finals[repeatedIndex].text).toBe(finals[repeatedIndex + 1].text);
      }
      expect(evidence.requests.slice(first).filter(r => !r.url.startsWith('chrome-extension:'))).toEqual([]);
      console.log(JSON.stringify({ mode, inferences: run.inferenceCount, totalMs: run.totalMs, display: run.display }));
      await page.close();
    }
    expect(evidence.errors).toEqual([]);
    expect(evidence.requests.every(r => r.method === 'GET' && !r.hasBody)).toBe(true);
    const batched = evidence.runs[1].display, revisable = evidence.runs[2].display;
    expect(revisable).toEqual(batched);
  } finally {
    const file = info.outputPath('window-translation-evidence.json'); await writeFile(file, JSON.stringify(evidence, null, 2) + '\n');
    await info.attach('window-translation-evidence', { path: file, contentType: 'application/json' });
    await context?.close(); await rm(temporary, { recursive: true, force: true });
  }
});
