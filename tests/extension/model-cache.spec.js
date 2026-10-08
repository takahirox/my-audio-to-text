import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bundle = path.resolve('dist/chrome-extension');
const launch = profile => chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--enable-unsafe-extension-debugging'],
});
async function load(context, root) {
  const cdp = await context.browser().newBrowserCDPSession();
  return (await cdp.send('Extensions.loadUnpacked', { path: root })).id;
}

const test = base.extend({
  cacheExtension: async ({}, use) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'model-cache-extension-'));
    const root = path.join(temporary, 'extension'), profile = path.join(temporary, 'profile');
    const requests = [], responses = new Set(); let mode = 'normal';
    const assets = new Map(await Promise.all(['config.json', 'weights.bin'].map(async name =>
      [name, await readFile(path.join(bundle, 'extension/cache-demo', name))])));
    const server = createServer((request, response) => {
      requests.push({ url: request.url, method: request.method });
      responses.add(response); response.on('close', () => responses.delete(response));
      const name = request.url.split('/').at(-1), body = assets.get(name);
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      if (!body) { response.writeHead(404); response.end(); return; }
      if (name === 'weights.bin' && mode === 'network') { response.destroy(); return; }
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      if (name !== 'weights.bin') { response.end(body); return; }
      if (mode === 'short') { response.end(body.subarray(0, 100)); return; }
      if (mode === 'corrupt') { response.end(Buffer.alloc(body.length)); return; }
      let offset = 0;
      const send = () => {
        if (response.destroyed) return;
        if (offset === body.length) { response.end(); return; }
        response.write(body.subarray(offset, offset + 1024)); offset += 1024;
        if (mode !== 'hold') setTimeout(send, 20);
      };
      send();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    try {
      await cp(bundle, root, { recursive: true, filter: source => !source.includes(`${path.sep}vendor`) });
      const file = path.join(root, 'extension/cache-demo-manifest.js');
      const source = await readFile(file, 'utf8');
      // Replace only the data source in the test copy. Actual scripts and CSP,
      // cache keys, hashes and byte sizes stay identical to the package.
      await writeFile(file, source.replace('new URL(`./cache-demo/${file.path}`, import.meta.url).href',
        '`http://127.0.0.1:' + server.address().port + '/fixtures/${file.path}`'));
      context = await launch(profile);
      const id = await load(context, root);
      const fixture = { context, id, requests, mode(value) { mode = value; },
        url: `chrome-extension://${id}/extension/model-cache.html`,
        async restart() {
          await context.close(); context = await launch(profile);
          expect(await load(context, root)).toBe(id);
          this.context = context;
        },
      };
      await use(fixture);
    } finally {
      await context?.close();
      for (const response of responses) response.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    }
  },
});

async function open(fixture) {
  const page = await fixture.context.newPage(); await page.goto(fixture.url); return page;
}
async function prepare(page) {
  await page.locator('#prepare').click();
  await expect(page.locator('#cache-status')).toHaveText('Ready').catch(async error => {
    throw new Error(`${error.message}\nCache error: ${await page.locator('#cache-error').textContent()}`);
  });
}
async function mutate(page, mode) {
  return page.evaluate(async mode => {
    const { MODEL_CACHE_NAME } = await import('./model-asset-cache.js');
    const { CACHE_DEMO } = await import('./cache-demo-manifest.js');
    const cache = await caches.open(MODEL_CACHE_NAME), file = CACHE_DEMO.files[1];
    if (mode === 'evict') await cache.delete(file.url);
    else await cache.put(file.url, new Response(new Uint8Array(file.bytes)));
  }, mode);
}

test('actual MV3 cache UI streams downloads, reuses assets on page recreation and Chrome profile restart, and deletes', async ({ cacheExtension: f }) => {
  base.setTimeout(60000);
  let page = await open(f);
  await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
  expect(f.requests).toEqual([]);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const seen = [];
  await page.exposeFunction('recordCacheState', state => seen.push(state));
  await page.evaluate(() => new MutationObserver(() => window.recordCacheState({
    state: document.querySelector('#cache-status').textContent,
    value: document.querySelector('#progress').value,
    max: document.querySelector('#progress').max,
  })).observe(document.querySelector('#bytes'), { childList: true }));
  await prepare(page);
  expect(seen.some(state => state.state === 'Downloading' && state.value > 46 && state.value < state.max)).toBe(true);
  await expect(page.locator('#files')).toContainText('weights.bin: Cached');
  expect(f.requests).toHaveLength(2);
  expect(f.requests.every(request => request.method === 'GET' && request.url.startsWith('/fixtures/'))).toBe(true);
  expect(errors).toEqual([]);
  await page.close(); page = await open(f);
  await expect(page.locator('#cache-status')).toHaveText('Ready');
  await prepare(page); expect(f.requests).toHaveLength(2);
  await f.restart(); page = await open(f);
  await expect(page.locator('#cache-status')).toHaveText('Ready');
  await f.context.setOffline(true); await prepare(page); expect(f.requests).toHaveLength(2);
  await page.locator('#delete').click();
  await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
  await expect(page.locator('#files')).toContainText('config.json: Missing');
  await page.locator('#prepare').click(); await expect(page.locator('#cache-status')).toHaveText('Error');
  await f.context.setOffline(false); await prepare(page);
  expect(f.requests).toHaveLength(4);
});

