import { test as base, expect } from '@playwright/test';
import { edge } from '../../extension/graph.js';
import { liveModelFixture, summaryGraph } from './live-model-fixture.js';

const test = base.extend({ live: async ({}, use) => {
  const fixture = await liveModelFixture();
  try { await use(fixture); } finally { await fixture.cleanup(); }
} });

async function ready(page) {
  await expect(page.locator('#model-status')).toHaveText('Ready');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#errors')).toBeEmpty();
}
async function mutate(page, mode) {
  await page.evaluate(async mode => {
    const { MODEL_CACHE_NAME } = await import('./model-asset-cache.js');
    const { textSummaryManifest } = await import('./text-summary-cache.js');
    const manifest = await textSummaryManifest('TextSummaryLfm2'), cache = await caches.open(MODEL_CACHE_NAME);
    const file = manifest.files[1];
    if (mode === 'corrupt') await cache.put(file.url, new Response(new Uint8Array(file.bytes)));
    else if (mode === 'evict') await caches.delete(MODEL_CACHE_NAME);
    else await cache.delete(file.url);
  }, mode);
}

test('clean cache downloads executable requirements, then waits for actual runtime readiness; cached reopen needs no download', async ({ live: f }) => {
  await f.save(); f.mode('hold');
  const page = await f.open({ holdModels: true });
  await expect(page.locator('#model-status')).toContainText('Downloading model… Text Summary · LFM2');
  await expect(page.locator('#model-status')).toContainText('bytes');
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
  await expect.poll(() => f.requests).toEqual(['/config.json', '/weights.bin']);
  await expect(page.locator('#live-displays')).not.toContainText('Ready summary');
  f.release();
  await expect(page.locator('#model-status')).toContainText('Preparing models…');
  await expect.poll(() => page.evaluate(() => modelWorkers.length)).toBe(1);
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => modelWorkers[0].messages)).toEqual(['load']);
  await page.evaluate(() => releaseModels()); await ready(page);
  await page.close();
  const cached = await f.open(); await ready(cached);
  expect(f.requests).toHaveLength(2);
  await cached.locator('#start').click();
  await expect(cached.locator('#live-displays')).toContainText('Ready summary');
  expect(f.requests).toHaveLength(2);
});

for (const mode of ['missing', 'corrupt', 'evict']) test(`${mode} cache downloads only invalid/missing files on next Live open`, async ({ live: f }) => {
  await f.save(); const page = await f.open(); await ready(page);
  await mutate(page, mode); await page.close();
  const next = await f.open(); await ready(next);
  expect(f.requests.filter(url => url.endsWith('config.json'))).toHaveLength(mode === 'evict' ? 2 : 1);
  expect(f.requests.filter(url => url.endsWith('weights.bin'))).toHaveLength(2);
});

