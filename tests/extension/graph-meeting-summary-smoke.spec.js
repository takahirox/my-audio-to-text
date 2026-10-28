import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MEETING_SUMMARY_TYPES, meetingSummaryModel } from '../../web/meeting-summary-models.js';
import { meetingBatches, meetingGraph, meetingFactChecks } from '../fixtures/meeting-summary.js';

// No inference/model/runtime mocks. Only a controllable committed TEXT producer.
// Loopback serves exact pinned bytes to Save; Start and inference are offline.
for (const type of MEETING_SUMMARY_TYPES) test(`${type}: real offline MV3 incremental Japanese notes, Stop and Cancel`, async ({}, info) => {
  test.skip(!process.env.MEETING_SUMMARY_SMOKE, 'Run review-meeting-summary-assets.py, prepare runtimes and build first.');
  test.setTimeout(900000);
  const spec = meetingSummaryModel(type), temporary = await mkdtemp(path.join(os.tmpdir(), 'meeting-summary-'));
  const root = path.join(temporary, 'extension'), requests = [], downloads = [], consoleErrors = [], runs = [], observations = [];
  let context, page, editor, server;
  const sourceSHA256 = {};
  try {
    await cp(path.resolve('dist/chrome-extension'), root, { recursive: true });
    for (const name of ['web/meeting-summary-worker.js', 'web/meeting-summary-policy.js', 'web/meeting-summary-node.js']) {
      const bytes = await readFile(path.join(root, name));
      expect(bytes.equals(await readFile(name)), `Rebuild changed source: ${name}`).toBe(true);
      sourceSHA256[name] = createHash('sha256').update(bytes).digest('hex');
    }
    const manifestPath = path.join(root, 'extension', spec.key + '-assets.json');
    const files = JSON.parse(await readFile(manifestPath, 'utf8'));
    server = createServer((request, response) => {
      const name = decodeURIComponent(request.url.slice(1));
      const file = files.find(f => f.path === name);
      if (!file) { response.writeHead(404); response.end(); return; }
      downloads.push(name);
      response.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Length': file.bytes });
      createReadStream(path.resolve('.cache/meeting-summary', spec.revision, name)).pipe(response);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    for (const file of files) file.sourceURL = `http://127.0.0.1:${server.address().port}/${file.path}`;
    await writeFile(manifestPath, JSON.stringify(files));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: process.env.MEETING_SUMMARY_CHANNEL || 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    context.setDefaultTimeout(30000);
    const cdp = await context.browser().newBrowserCDPSession();
    const id = (await cdp.send('Extensions.loadUnpacked', { path: root })).id;
    const base = `chrome-extension://${id}/extension/`;
    const gpu = await cdp.send('SystemInfo.getInfo');
    async function observe(stage) {
      const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
      const processes = processInfo.map(process => {
        let rssKiB;
        try { rssKiB = Number(execFileSync('/bin/ps', ['-o', 'rss=', '-p', String(process.id)], { encoding: 'utf8' }).trim()); } catch { /* process may have exited */ }
        return { ...process, rssKiB };
      });
      observations.push({ stage, processes, time: Date.now() });
    }
    context.on('request', request => { if (request.url().startsWith('http')) requests.push(request.url()); });
    await context.addInitScript(() => {
      window.summaryEvidence = []; window.summaryWorkers = []; window.cspViolations = [];
      addEventListener('securitypolicyviolation', e => window.cspViolations.push({ directive: e.violatedDirective, uri: e.blockedURI }));
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args); window.summaryWorkers.push(this);
          this.addEventListener('message', ({ data }) => {
            window.summaryEvidence.push({ at: performance.now(), ...data });
            if (window.cancelSummaryOnToken && data.type === 'progress' && data.stage === 'first-token') {
              window.cancelSummaryOnToken = false;
              window.summaryCancelToken = data;
              document.querySelector('#cancel-session').click();
            }
          });
        }
        terminate() { this.released = true; super.terminate(); }
      };
    });
    editor = await context.newPage(); await editor.goto(base + 'graph-editor.html');
    await editor.evaluate(async graph => { const { saveGraph } = await import('./graph.js'); saveGraph(localStorage, graph); }, meetingGraph(type));
    await editor.reload();
    // Both options are production palette entries and remain after a reload.
    await editor.locator('#graph-palette-toggle').click();
    await editor.getByLabel('Node category', { exact: true }).selectOption({ label: 'Processors' });
    for (const option of MEETING_SUMMARY_TYPES) await expect(editor.locator(`#graph-node-type option[value="${option}"]`)).toHaveCount(1);
    await editor.keyboard.press('Escape');
    const card = editor.locator('#graph-models .model-card').filter({ hasText: spec.label });
    await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
    await expect(card).toHaveAttribute('data-state', 'Ready', { timeout: 180000 });
    console.log(`${type}: Save verified ${files.reduce((n,f) => n+f.bytes,0)} model bytes`);
    const count = downloads.length;
    await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled(); await expect(card).toHaveAttribute('data-state', 'Ready', { timeout: 60000 });
    expect(downloads.length).toBe(count);
    await editor.reload();
    expect(await editor.evaluate(async () => (await import('./graph.js')).readGraph(localStorage))).toEqual(meetingGraph(type));
    page = await context.newPage(); page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(base + 'recorder.html');
    await page.evaluate(async () => {
      const { TextNode } = await import('../web/text-constant-node.js'), start = TextNode.prototype.start;
      TextNode.prototype.start = function(context) { window.emitCommittedText = text => context.emit('value', text); return start.call(this, context); };
    });
    const host = await page.evaluate(() => ({ browser: navigator.userAgent, isolated: crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency }));
    await context.setOffline(true); requests.length = 0;
    const notes = page.locator('[data-display="notes"] .display-content');
    const started = Date.now(); await page.locator('#start').click();
    await expect(page.locator('#status')).toHaveText('Processing active', { timeout: 180000 });
    expect(await page.locator('#summary-status').textContent()).not.toContain('unavailable');
    const loadMs = Date.now() - started;
    console.log(`${type}: Start settled in ${loadMs} ms; ${await page.locator('#summary-status').textContent()}`);
    await observe('loaded');
    for (let index = 0; index < meetingBatches.length; index++) {
      const before = Date.now();
      if (index) await page.evaluate(text => window.emitCommittedText(text), meetingBatches[index]);
      if (index === 2) await page.locator('#stop').click(); // Last batch drains without the timer.
      await page.waitForFunction(count => window.summaryEvidence.some(e => e.type === 'error') || window.summaryEvidence.filter(e => e.type === 'result').length === count, index + 1, { timeout: 180000 });
      const reply = await page.evaluate(() => window.summaryEvidence.at(-1));
      expect(reply.type, reply.message).toBe('result');
      await expect(notes).toHaveText(reply.summary);
      const output = await notes.textContent();
      expect(output.trim()).not.toBe(''); expect(output).toMatch(/[\u3040-\u30ff\u3400-\u9fff]/);
      expect(output).not.toContain('```');
      expect(output.trim()).not.toMatch(/^\{/);
      if (index === 1) expect(output).not.toBe(runs[0].output);
      const facts = meetingFactChecks(output, index);
      runs.push({ batch: index + 1, latencyIncludingBatchWaitMs: Date.now() - before, output, facts });
      console.log(`${type}: batch ${index + 1} emitted ${output.length} characters`);
      await observe(`batch-${index + 1}`);
    }
    await expect(page.locator('#start')).toBeEnabled({ timeout: 60000 });
    const final = await notes.textContent();
    await expect(page.locator('#errors')).toBeEmpty();
    expect(await page.evaluate(() => window.summaryWorkers.every(w => w.released))).toBe(true);
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText(meetingBatches.join('\n'));
    // Fresh session resets context; Cancel during real generation cannot write.
    const beforeCancel = await page.evaluate(() => { window.cancelSummaryOnToken = true; return window.summaryEvidence.length; });
    await page.locator('#start').click(); await expect(page.locator('#status')).toHaveText('Processing active', { timeout: 180000 });
    await expect(notes).toBeEmpty();
    // Cancel on a real decoded token, not a short-lived status string that a
    // polling assertion can miss when inference completes in <500 ms.
    await page.waitForFunction(() => window.summaryCancelToken && window.summaryWorkers.every(w => w.released), null, { timeout: 60000 });
    await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(index => window.summaryEvidence.slice(index).some(e => e.type === 'result'), beforeCancel)).toBe(false);
    expect(await page.evaluate(() => window.summaryWorkers.every(w => w.released))).toBe(true);
    await expect(notes).toBeEmpty();
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
    runs.push({ gracefulStopRetainedFinal: final, cancel: 'Owned Worker terminated after its first actual decoded token; fresh session cleared notes and published no result.' });
    const evidence = { time: new Date().toISOString(), sourceSHA256, model: spec, modelBytes: files.reduce((n,f) => n+f.bytes,0),
      runtime: JSON.parse(await readFile('scripts/meeting-summary-runtime.json', 'utf8')), host, platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model,
      gpu: gpu.gpu, loadMs, runs, observations, workerReplies: await page.evaluate(() => window.summaryEvidence), requestsAfterStart: requests, consoleErrors,
      boundaries: 'Production graph, Save, verified model cache, packaged runtime/Worker and Live display; controllable Text producer, no ASR. Host memory is not a per-model allocation measurement.' };
    await writeFile(info.outputPath(spec.key + '.json'), JSON.stringify(evidence, null, 2) + '\n');
    const factualFailures = runs.filter(run => run.facts).flatMap(run => {
      const failed = Object.entries(run.facts).filter(([, passed]) => !passed).map(([fact]) => fact);
      return failed.length ? [{ batch: run.batch, failed }] : [];
    });
    expect(factualFailures, `Factual regression; actual outputs saved in ${spec.key}.json`).toEqual([]);
  } finally {
    if (page) await writeFile(info.outputPath('diagnostics.json'), JSON.stringify({ sourceSHA256, runs, requests, consoleErrors,
      model: spec, runtime: JSON.parse(await readFile('scripts/meeting-summary-runtime.json', 'utf8')),
      host: await page.evaluate(() => ({ browser: navigator.userAgent, isolated: crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency })).catch(() => null),
      visibleNotes: await page.locator('[data-display="notes"] .display-content').textContent().catch(() => null),
      status: await page.locator('#summary-status').textContent().catch(() => ''), replies: await page.evaluate(() => window.summaryEvidence).catch(() => []) }, null, 2));
    await context?.close(); if (server) await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});
