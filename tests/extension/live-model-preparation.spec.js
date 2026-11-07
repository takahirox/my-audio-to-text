import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';

// Production MV3 UI/session/runtime, controlled Worker replies. No model assets,
// inference runtime downloads or physical GPU are needed for lifecycle checks.
test('Live gates Start on actual Worker readiness, warms gated models, restores idle, and recovers after failure', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'live-model-preparation-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: file => !file.includes('/vendor') && !file.includes('/tts-assets') });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    const worker = `self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready',id:data.id});
      if(data.type==='summarize')postMessage({type:'result',id:data.id,summary:'Ready summary'});
      if(data.type==='drain')postMessage({type:'drained',id:data.id});
      if(data.type==='fixture-fatal')postMessage({type:'error',fatal:true,message:'GPU device lost: controlled failure'});
    };`;
    await writeFile(path.join(root, 'web/text-summary-worker.js'), worker);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      viewport: { width: 390, height: 844 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const base = `chrome-extension://${id}/extension/`;
    const editor = await context.newPage(); await editor.goto(base + 'graph-editor.html');
    const source = graphNode('Text', 'source'); source.settings.value = 'Evidence';
    const graph = { version: GRAPH_VERSION, nodes: [source, graphNode('Button', 'button'), graphNode('Hold', 'held'), graphNode('TextSummaryLfm2', 'summary'), graphNode('Display', 'display'), graphNode('TextSummaryQwen35', 'parked')],
      edges: [edge('source', 'value', 'held', 'input'), edge('button', 'trigger', 'held', 'trigger'), edge('held', 'value', 'summary', 'text'), edge('summary', 'summary', 'display', 'input1')] };
    await editor.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), graph);
    const page = await context.newPage(), errors = [], remoteRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    context.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.addInitScript(() => {
      window.modelWorkers = []; window.pendingLoads = []; window.holdModelLoads = true;
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); this.messages = []; this.released = false; modelWorkers.push(this); }
        postMessage(data, ...rest) {
          this.messages.push(data.type);
          if (holdModelLoads && data.type === 'load') { pendingLoads.push(() => super.postMessage(data, ...rest)); return; }
          super.postMessage(data, ...rest);
        }
        terminate() { this.released = true; super.terminate(); }
      };
      window.releaseModels = () => { holdModelLoads = false; pendingLoads.splice(0).forEach(send => send()); };
    });
    await page.goto(base + 'recorder.html');
    await expect(page.locator('#model-status')).toContainText('Preparing models…');
    await expect(page.locator('#start')).toBeDisabled();
    await expect.poll(() => page.evaluate(() => modelWorkers.length)).toBe(1);
    expect(await page.evaluate(() => modelWorkers[0].messages)).toEqual(['load']);
    await page.evaluate(() => releaseModels());
    await expect(page.locator('#model-status')).toHaveText('Ready');
    await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#start').click();
    await expect(page.locator('#session-state')).toHaveText('Running');
    expect(await page.evaluate(() => modelWorkers.length)).toBe(1);
    expect(await page.evaluate(() => modelWorkers[0].messages)).toEqual(['load']);
    await page.locator('#graph-action-buttons button').click();
    await expect(page.locator('#live-displays')).toContainText('Ready summary');
    expect(await page.evaluate(() => modelWorkers[0].messages)).toEqual(['load', 'summarize']);
    await page.evaluate(() => { holdModelLoads = true; });
    await page.locator('#stop').click();
    await expect(page.locator('#model-status')).toContainText('Preparing models…');
    await expect(page.locator('#start')).toBeDisabled();
    await expect.poll(() => page.evaluate(() => modelWorkers[0].released)).toBe(true);
    await expect.poll(() => page.evaluate(() => modelWorkers.length)).toBe(2);
    await page.evaluate(() => releaseModels());
    await expect(page.locator('#start')).toBeEnabled();
    await page.evaluate(() => modelWorkers.at(-1).postMessage({ type: 'fixture-fatal' }));
    await expect(page.locator('#start')).toBeDisabled();
    await expect(page.locator('#errors')).toContainText('GPU device lost');
    await expect(page.locator('#model-recovery')).toBeVisible();
    await page.locator('#retry-models').click();
    await expect(page.locator('#model-status')).toHaveText('Ready');
    await expect(page.locator('#errors')).toBeEmpty();

    // Replace a pending load from a new Save; stale readiness cannot re-enable
    // Start and the executable no-model graph needs no Worker at all.
    await page.evaluate(() => { holdModelLoads = true; });
    graph.nodes.find(node => node.id === 'summary').settings.prompt = 'A new instruction';
    await editor.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), graph);
    await expect(page.locator('#model-status')).toContainText('Preparing models…');
    await expect(page.locator('#start')).toBeDisabled();
    await expect.poll(() => page.evaluate(() => modelWorkers.length)).toBe(4);
    const simple = { version: GRAPH_VERSION, nodes: [source, graphNode('Display', 'display')], edges: [edge('source', 'value', 'display', 'input1')] };
    await editor.evaluate(async graph => (await import('./graph-library.js')).saveLiveGraphData(localStorage, graph), simple);
    await expect(page.locator('#model-status')).toHaveText('Ready');
    await expect.poll(() => page.evaluate(() => modelWorkers.every(worker => worker.released))).toBe(true);
    await page.evaluate(() => releaseModels());
    await expect(page.locator('#start')).toBeEnabled();
    expect(remoteRequests).toEqual([]); expect(errors).toEqual([]);
  } finally {
    await context?.close(); await rm(temporary, { recursive: true, force: true });
  }
});
