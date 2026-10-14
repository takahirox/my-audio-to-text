import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = path.resolve('dist/chrome-extension');
const launch = profile => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
const load = async (context, root) => (await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root })).id;

const test = base.extend({
  translationExtension: async ({}, use) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'extension-translation-fixture-'));
    const root = path.join(temporary, 'extension'), profile = path.join(temporary, 'profile');
    const original = JSON.parse(await readFile('extension/opus-mt-assets.json', 'utf8'));
    const requests = [], bodies = new Map(['ja-en', 'en-ja'].flatMap(direction => original.map(file => [direction + '/' + file.path, Buffer.alloc(8192, direction === 'en-ja' ? 31 : 23)])));
    let mode = 'normal', context;
    const connections = new Set();
    const server = createServer((request, response) => {
      requests.push(request.url);
      connections.add(response); response.on('close', () => connections.delete(response));
      const body = bodies.get(request.url.slice(1));
      response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (mode === 'error') { response.writeHead(503); response.end(); return; }
      if (!body) { response.writeHead(404); response.end(); return; }
      response.writeHead(200); response.write(body.subarray(0, 1024));
      if (mode !== 'hold') setTimeout(() => response.end(body.subarray(1024)), 30);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await cp(bundle, root, { recursive: true, filter: source => !source.includes(`${path.sep}vendor`) });
      for (const direction of ['ja-en', 'en-ja']) {
        const entries = original.map(file => ({ path: file.path, bytes: 8192,
          sha256Chunks: [createHash('sha256').update(bodies.get(direction + '/' + file.path)).digest('hex')],
          sourceURL: `http://127.0.0.1:${server.address().port}/${direction}/${file.path}` }));
        await writeFile(path.join(root, direction === 'en-ja' ? 'extension/opus-mt-en-ja-assets.json' : 'extension/opus-mt-assets.json'), JSON.stringify(entries));
      }
      // Only ASR and model runtime are fixtures. Production Pipeline, scheduler,
      // OPUS Worker protocol, preparation, Worker cache access and UI are intact.
      for (const role of ['sherpa', 'silero']) await writeFile(path.join(root, 'web', `${role}-worker.js`), `
        self.onmessage=({data})=>{
          if(data.type==='load')postMessage({type:'ready'});
          if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
        };`);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(root, 'web/vendor/translation'), { recursive: true });
      await writeFile(path.join(root, 'web/vendor/translation/transformers.js'), `
        export const env={backends:{onnx:{wasm:{}}}};
        export async function pipeline(task,id,options){
          await new Promise(resolve=>setTimeout(resolve,150));
          if(env.allowRemoteModels!==false||env.useBrowserCache!==false)throw Error('Unexpected remote access');
          for(const name of ${JSON.stringify(original.map(file => file.path))}){
            const url='https://huggingface.co/'+id+'/resolve/'+options.revision+'/'+name;
            const response=await env.customCache.match(url);
            if(!response || (await response.arrayBuffer()).byteLength!==8192)throw Error('Worker cache access failed');
          }
          const translate=async text=>{
            await new Promise(resolve=>setTimeout(resolve,text==='slow' ? 300 : 40));
            if(text==='fail')throw Error('Controlled inference failure');
            return [{translation_text:(id==='Kadonox/opus-tatoeba-en-ja-onnx'?'Japanese: ':'English: ')+text}];
          };
          translate.tokenizer=()=>({input_ids:{dims:[1,10]}});return translate;
        }`);
      context = await launch(profile); const id = await load(context, root);
      const f = { context, requests, id, url: `chrome-extension://${id}/extension/recorder.html`,
        mode(value) { mode = value; }, async disableWasm(direction) {
          const file = path.join(root, direction === 'en-ja' ? 'web/opus-mt-en-ja-worker.js' : 'web/opus-mt-worker.js');
          await writeFile(file, 'self.WebAssembly = undefined;\n' + await readFile(file, 'utf8'));
        }, async restart() {
          await context.close(); context = await launch(profile); expect(await load(context, root)).toBe(id); this.context = context;
        } };
      await use(f);
    } finally {
      await context?.close(); for (const response of connections) response.destroy();
      await new Promise(resolve => server.close(resolve)); await rm(temporary, { recursive: true, force: true });
    }
  },
});
async function openRecorder(f) {
  const page = await f.context.newPage(); await page.goto(f.url);
  await page.evaluate(async () => {
    const { SpeechToTextNode } = await import('../web/transcription-nodes.js');
    const start = SpeechToTextNode.prototype.start;
    SpeechToTextNode.prototype.start = function(context) { window.speech = this; return start.call(this, context); };
    const { ExtensionTabAudioNode } = await import('./tab-audio-node.js');
    ExtensionTabAudioNode.prototype.start = function() {};
    ExtensionTabAudioNode.prototype.stop = function() {};
  });
  page.editor = await f.context.newPage(); await page.editor.goto(f.url.replace('recorder.html', 'graph-editor.html'));
  page.models = await f.context.newPage(); await page.models.goto(f.url.replace('recorder.html', 'model-cache.html'));
  page.direction = await page.editor.locator('#translation-direction').inputValue();
  return page;
}
async function start(page) {
  await page.evaluate(() => window.invokeListener({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
  await expect(page.locator('#status')).toHaveText('Transcription active');
}
async function prepare(page) {
  await model(page, 'button:has-text("Download / retry")').click();
  await expect(model(page, '.model-status')).toContainText('Ready');
}
async function emit(page, type, text, id = 0) {
  await page.evaluate(({ type, text, id }) => window.speech.receiveEvent({ type, text, id }), { type, text, id });
}
async function instrument(f) {
  await f.context.addInitScript(() => {
    const NativeWorker = window.Worker; window.ownedWorkers = [];
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.ownedWorkers.push(this); this.released = false; }
      terminate() { this.released = true; return super.terminate(); }
    };
    const add = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
    chrome.runtime.onMessage.addListener = listener => { window.invokeListener = listener; add(listener); };
  });
}

const originalItems = page => page.locator('[data-display="transcript"] .display-items');
const originalPreview = page => page.locator('[data-display="transcript"] .display-preview');
const pairText = page => page.locator('[data-display="translated"] .display-preview');
for (const direction of ['ja-en', 'en-ja']) {
  const target = direction === 'en-ja' ? 'Japanese' : 'English';
  const open = async f => { const page = await openRecorder(f); await setDirection(page, direction); return page; };
  for (const paired of [false, true]) test(`${direction}: direct generic translated TEXT display clears and commits repeated utterances (${paired})`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f);
    await page.evaluate(async ({ direction, paired }) => {
      const { readGraph, saveGraph, edge, GRAPH_KEY } = await import('./graph.js'); const graph = readGraph(localStorage);
      if (!paired) { graph.nodes = graph.nodes.filter(n => !['translated', 'translated-format'].includes(n.id)); graph.edges = graph.edges.filter(e => !['translated', 'translated-format'].includes(e.to[0]) && e.from[0] !== 'translated-format'); }
      const display = graph.nodes.find(n => n.id === 'transcript'); display.settings.label = '<b>Arbitrary translation</b>'; display.settings.language = direction === 'ja-en' ? 'en' : 'ja';
      graph.edges = graph.edges.filter(e => e.to[0] !== 'transcript'); graph.edges.push(edge('translation', 'provisional', 'transcript', 'replace'), edge('translation', 'text', 'transcript', 'append'));
      saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
    }, { direction, paired });
    await prepare(page); await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
    for (const id of [0, 1]) {
      await emit(page, 'partial', 'hello', id); await expect(originalPreview(page)).toHaveText(`${target}: hello`);
      await emit(page, 'final', 'hello', id); await expect(originalPreview(page)).toBeEmpty();
      await expect(originalItems(page).locator('pre')).toHaveText(Array(id + 1).fill(`${target}: hello`));
    }
    await expect(page.locator('[data-display="transcript"] h2')).toHaveText('<b>Arbitrary translation</b>');
    await expect(page.locator('[data-display="transcript"] b')).toHaveCount(0);
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  });

  test(`${direction}: append consumes any pending independent replace without inventing correlation`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f); await prepare(page);
    await page.evaluate(async () => {
      const { readGraph, saveGraph, edge, GRAPH_KEY } = await import('./graph.js'); const graph = readGraph(localStorage);
      graph.edges = graph.edges.filter(e => !(e.to[0] === 'transcript' && e.to[1] === 'append') && !(e.to[0] === 'translation' && e.to[1] === 'provisional'));
      graph.edges.push(edge('translation', 'text', 'transcript', 'append')); saveGraph(localStorage, graph); window.dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
      const { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode } = await import('../web/translation-nodes.js');
      for (const Node of [OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode]) { const receive = Node.prototype.receive; Node.prototype.receive = async function(...args) { await new Promise(resolve => { window.finishTranslation = resolve; }); return receive.apply(this, args); }; }
    });
    await start(page); await emit(page, 'final', 'older'); await expect.poll(() => page.evaluate(() => !!window.finishTranslation)).toBe(true);
    await emit(page, 'partial', 'new independent preview', 1); await expect(originalPreview(page)).toHaveText('new independent preview');
    await page.evaluate(() => window.finishTranslation()); await expect(originalItems(page)).toContainText(`${target}: older`); await expect(originalPreview(page)).toBeEmpty();
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  });

  test(`${direction}: paired formatter alone retains indexed repeated source alignment, errors and cancellation under MV3 CSP`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f); await page.editor.getByRole('button', { name: 'Remove transcript', exact: true }).click(); await page.editor.locator('#graph-save').click();
    await expect(page.editor.locator('#graph-errors')).toBeEmpty(); await prepare(page); await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
    await expect(page.locator('.live-text-region')).toHaveCount(1);
    await emit(page, 'partial', 'preview'); await expect(pairText(page)).toContainText(`${target}: ${target}: preview`);
    await emit(page, 'final', 'same', 0); await emit(page, 'final', 'same', 1); await emit(page, 'final', 'fail', 2);
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    await expect(pairText(page)).toContainText(`${target}: ${target}: same`); expect((await pairText(page).textContent()).match(new RegExp(`${target}: ${target}: same`, 'g'))).toHaveLength(2);
    await expect(pairText(page)).toContainText('Translation failed: Controlled inference failure'); await expect(pairText(page)).not.toContainText('preview');
    await start(page); await emit(page, 'final', 'slow'); await expect(pairText(page)).toContainText('Translating…'); await page.locator('#cancel-session').click();
    await expect(pairText(page)).toContainText('Translation canceled'); await expect(pairText(page)).not.toContainText(`${target}: ${target}: slow`);
    expect(await page.evaluate(() => window.ownedWorkers.every(w => w.released))).toBe(true);
  });

  test(`${direction}: preparation, stale preview, ordered drain, offline profile reuse and eviction`, async ({ translationExtension: f }) => {
    test.setTimeout(60000); await instrument(f); let page = await open(f);
    await expect(model(page, '.model-status')).toHaveText('Not downloaded'); expect(f.requests).toEqual([]); await start(page);
    await expect(page.locator('#translation-status')).toContainText('assets missing'); await emit(page, 'partial', '原文'); await expect(pairText(page)).toContainText('Translation failed');
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(f.requests).toEqual([]); await prepare(page); expect(f.requests).toHaveLength(7);
    await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
    await emit(page, 'partial', 'old'); await expect(pairText(page)).toContainText(`${target}: old`); await emit(page, 'partial', 'slow'); await expect(pairText(page)).toContainText(`Older interim: ${target}: old`);
    await page.evaluate(() => { for (let i = 0; i < 100; i++) window.speech.receiveEvent({ type: 'partial', text: 'new ' + i, id: 0 }); window.speech.receiveEvent({ type: 'final', text: '最初', id: 0 }); window.speech.receiveEvent({ type: 'final', text: '次', id: 1 }); });
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    await expect(pairText(page)).toContainText(`${target}: 最初`); await expect(pairText(page)).toContainText(`${target}: 次`); await expect(pairText(page)).not.toContainText('Older interim');
    await page.close(); await f.restart(); await instrument(f); page = await open(f); await expect(model(page, '.model-status')).toContainText('Ready'); await f.context.setOffline(true); await start(page);
    await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready'); await emit(page, 'final', 'offline'); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(f.requests).toHaveLength(7);
    await page.evaluate(async direction => { const { opusMtManifest } = await import('./opus-mt-manifest.js'); const { englishToJapaneseOpusMtManifest } = await import('./opus-mt-en-ja-manifest.js'); const manifest = await (direction === 'en-ja' ? englishToJapaneseOpusMtManifest() : opusMtManifest()); const cache = await caches.open('transformers-cache'); await cache.delete(manifest.files[0].url); }, direction);
    await start(page); await expect(page.locator('#translation-status')).toContainText('assets missing'); await emit(page, 'final', 'still transcribes'); await expect(originalItems(page)).toHaveText('still transcribes\n'); await expect(pairText(page)).toContainText('Translation failed');
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(f.requests).toHaveLength(7);
  });

  test(`${direction}: network, quota and preparation cancellation retry; inference failure leaves ASR active`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f); f.mode('error'); await model(page, 'button:has-text("Download / retry")').click(); await expect(model(page, '.model-status')).toContainText('Error');
    f.mode('hold'); await model(page, 'button:has-text("Download / retry")').click(); await expect.poll(() => model(page, 'progress').evaluate(p => p.value)).toBeGreaterThan(0); await model(page, 'button:has-text("Cancel download")').click(); await expect(model(page, '.model-status')).toContainText('Error');
    f.mode('normal'); await page.models.evaluate(() => { const put = Cache.prototype.put; window.restorePut = () => { Cache.prototype.put = put; }; Cache.prototype.put = async function(key, response) { await response.body.cancel(); throw new DOMException('Full', 'QuotaExceededError'); }; });
    await model(page, 'button:has-text("Download / retry")').click(); await expect(model(page, '.model-error')).toContainText('quota exceeded'); await page.models.evaluate(() => window.restorePut()); await prepare(page);
    await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready'); await emit(page, 'final', 'fail'); await expect(page.locator('#translation-status')).toContainText('Controlled inference failure');
    await emit(page, 'final', '原文', 1); await expect(originalItems(page)).toHaveText('fail\n原文\n'); await expect(page.locator('#errors')).toBeEmpty(); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  });

  for (const phase of ['loading', 'inference']) test(`${direction}: teardown during translation ${phase} rejects late output`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f); await prepare(page); await start(page); if (phase === 'inference') await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
    await emit(page, 'final', 'slow'); await expect(pairText(page)).toContainText('Translating…'); await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect(pairText(page)).toContainText('Translation canceled'); await expect.poll(() => page.evaluate(() => window.ownedWorkers.every(w => w.released))).toBe(true); await page.waitForTimeout(350); await expect(pairText(page)).not.toContainText(`${target}: ${target}:`); await expect(page.locator('#errors')).toBeEmpty();
  });

  test(`${direction}: unavailable WebAssembly isolates translation failure`, async ({ translationExtension: f }) => {
    await f.disableWasm(direction); await instrument(f); const page = await open(f); await prepare(page); await start(page); await expect(page.locator('#translation-status')).toContainText('requires WebAssembly');
    await emit(page, 'final', '原文'); await expect(originalItems(page)).toHaveText('原文\n'); await expect(pairText(page)).toContainText('requires WebAssembly'); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(await page.evaluate(() => window.ownedWorkers.every(w => w.released))).toBe(true);
  });

  test(`${direction}: Cancel during final drain preserves committed text and marks pending pairs canceled`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f); await prepare(page); await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready'); await emit(page, 'final', 'slow'); await page.locator('#stop').click();
    await expect(page.locator('#status')).toHaveText('Finalizing graph outputs…'); await page.locator('#cancel-session').click(); await expect(pairText(page)).toContainText('Translation canceled'); await expect(originalItems(page)).toHaveText('slow\n'); await expect.poll(() => page.evaluate(() => window.ownedWorkers.every(w => w.released))).toBe(true);
  });
}

