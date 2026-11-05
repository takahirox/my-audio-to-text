import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Actual MV3 package, production recorder/session/editor/Pipeline and DOM.
// Capture and model Workers are controlled fixtures; no model download or real
// GPU, speech recognition, hardware permission, or throughput claim is made.
test('Live Graph Actions: manual ASR snapshots, keyboard/touch, busy, tabs, Stop, Cancel/restart, errors and stale handlers at 390px', async () => {
  test.setTimeout(60000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'graph-actions-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: file => !file.includes('/vendor') && !file.includes('/tts-assets') });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    for (const role of ['sherpa', 'silero']) await writeFile(path.join(root, `web/${role}-worker.js`), `
      self.onmessage=({data})=>{if(data.type==='load')postMessage({type:'ready'});if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});};`);
    await writeFile(path.join(root, 'web/text-summary-worker.js'), `
      const jobs=[];
      self.onmessage=({data})=>{
        if(data.type==='load')postMessage({type:'ready',id:data.id});
        if(data.type==='summarize')jobs.push(data);
        if(data.type==='complete'){
          const job=jobs.shift(); if(!job)return;
          postMessage(job.text.includes('FAIL')?{type:'error',id:job.id,message:'Controlled inference failure'}:{type:'result',id:job.id,summary:'Summary: '+job.text});
        }
      };`);
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      viewport: { width: 390, height: 844 }, hasTouch: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    context.setDefaultTimeout(7000);
    context.setDefaultTimeout(5000);
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const base = `chrome-extension://${id}/extension/`;
    const editor = await context.newPage(); await editor.goto(base + 'graph-editor.html');
    const graph = JSON.parse(await readFile('docs/examples/manual-text-summary.json', 'utf8'));
    // Exercise production Import; resource preparation is separately tested in
    // graph-text-summary.spec.js. Persist the identical fixture without downloads.
    await editor.locator('.graph-actions > summary').click();
    await editor.locator('input[type=file]').setInputFiles({ name: 'manual.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await expect(editor.getByRole('button', { name: 'held input trigger', exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Select generate', exact: true }).click();
    await expect(editor.getByLabel('generate label', { exact: true })).toHaveValue('Generate summary');
    await editor.evaluate(async graph => (await import('./graph.js')).saveGraph(localStorage, graph), graph);
    await editor.reload();
    expect(await editor.evaluate(async () => (await import('./graph.js')).readGraph(localStorage))).toEqual(graph);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      const add = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
      chrome.runtime.onMessage.addListener = listener => { window.invoke = listener; add(listener); };
    });
    await page.goto(base + 'recorder.html');
    await page.evaluate(async () => {
      window.summaryWorkers = []; window.requests = []; window.violations = [];
      addEventListener('securitypolicyviolation', e => violations.push(e.violatedDirective));
      const { TabSession } = await import('./session.js');
      const start = TabSession.prototype.start;
      TabSession.prototype.start = function(...args) {
        window.owner = this;
        this.textSummaryWorkerFactory = url => {
          const worker = new Worker(url, { type: 'module' });
          const post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
          worker.postMessage = data => { if(data.type==='summarize') requests.push(data.text); post(data); };
          worker.terminate = () => { worker.released = true; terminate(); };
          summaryWorkers.push(worker); return worker;
        };
        return start.apply(this, args);
      };
      const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
      ExtensionTabAudioNode.prototype.start = function() {};
      ExtensionTabAudioNode.prototype.stop = function() {};
      window.begin = () => owner.start(42);
      window.emitFinal = text => owner.session.pipeline.entries.get('speech').node.receiveEvent({ type: 'final', text });
      window.complete = () => summaryWorkers.at(-1).postMessage({ type: 'complete' });
    });
    const action = page.locator('#graph-action-buttons button[data-node-id=generate]');
    await expect(action).toHaveText('Generate summary'); await expect(action).toBeDisabled();
    await expect(page.locator('#graph-action-status')).toContainText('Start a session');
    // Enter through the recorder's registered production toolbar listener.
    await page.evaluate(() => invoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }, () => {}));
    await expect(page.locator('#status')).toHaveText('Transcription active');
    expect(await page.evaluate(() => summaryWorkers.length)).toBe(0);
    await page.evaluate(() => emitFinal('A')); await expect(page.getByRole('tabpanel', { name: 'Transcript', exact: true })).toContainText('A');
    await expect(action).toBeEnabled();
    await page.evaluate(() => { window.stale = document.querySelector('#graph-action-buttons button').onclick; });
    await action.press('Enter'); await expect(action).toBeDisabled();
    await expect.poll(() => page.evaluate(() => requests)).toEqual(['A']);
    await expect(page.locator('#graph-action-status')).toContainText('busy');
    await page.evaluate(() => { document.querySelector('#graph-action-buttons button').click(); emitFinal('B'); });
    await expect(page.getByRole('tabpanel', { name: 'Transcript', exact: true })).toContainText('A\nB');
    expect(await page.evaluate(() => requests)).toEqual(['A']);
    await page.evaluate(() => complete()); await expect(action).toBeEnabled();
    await page.getByRole('tab', { name: 'Summary', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Summary', exact: true })).toContainText('Summary: A');
    await expect(page.getByRole('tabpanel', { name: 'Transcript', exact: true })).toBeHidden();
    await page.screenshot({ path: 'test-results/graph-actions-390.png', fullPage: true });
    await action.tap(); await expect.poll(() => page.evaluate(() => requests)).toEqual(['A', 'A\nB']);
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Finalizing'); await expect(action).toBeDisabled();
    await page.evaluate(() => complete()); await expect(page.locator('#status')).toContainText('Stopped.');
    await expect(page.getByRole('tabpanel', { name: 'Summary', exact: true })).toContainText('Summary: A\nB');
    await page.locator('#start').click(); await expect(action).toBeEnabled();
    await page.evaluate(() => stale()); expect(await page.evaluate(() => requests.length)).toBe(2);
    await page.evaluate(() => emitFinal('C')); await action.press('Space');
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(3);
    await page.locator('#cancel-session').click(); await expect(action).toBeDisabled();
    expect(await page.evaluate(() => summaryWorkers.every(w => w.released))).toBe(true);
    await page.locator('#start').click(); await expect(action).toBeEnabled();
    await page.evaluate(() => emitFinal('FAIL')); await action.tap();
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(4);
    await page.evaluate(() => complete()); await expect(page.locator('#summary-status')).toContainText('Controlled inference failure');
    await expect(action).toBeDisabled(); await expect(page.locator('#graph-action-status')).toContainText('unavailable');
    await page.getByRole('tab', { name: 'Transcript', exact: true }).tap();
    await page.evaluate(() => emitFinal('D')); await expect(page.getByRole('tabpanel', { name: 'Transcript', exact: true })).toContainText('FAIL\nD');
    const layout = await action.evaluate(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height, right: button.getBoundingClientRect().right, viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(layout.height).toBeGreaterThanOrEqual(44); expect(layout.right).toBeLessThanOrEqual(layout.viewport); expect(layout.scroll).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]); expect(await page.evaluate(() => violations)).toEqual([]);
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped.');
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});