test('closing a downloading page preserves completed files; retry, corruption and eviction recover without re-fetching valid files', async ({ cacheExtension: f }) => {
  f.mode('hold'); let page = await open(f);
  await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
  await page.locator('#prepare').click();
  await expect(page.locator('#files')).toContainText('config.json: Cached');
  await expect.poll(() => page.locator('#progress').evaluate(element => element.value)).toBeGreaterThan(46);
  await page.close(); f.mode('normal'); page = await open(f);
  await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
  await expect(page.locator('#files')).toContainText('weights.bin: Missing');
  await prepare(page);
  expect(f.requests.filter(request => request.url.endsWith('config.json'))).toHaveLength(1);
  for (const mode of ['corrupt', 'evict']) {
    await mutate(page, mode); await page.locator('#check').click();
    await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
    await expect(page.locator('#files')).toContainText('config.json: Cached');
    await prepare(page);
  }
  expect(f.requests.filter(request => request.url.endsWith('weights.bin'))).toHaveLength(4);
});

for (const mode of ['network', 'short', 'corrupt']) {
  test(`real fixture ${mode} failure exposes Error and allows missing-file retry under unchanged CSP`, async ({ cacheExtension: f }) => {
    f.mode(mode); const page = await open(f);
    await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
    await page.locator('#prepare').click(); await expect(page.locator('#cache-status')).toHaveText('Error');
    await expect(page.locator('#cache-error')).not.toBeEmpty();
    await expect(page.locator('#prepare')).toBeEnabled();
    await expect(page.locator('#files')).toContainText('weights.bin: Missing');
    f.mode('normal'); await prepare(page);
    expect(f.requests.filter(request => request.url.endsWith('config.json'))).toHaveLength(1);
  });
}

test('quota fault injection and explicit cancellation show retryable errors in the real cache UI', async ({ cacheExtension: f }) => {
  const page = await open(f);
  await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
  await page.evaluate(() => {
    const put = Cache.prototype.put;
    Cache.prototype.put = async function(key, response) {
      if (String(key).endsWith('weights.bin')) {
        await response.body.cancel(); throw new DOMException('Fixture disk full', 'QuotaExceededError');
      }
      return put.call(this, key, response);
    };
    window.restoreCachePut = () => { Cache.prototype.put = put; };
  });
  await page.locator('#prepare').click(); await expect(page.locator('#cache-status')).toHaveText('Error');
  await expect(page.locator('#cache-error')).toContainText('quota exceeded');
  await page.evaluate(() => window.restoreCachePut());
  f.mode('hold'); await page.locator('#prepare').click();
  await expect.poll(() => page.locator('#progress').evaluate(element => element.value)).toBeGreaterThan(46);
  await page.locator('#cancel').click(); await expect(page.locator('#cache-status')).toHaveText('Error');
  f.mode('normal'); await prepare(page);
});

test('two cache pages coordinate preparation and deletion through extension-origin Web Locks', async ({ cacheExtension: f }) => {
  const first = await open(f), second = await open(f);
  await expect(first.locator('#cache-status')).toHaveText('Not downloaded');
  await expect(second.locator('#cache-status')).toHaveText('Not downloaded');
  await Promise.all([first.locator('#prepare').click(), second.locator('#prepare').click()]);
  await expect(first.locator('#cache-status')).toHaveText('Ready');
  await expect(second.locator('#cache-status')).toHaveText('Ready');
  expect(f.requests).toHaveLength(2);
  await first.locator('#delete').click(); await expect(first.locator('#cache-status')).toHaveText('Not downloaded');
  await second.locator('#check').click(); await expect(second.locator('#cache-status')).toHaveText('Not downloaded');
});

base('unmodified packaged options page prepares project-owned fixtures without capture, inference or remote requests', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'packaged-cache-demo-'));
  const context = await launch(profile);
  try {
    const id = await load(context, bundle), page = await context.newPage();
    const requests = [], errors = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${id}/extension/model-cache.html`);
    await expect(page.locator('#cache-status')).toHaveText('Not downloaded');
    await prepare(page);
    expect(requests.every(url => url.startsWith(`chrome-extension://${id}/`))).toBe(true);
    expect(requests.some(url => /worker|vendor|recorder\.js/.test(url))).toBe(false);
    expect(errors).toEqual([]);
    await page.locator('#persist').click();
    const actual = await page.evaluate(() => navigator.storage.persisted());
    await expect(page.locator('#persistence')).toHaveText(`Persistent storage: ${actual ? 'granted' : 'denied'}.`);
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
