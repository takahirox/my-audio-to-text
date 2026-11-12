import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Production extension pages, storage, editor and session. Only model inference
// replies are controlled; these checks need no large model download or GPU.
export const test = base.extend({
  libraryExtension: async ({}, use) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'graph-library-'));
    let context;
    try {
      const root = path.join(temporary, 'extension');
      await cp('extension', path.join(root, 'extension'), { recursive: true });
      await cp('web', path.join(root, 'web'), { recursive: true, filter: file => !file.includes('/vendor') && !file.includes('/tts-assets') });
      await cp('extension/manifest.json', path.join(root, 'manifest.json'));
      // Call the registered production event handlers while Chrome owns the real
      // menus, worker, offscreen DOM, windows and storage. Headless has no toolbar.
      await writeFile(path.join(root, 'extension/toolbar-test-harness.js'), `
        globalThis.toolbarEvents = {}; globalThis.toolbarMenus = {};
        for (const [name, event] of [['action', chrome.action.onClicked], ['menu', chrome.contextMenus.onClicked]]) {
          const add = event.addListener.bind(event);
          event.addListener = listener => { toolbarEvents[name] = listener; add(listener); };
        }
        const create = chrome.contextMenus.create.bind(chrome.contextMenus);
        chrome.contextMenus.create = (item, done) => { toolbarMenus[item.id] = item; return create(item, done); };
        const remove = chrome.contextMenus.removeAll.bind(chrome.contextMenus);
        chrome.contextMenus.removeAll = async () => { toolbarMenus = {}; return remove(); };
      `);
      const background = path.join(root, 'extension/background.js');
      await writeFile(background, "import './toolbar-test-harness.js';\n" + await readFile(background, 'utf8'));

      await writeFile(path.join(root, 'web/text-summary-worker.js'), `self.onmessage=({data})=>{
        if(data.type==='load')postMessage({type:'ready',id:data.id});
        if(data.type==='summarize')postMessage({type:'result',id:data.id,summary:'Summary from selected graph'});
        if(data.type==='drain')postMessage({type:'drained',id:data.id});
      };`);
      const launch = () => chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
        viewport: { width: 1440, height: 1000 }, ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
      context = await launch();
      const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
      // Persisted default ASR now has ordinary downloadable dependencies. These
      // UI-only checks serve small verified data fixtures, without remote models.
      for (const name of ['reazon', 'silero']) {
        const file = path.join(root, 'extension', `${name}-assets.json`);
        const manifest = JSON.parse(await readFile(file, 'utf8')), body = Buffer.from('UI-only ASR fixture');
        await writeFile(path.join(root, 'extension', `${name}-fixture.bin`), body);
        manifest.files = [{ path: 'fixture.bin', bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: `chrome-extension://${id}/extension/${name}-fixture.bin` }];
        await writeFile(file, JSON.stringify(manifest));
      }
      const url = `chrome-extension://${id}/extension/`, errors = [], remote = [], allowedRemote = [];
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      context.on('request', request => { if (/^https?:/.test(request.url()) && !allowedRemote.some(prefix => request.url().startsWith(prefix))) remote.push(request.url()); });
      await context.addInitScript(() => {
        window.modelWorkers = []; window.pendingLoads = []; window.holdModelLoads = false;
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) { super(...args); this.messages = []; this.released = false; modelWorkers.push(this); }
          postMessage(data, ...rest) {
            this.messages.push(data.type);
            if (window.holdModelLoads && data.type === 'load') { pendingLoads.push(() => { if (!this.released) super.postMessage(data, ...rest); }); return; }
            super.postMessage(data, ...rest);
          }
          terminate() { this.released = true; super.terminate(); }
        };
        window.releaseModels = () => { holdModelLoads = false; pendingLoads.splice(0).forEach(send => send()); };
      });
      const page = await context.newPage(); await page.goto(url + 'graph-library.html');
      await expect(page.locator('#graph-list button[data-id]')).toHaveCount(1);
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const f = { context, page, url, errors, remote, worker, allowedRemote, async restart() {
        await context.close(); context = await launch();
        const loaded = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
        expect(loaded.id).toBe(id);
        this.context = context;
        this.worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
        this.page = await context.newPage(); await this.page.goto(url + 'graph-library.html');
      } };
      await use(f);
      expect(errors).toEqual([]); expect(remote).toEqual([]);
    } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
  },
});
export { expect };
export const library = page => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')));
export async function create(page, name, graph) {
  return page.evaluate(async ({ name, graph }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    return (await new GraphLibrary(localStorage).create({ name, graph }, readLibrary(localStorage).revision)).graphs.at(-1).id;
  }, { name, graph });
}