test('Button Sources palette, caption Save/Load/Import/Export, duplicate captions, stable IDs, fan-out and audio-free Start', async () => {
  test.setTimeout(60000);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'button-editor-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: file => !file.includes('/vendor') && !file.includes('/tts-assets') });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    context.setDefaultTimeout(5000);
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const base = `chrome-extension://${id}/extension/`, editor = await context.newPage();
    await editor.goto(base + 'graph-editor.html');
    const graph = await editor.evaluate(async () => {
      const { graphNode, edge, saveGraph, GRAPH_VERSION } = await import('./graph.js');
      const graph = { version: GRAPH_VERSION, nodes: ['Button', 'Button', 'Text', 'Text', 'Hold', 'Hold', 'Display', 'Display', 'Display', 'Button'].map((type, i) => graphNode(type, ['z', 'a', 'one', 'two', 'h1', 'h2', 'd1', 'd2', 'fanout', 'parked'][i], 20 + i * 360, i % 2 * 350)), edges: [
        edge('z', 'trigger', 'h1', 'trigger'), edge('one', 'value', 'h1', 'input'), edge('h1', 'value', 'd1', 'input1'), edge('h1', 'value', 'fanout', 'input1'),
        edge('a', 'trigger', 'h2', 'trigger'), edge('two', 'value', 'h2', 'input'), edge('h2', 'value', 'd2', 'input1')] };
      graph.nodes.find(n => n.id === 'one').settings.value = 'one'; graph.nodes.find(n => n.id === 'two').settings.value = 'two';
      saveGraph(localStorage, graph); return graph;
    });
    await editor.reload();
    await editor.getByRole('button', { name: 'Add Node', exact: true }).click();
    await editor.getByLabel('Node category', { exact: true }).selectOption({ label: 'Sources / inputs' });
    await expect(editor.locator('#graph-node-type option[value=Button]')).toHaveCount(1);
    await editor.locator('#graph-palette-toggle').click();
    await editor.getByRole('button', { name: 'Select z', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'z output trigger', exact: true })).toBeVisible();
    expect(await editor.locator('[data-node=z] [data-direction=input]').count()).toBe(0);
    await editor.getByLabel('z label', { exact: true }).fill('Duplicate'); await editor.getByLabel('z label', { exact: true }).press('Tab');
    await editor.getByRole('button', { name: 'Select a', exact: true }).click();
    await editor.getByLabel('a label', { exact: true }).fill('Duplicate'); await editor.getByLabel('a label', { exact: true }).press('Tab');
    await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
    await editor.reload();
    const saved = await editor.evaluate(async () => (await import('./graph.js')).readGraph(localStorage));
    expect(saved.nodes.filter(n => ['a', 'z'].includes(n.id)).map(n => n.settings.label)).toEqual(['Duplicate', 'Duplicate']);
    await editor.getByRole('button', { name: 'Select z', exact: true }).click();
    await editor.getByLabel('z label', { exact: true }).fill('Unsaved'); await editor.getByLabel('z label', { exact: true }).press('Tab');
    await editor.locator('.graph-actions > summary').click();
    editor.once('dialog', d => d.accept()); await editor.locator('#graph-load').click();
    await editor.getByRole('button', { name: 'Select z', exact: true }).click();
    await expect(editor.getByLabel('z label', { exact: true })).toHaveValue('Duplicate');
    await editor.locator('.graph-actions > summary').click();
    const downloadPromise = editor.waitForEvent('download'); await editor.locator('#graph-export').click();
    const download = await downloadPromise, exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    expect(exported).toEqual(saved);
    await editor.locator('.graph-actions > summary').click();
    await editor.locator('input[type=file]').setInputFiles({ name: 'buttons.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await expect(editor.locator('#graph-errors')).toBeEmpty();
    await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
    const page = await context.newPage(); await page.goto(base + 'recorder.html');
    const buttons = page.locator('#graph-action-buttons button');
    await expect(buttons).toHaveCount(2); expect(await buttons.evaluateAll(nodes => nodes.map(n => n.dataset.nodeId))).toEqual(['a', 'z']);
    await expect(buttons.first()).toBeDisabled(); await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#start').click(); await expect(page.locator('#status')).toHaveText('Processing active');
    await page.locator('[data-node-id=a]').click();
    await expect(page.locator('[data-display=d2]')).toContainText('two'); await expect(page.locator('[data-display=d1] .display-content')).toBeEmpty();
    await page.locator('[data-node-id=z]').click();
    await expect(page.locator('[data-display=d1]')).toContainText('one'); await expect(page.locator('[data-display=fanout]')).toContainText('one');
    await page.locator('[data-node-id=z]').click(); // equal NUMBER remains another delivery
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped.');
    expect(graph.nodes.find(n => n.id === 'z').settings.label).toBe('Run action');
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});
