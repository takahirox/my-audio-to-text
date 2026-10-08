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
  return page;
}
async function start(page) {
  await page.evaluate(() => window.invokeListener({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
  await expect(page.locator('#status')).toHaveText('Transcription active');
}
async function prepare(page) {
  await page.locator('#prepare-opus').click();
  await expect(page.locator('#model-status')).toHaveText('Ready');
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

for (const direction of ['ja-en', 'en-ja']) {
const target = direction === 'en-ja' ? 'Japanese' : 'English';
const open = async f => { const page = await openRecorder(f); await page.locator('#translation-direction').selectOption(direction); return page; };
test(`${direction}: MV3 opt-in UI, Worker cache reads, pairing/stale states, ordered drain and offline profile reuse`, async ({ translationExtension: f }) => {
  test.setTimeout(60000); await instrument(f); let page = await open(f);
  await expect(page.locator('#model-status')).toHaveText('Not downloaded'); expect(f.requests).toEqual([]);
  await page.locator('#translation-enabled').check(); await start(page);
  await expect(page.locator('#translation-status')).toContainText('assets missing');
  await emit(page, 'partial', '原文'); await expect(page.locator('#partial')).toHaveText('原文');
  await expect(page.locator('#partial-english')).toContainText('Translation failed');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(f.requests).toEqual([]); await prepare(page); expect(f.requests).toHaveLength(7);
  await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await emit(page, 'partial', 'old'); await expect(page.locator('#partial-english')).toHaveText(`${target}: old`);
  await emit(page, 'partial', 'slow');
  await expect(page.locator('#partial-english')).toContainText(`Older interim: ${target}: old`);
  await expect(page.locator('#partial-english')).toHaveAttribute('data-status', 'pending');
  await page.evaluate(() => {
    for(let i=0;i<100;i++)window.speech.receiveEvent({type:'partial',text:'new '+i,id:0});
    window.speech.receiveEvent({type:'final',text:'最初',id:0});
    window.speech.receiveEvent({type:'final',text:'次',id:1});
  });
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#paired-finals li')).toHaveCount(2);
  await expect(page.locator('#paired-finals li').nth(0)).toHaveText(`最初${target}: 最初`);
  await expect(page.locator('#paired-finals li').nth(1)).toHaveText(`次${target}: 次`);
  await expect(page.locator('#partial-english')).toBeEmpty();
  await page.close(); await f.restart(); await instrument(f); page = await open(f);
  await expect(page.locator('#model-status')).toHaveText('Ready'); await f.context.setOffline(true);
  await page.locator('#translation-enabled').check(); await start(page);
  await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await emit(page, 'partial', 'offline'); await expect(page.locator('#partial-english')).toHaveText(`${target}: offline`);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(f.requests).toHaveLength(7);
  await page.evaluate(async direction => {
    const { opusMtManifest } = await import('./opus-mt-manifest.js');
    const { englishToJapaneseOpusMtManifest } = await import('./opus-mt-en-ja-manifest.js');
    const manifest=await (direction === 'en-ja' ? englishToJapaneseOpusMtManifest() : opusMtManifest()); const cache=await caches.open('transformers-cache'); await cache.delete(manifest.files[0].url);
  }, direction);
  await start(page); await expect(page.locator('#translation-status')).toContainText('assets missing');
  await emit(page, 'final', 'still transcribes'); await expect(page.locator('#final')).toHaveText('still transcribes\n');
  await expect(page.locator('#paired-finals')).toContainText('Translation failed');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); expect(f.requests).toHaveLength(7);
});

test(`${direction}: production preparation reports network/quota/cancel errors, retries, and inference failure preserves ASR`, async ({ translationExtension: f }) => {
  await instrument(f); const page = await open(f);
  await expect(page.locator('#model-status')).toHaveText('Not downloaded');
  f.mode('error'); await page.locator('#prepare-opus').click(); await expect(page.locator('#model-status')).toContainText('Error');
  f.mode('hold'); await page.locator('#prepare-opus').click();
  await expect.poll(() => page.locator('#model-progress').evaluate(p => p.value)).toBeGreaterThan(0);
  await page.locator('#cancel-download').click(); await expect(page.locator('#model-status')).toContainText('Error');
  f.mode('normal');
  await page.evaluate(() => {
    const put = Cache.prototype.put; window.restorePut = () => { Cache.prototype.put = put; };
    Cache.prototype.put = async function(key, response) { await response.body.cancel(); throw new DOMException('Full', 'QuotaExceededError'); };
  });
  await page.locator('#prepare-opus').click(); await expect(page.locator('#model-status')).toContainText('quota exceeded');
  await page.evaluate(() => window.restorePut()); await prepare(page);
  await page.locator('#translation-enabled').check(); await start(page);
  await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await emit(page, 'final', 'fail'); await expect(page.locator('#translation-status')).toContainText('Controlled inference failure');
  await emit(page, 'final', '原文'); await expect(page.locator('#final')).toHaveText('fail\n原文\n');
  await expect(page.locator('#errors')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
});

for (const phase of ['loading', 'inference']) {
  test(`${direction}: window teardown during translation ${phase} prevents late paired output and releases workers`, async ({ translationExtension: f }) => {
    await instrument(f); const page = await open(f); await prepare(page);
    await page.locator('#translation-enabled').check(); await start(page);
    if (phase === 'inference') await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
    await emit(page, 'final', 'slow');
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await expect(page.locator('#paired-finals')).toContainText('Translation canceled');
    await expect.poll(() => page.evaluate(() => window.ownedWorkers.every(worker => worker.released))).toBe(true);
    await page.waitForTimeout(350);
    await expect(page.locator('#paired-finals')).not.toContainText(`${target}:`);
    await expect(page.locator('#errors')).toBeEmpty();
  });
}

test(`${direction}: missing WebAssembly in translation Worker reports failure while speech remains active`, async ({ translationExtension: f }) => {
  await f.disableWasm(direction); await instrument(f); const page = await open(f); await prepare(page);
  await page.locator('#translation-enabled').check(); await start(page);
  await expect(page.locator('#translation-status')).toContainText('requires WebAssembly');
  await emit(page, 'final', '原文'); await expect(page.locator('#final')).toHaveText('原文\n');
  await expect(page.locator('#paired-finals')).toContainText('requires WebAssembly');
  await expect(page.locator('#errors')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.ownedWorkers.every(worker => worker.released))).toBe(true);
});

test(`${direction}: Cancel during final drain releases workers, preserves originals and labels pending English canceled`, async ({ translationExtension: f }) => {
  await instrument(f); const page = await open(f); await prepare(page);
  await page.locator('#translation-enabled').check(); await start(page);
  await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await emit(page, 'final', 'slow'); await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('Finalizing transcript and translations…');
  await page.locator('#cancel-session').click();
  await expect(page.locator('#paired-finals')).toContainText('Translation canceled');
  await expect(page.locator('#final')).toHaveText('slow\n');
  await expect.poll(() => page.evaluate(() => window.ownedWorkers.every(worker => worker.released))).toBe(true);
  await expect(page.locator('#start')).toBeEnabled();
});

}

test('exclusive preference lifecycle, independent caches, immutable active direction and transcription-only repeat', async ({ translationExtension: f }) => {
  await instrument(f); let page = await openRecorder(f);
  await expect(page.locator('#translation-direction')).toHaveValue('ja-en');
  await expect(page.locator('#translation-enabled')).not.toBeChecked();
  await page.locator('#translation-direction').selectOption('en-ja');
  await expect(page.locator('#model-status')).toHaveText('Not downloaded');
  await prepare(page); expect(f.requests).toHaveLength(7);
  expect(f.requests.every(url => url.startsWith('/en-ja/'))).toBe(true);
  await page.locator('#translation-enabled').check(); await start(page);
  await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await expect(page.locator('#partial-target-label')).toHaveText('Provisional Japanese translation');
  await page.locator('#translation-direction').selectOption('ja-en');
  await expect(page.locator('#model-status')).toHaveText('Not downloaded');
  await emit(page, 'partial', 'Hello'); await expect(page.locator('#partial-english')).toHaveText('Japanese: Hello');
  await expect(page.locator('#partial-english')).toHaveAttribute('lang', 'ja');
  await emit(page, 'final', 'Hello');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#paired-finals li')).toHaveText('HelloJapanese: Hello');
  await expect(page.locator('#paired-finals li pre').nth(0)).toHaveAttribute('lang', 'en');
  await expect(page.locator('#final-pair-label')).toContainText('English original / Japanese translation');
  await prepare(page); expect(f.requests).toHaveLength(14);
  await start(page); await expect(page.locator('#translation-status')).toHaveText('Local OPUS-MT ready');
  await expect(page.locator('#paired-finals li')).toHaveCount(0);
  await emit(page, 'final', '日本語');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#paired-finals li')).toHaveText('日本語English: 日本語');
  await page.locator('#translation-direction').selectOption('en-ja');
  await expect(page.locator('#model-status')).toHaveText('Ready');
  await page.close(); await f.restart(); await instrument(f); page = await openRecorder(f);
  await expect(page.locator('#translation-direction')).toHaveValue('en-ja');
  await expect(page.locator('#translation-enabled')).toBeChecked();
  await expect(page.locator('#model-status')).toHaveText('Ready');
  await page.locator('#translation-enabled').uncheck();
  await f.context.setOffline(true); await start(page);
  await expect(page.locator('#translation-status')).toHaveText('Translation off');
  await emit(page, 'final', 'Original only'); await expect(page.locator('#final')).toHaveText('Original only\n');
  await expect(page.locator('#paired-finals')).toContainText('Translation off');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(f.requests).toHaveLength(14);
});