test('model-free graph with a parked model becomes Ready without downloads or Workers', async ({ live: f }) => {
  const graph = summaryGraph(); graph.edges = [edge('source', 'value', 'display', 'input1')];
  await f.save(graph); const page = await f.open(); await ready(page);
  expect(f.requests).toEqual([]); expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('explicit graph selection resolves subgraph requirements without downloading the unrelated Live assignment', async ({ live: f }) => {
  const id = await f.editor.evaluate(async graph => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const store = new GraphLibrary(localStorage);
    const extracted = extractSubgraph(graph, ['summary'], 'shared-summary');
    await store.create({ id: 'shared-summary', name: 'Shared summary', kind: 'subgraph', graph: extracted.shared });
    const saved = await store.create({ name: 'Chosen parent', graph: extracted.parent });
    const id = saved.graphs.at(-1).id;
    // An unrelated default graph would require a different (blocked) manifest.
    graph.nodes.find(node => node.id === 'summary').type = 'TextSummaryQwen35';
    const other = await store.create({ name: 'Unrelated assignment', graph });
    await store.assign('live', other.graphs.at(-1).id, readLibrary(localStorage).revision);
    return id;
  }, summaryGraph());
  const page = await f.open({ graphId: id }); await ready(page);
  await expect(page.locator('#live-graph-name')).toHaveText('Chosen parent');
  expect(f.requests).toEqual(['/config.json', '/weights.bin']);
  expect(await page.evaluate(() => modelWorkers.length)).toBe(1);
  await page.locator('#start').click();
  await expect(page.locator('#live-displays')).toContainText('Ready summary');
});

for (const mode of ['network', 'corrupt', 'quota', 'offline']) test(`${mode} failure disables Start and Retry models recovers inside Live using intact files`, async ({ live: f }) => {
  await f.save();
  if (mode === 'quota') await f.context.addInitScript(() => {
    const put = Cache.prototype.put;
    Cache.prototype.put = async function(key, response) {
      if (String(key).endsWith('weights.bin')) {
        await response.body.cancel(); throw new DOMException('Fixture disk full', 'QuotaExceededError');
      }
      return put.call(this, key, response);
    };
    window.restoreCachePut = () => { Cache.prototype.put = put; };
  });
  if (mode === 'offline') await f.context.setOffline(true);
  else f.mode(mode);
  const page = await f.open();
  await expect(page.locator('#model-status')).toHaveText('Models unavailable');
  await expect(page.locator('#start')).toBeDisabled();
  await expect(page.locator('#errors')).toContainText(mode === 'corrupt' ? 'Corrupt asset' : mode === 'quota' ? 'quota exceeded' : mode === 'network' ? 'Invalid response' : 'Failed to fetch');
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
  await expect(page.locator('#retry-models')).toBeVisible();
  if (mode === 'quota') await page.evaluate(() => restoreCachePut());
  await f.context.setOffline(false); f.mode('normal');
  await page.locator('#retry-models').click(); await ready(page);
  expect(f.requests.filter(url => url.endsWith('config.json'))).toHaveLength(1);
  expect(f.requests.filter(url => url.endsWith('weights.bin'))).toHaveLength(mode === 'offline' ? 1 : 2);
});

test('two Live windows and Auto Save share one verified download; canceling a waiter leaves its peer intact', async ({ live: f }) => {
  await f.save(); f.mode('hold'); const first = await f.open();
  await expect(first.locator('#model-status')).toContainText('Downloading model…');
  const second = await f.open();
  await expect(second.locator('#model-status')).toContainText('Checking model files…');
  // Auto Save's file-only pipeline shares exactly the same origin/model locks.
  await f.editor.evaluate(async graph => {
    const { GraphModelPreparation } = await import('./graph-model-preparation.js');
    window.assetPreparation = new GraphModelPreparation();
    // Remove the deliberately parked fixture to prepare only the test manifest.
    graph.nodes = graph.nodes.filter(node => node.id !== 'parked');
    window.assetPreparation.replace(graph);
  }, summaryGraph());
  await second.locator('#stop').click();
  await expect(second.locator('#model-status')).toContainText('Preparation canceled');
  expect(f.requests).toEqual(['/config.json', '/weights.bin']);
  f.release(); await ready(first);
  await expect.poll(() => f.editor.evaluate(() => assetPreparation.entries[0].view.state)).toBe('Ready');
  await second.locator('#retry-models').click(); await ready(second);
  expect(f.requests).toEqual(['/config.json', '/weights.bin']);
  await first.close();
  await second.locator('#start').click();
  await expect(second.locator('#live-displays')).toContainText('Ready summary');
});

for (const action of ['stop', 'close', 'replace']) test(`${action} while downloading suppresses stale completion and preserves verified files`, async ({ live: f }) => {
  await f.save(); f.mode('hold'); const page = await f.open();
  await expect(page.locator('#model-status')).toContainText('Downloading model…');
  await expect.poll(() => f.requests.length).toBe(2);
  if (action === 'close') await page.close();
  else if (action === 'stop') {
    await page.locator('#stop').click(); await expect(page.locator('#model-status')).toContainText('Preparation canceled');
    await expect(page.locator('#retry-models')).toBeVisible();
  } else {
    const graph = summaryGraph(); graph.edges = [edge('source', 'value', 'display', 'input1')];
    await f.save(graph); await ready(page);
  }
  f.release();
  if (action === 'stop') {
    await expect(page.locator('#start')).toBeDisabled();
    await page.locator('#retry-models').click(); await ready(page);
  } else if (action === 'close') await ready(await f.open());
  else expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
  expect(f.requests.filter(url => url.endsWith('config.json'))).toHaveLength(1);
});