test('saved processing direction applies next session; generic labels and existing history stay active; caches remain independent', async ({ translationExtension: f }) => {
  await instrument(f); const page = await openRecorder(f); await setDirection(page, 'en-ja'); await prepare(page); await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await setDirection(page, 'ja-en'); await emit(page, 'final', 'Hello'); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); await expect(pairText(page)).toHaveText('English: Hello\nJapanese: Japanese: Hello');
  await prepare(page); expect(f.requests).toHaveLength(14); await start(page); await expect(pairText(page)).toBeEmpty(); await emit(page, 'final', '日本語'); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); await expect(pairText(page)).toHaveText('Japanese: 日本語\nEnglish: English: 日本語');
  await page.editor.locator('#translation-enabled').uncheck(); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); await f.context.setOffline(true); await start(page); await expect(page.locator('#translation-status')).toHaveText('Translation off'); await expect(page.locator('.live-text-region')).toHaveCount(1); await emit(page, 'final', 'Original only'); await expect(originalItems(page)).toHaveText('Original only\n'); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(f.requests).toHaveLength(14);
});

function model(page, selector) { return page.models.locator(`#opus-${page.direction} ${selector}`); }
async function setDirection(page, direction) {
  await page.editor.locator('#translation-enabled').check();
  await page.editor.locator('#translation-direction').selectOption(direction);
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); page.direction = direction;
}

