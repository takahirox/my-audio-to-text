import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Source-only MV3 fixture package. No full-distribution build or real inference
// claim: the actual node/runtime/editor/storage run with a controlled Worker.
test('MV3 imports and reloads Hold feedback; real Worker replies serialize A/B/C, Stop, failure and Cancel/restart', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'hold-feedback-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !source.includes('/vendor') && !source.includes('/tts-assets') });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    await writeFile(path.join(root, 'web/meeting-summary-worker.js'), `
      const queue = []; let count = 0;
      self.onmessage = ({ data }) => {
        if (data.type === 'load') postMessage({ type: 'ready', id: data.id });
        if (data.type === 'summarize') queue.push(data);
        if (data.type === 'complete') {
          const job = queue.shift();
          if (job.text.includes('FAIL')) postMessage({ type: 'error', id: job.id, message: 'Controlled inference failure' });
          else postMessage({ type: 'result', id: job.id, summary: ++count === 1 ? 'S1' : 'same' });
        }
      };
    `);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    context.setDefaultTimeout(5000);
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    const base = `chrome-extension://${id}/extension/`;
    const editor = await context.newPage(); await editor.goto(base + 'graph-editor.html');
    const graph = JSON.parse(await readFile('docs/examples/incremental-meeting-summary.json', 'utf8'));
    // Exercise the production JSON Import UI; Save model preparation is covered
    // separately. Persist via the normal saveGraph function without downloads.
    await editor.locator('.graph-actions > summary').click();
    await editor.locator('input[type=file]').setInputFiles({ name: 'feedback.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await expect(editor.getByRole('button', { name: 'previous output value', exact: true })).toBeVisible();
    await editor.evaluate(async graph => (await import('./graph.js')).saveGraph(localStorage, graph), graph);
    await editor.reload(); await expect(editor.locator('#graph-errors')).toBeEmpty();
    expect(await editor.evaluate(async () => (await import('./graph.js')).readGraph(localStorage))).toEqual(graph);
    // An ordinary emitting self-cycle is disabled interactively without
    // invalidating the stored graph.
    await editor.getByRole('button', { name: 'Select connection window.text to format.input2', exact: true }).press('Enter');
    await editor.getByRole('button', { name: 'Disconnect window.text to format.input2', exact: true }).click();
    await editor.getByRole('button', { name: 'format output text', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'format input input2', exact: true })).toBeDisabled();
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await editor.reload(); await expect(editor.locator('#graph-errors')).toBeEmpty();
    const page = await context.newPage(); await page.goto(base + 'recorder.html');
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.evaluate(async graph => {
      const { buildGraph } = await import('./graph-runtime.js');
      window.sent = []; window.displayed = []; window.workerErrors = []; window.violations = [];
      addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
      window.fresh = async () => {
        window.workers = [];
        const built = buildGraph(graph, { meetingSummaryWorkerFactory: url => {
          const worker = new Worker(url, { type: 'module' });
          const post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
          worker.postMessage = data => { if (data.type === 'summarize') sent.push(data.text); post(data); };
          worker.terminate = () => { worker.released = true; terminate(); };
          worker.onerror = error => workerErrors.push(error.message);
          workers.push(worker); return worker;
        }, onDisplay: (_, dom) => displayed.push(dom.textContent), onError: e => workerErrors.push(e.message) });
        window.pipeline = built.pipeline; await pipeline.start();
        // Raise the window threshold first so each short test window is flushed
        // explicitly by the real TextWindow (not by a source-specific port).
        await pipeline.entries.get('window').queue;
      };
      window.send = async text => {
        pipeline.entries.get('input').context.emit('value', text);
        await pipeline.entries.get('window').queue;
        pipeline.entries.get('window').node.flush();
      };
      window.complete = () => workers[0].postMessage({ type: 'complete' });
      await fresh();
      // Flush the demonstration startup window as A.
      pipeline.entries.get('window').node.flush();
    }, graph);
    const initial = graph.nodes.find(n => n.id === 'input').settings.value;
    await expect.poll(() => page.evaluate(() => sent.length)).toBe(1);
    await page.evaluate(async () => { await send('B'); await send('C'); });
    expect(await page.evaluate(() => sent)).toEqual([`Previous summary:\n\n\nNew transcript:\n${initial}`]);
    await page.evaluate(() => complete()); await expect.poll(() => page.evaluate(() => sent.length)).toBe(2);
    expect(await page.evaluate(() => sent[1])).toBe('Previous summary:\nS1\n\nNew transcript:\nB');
    await page.evaluate(() => complete()); await expect.poll(() => page.evaluate(() => sent.length)).toBe(3);
    expect(await page.evaluate(() => sent[2])).toBe('Previous summary:\nsame\n\nNew transcript:\nC');
    await page.evaluate(() => { window.stopping = pipeline.stop(); });
    await page.evaluate(() => complete()); await page.evaluate(() => stopping);
    expect(await page.evaluate(() => displayed.filter(Boolean))).toEqual(['S1', 'same', 'same']);
    expect(await page.evaluate(() => workers.every(w => w.released))).toBe(true);
    await page.evaluate(async () => { await pipeline.dispose(); await fresh(); pipeline.entries.get('window').node.flush(); });
    await expect.poll(() => page.evaluate(() => sent.length)).toBe(4);
    expect(await page.evaluate(() => sent[3])).toBe(`Previous summary:\n\n\nNew transcript:\n${initial}`);
    await page.evaluate(async () => { await send('queued'); await pipeline.cancel(); });
    expect(await page.evaluate(() => workers.every(w => w.released))).toBe(true);
    expect(await page.evaluate(() => sent.length)).toBe(4);
    await page.evaluate(async () => { await fresh(); await send('FAIL'); });
    // The startup demo text and FAIL share a window because no timer fired.
    await expect.poll(() => page.evaluate(() => sent.length)).toBe(5);
    await page.evaluate(() => complete());
    await expect.poll(() => page.evaluate(() => pipeline.entries.get('format').failed)).toBe(true);
    expect(await page.evaluate(() => workerErrors.join(' '))).toContain('Controlled inference failure');
    await page.evaluate(() => pipeline.cancel());
    expect(await page.evaluate(() => violations)).toEqual([]); expect(errors).toEqual([]);
    await editor.reload(); expect(await editor.evaluate(async () => (await import('./graph.js')).readGraph(localStorage))).toEqual(graph);
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});