test('Models keeps both verified directions distinct across pages, deletion, retries and the unrelated tiny cache fixture', async ({ translationExtension: f }) => {
  const live = await openRecorder(f), models = live.models;
  await expect(models.locator('#opus-ja-en .model-status')).toHaveText('Not downloaded');
  await expect(models.locator('#opus-en-ja .model-status')).toHaveText('Not downloaded');
  const demo = await f.context.newPage(); await demo.goto(f.url.replace('recorder.html', 'cache-demo.html'));
  await demo.locator('#prepare').click(); await expect(demo.locator('#cache-status')).toHaveText('Ready');
  await models.locator('#opus-ja-en button:has-text("Check cache")').click();
  await expect(models.locator('#opus-ja-en .model-status')).toHaveText('Not downloaded');
  await prepare(live); await expect(models.locator('#opus-en-ja .model-status')).toHaveText('Not downloaded');
  const second = await f.context.newPage(); await second.goto(models.url());
  await expect(second.locator('#opus-ja-en .model-status')).toContainText('Ready');
  const count = f.requests.length;
  await models.locator('#opus-ja-en button:has-text("Delete cached assets")').click();
  await expect(models.locator('#opus-ja-en .model-status')).toHaveText('Not downloaded');
  await expect(second.locator('#opus-ja-en .model-status')).toHaveText('Not downloaded');
  await prepare(live); expect(f.requests).toHaveLength(count + 7);
  await expect(second.locator('#opus-ja-en .model-status')).toContainText('Ready');
  expect(await models.evaluate(() => window.ownedWorkers?.length || 0)).toBe(0);
});
