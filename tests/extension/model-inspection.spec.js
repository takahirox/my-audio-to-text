import { test, expect } from './graph-fixture.js';

async function openModels(f) {
  const page = await f.context.newPage();
  await page.goto(f.url.replace('recorder.html', 'model-cache.html'));
  return page;
}
const card = page => page.locator('#opus-ja-en');
const state = (page, value) => expect(card(page)).toHaveAttribute('data-state', value);
// Headless Chrome does not send window focus events when switching tabs.
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));
async function download(page) {
  await card(page).getByRole('button', { name: 'Download / retry', exact: true }).click();
  await state(page, 'Ready');
}

test('Models automatically inspects on open, focus and cross-page updates; corruption and eviction recover without a manual check', async ({ graphExtension: f }) => {
  const first = await openModels(f), second = await openModels(f);
  for (const page of [first, second]) {
    await expect(page.locator('.model-card[data-state="Not downloaded"]')).toHaveCount(17);
    await expect(page.getByRole('button', { name: 'Check cache', includeHidden: true })).toHaveCount(0);
  }
  expect(f.requests).toEqual([]);
  await download(first);
  await state(second, 'Ready'); // Preparation broadcasts to the other Models page.
  expect(f.requests).toHaveLength(7);
  await second.reload(); await state(second, 'Ready');
  expect(f.requests).toHaveLength(7);

  // Returning from another page must revalidate bytes, even if size matches.
  await second.evaluate(async () => {
    const { opusMtManifest } = await import('./opus-mt-manifest.js');
    const file = (await opusMtManifest()).files[0];
    await (await caches.open('transformers-cache')).put(file.url,
      new Response(new Uint8Array(file.bytes), { headers: { 'Content-Length': String(file.bytes) } }));
  });
  await focus(first); await state(first, 'Not downloaded');
  await expect(card(first).locator('li').first()).toContainText('Missing');
  await expect(card(first).locator('li').nth(1)).toContainText('Cached');
  expect(f.requests).toHaveLength(7); // Inspection never downloads.
  await download(first); await state(second, 'Ready');
  expect(f.requests).toHaveLength(8); // Only the corrupt file is fetched again.

  // A relevant update from another extension page must also detect eviction.
  await second.evaluate(async () => {
    const { opusMtManifest } = await import('./opus-mt-manifest.js');
    await (await caches.open('transformers-cache')).delete((await opusMtManifest()).files[1].url);
    const channel = new BroadcastChannel('model-cache-updates');
    channel.postMessage({ id: 'opus-ja-en' }); channel.close();
  });
  await state(first, 'Not downloaded'); await state(second, 'Not downloaded');
  await expect(card(first).locator('li').nth(1)).toContainText('Missing');
  await download(first); await state(second, 'Ready');
  expect(f.requests).toHaveLength(9);
  await card(second).getByRole('button', { name: 'Delete cached assets', exact: true }).click();
  await state(second, 'Not downloaded'); await state(first, 'Not downloaded');
  await expect(card(first).locator('li')).toHaveText(Array(7).fill(/: Missing$/));
});

test('Models inspection errors give actionable recovery through focus and Download / retry', async ({ graphExtension: f }) => {
  const page = await openModels(f);
  await state(page, 'Not downloaded');
  await page.evaluate(async () => {
    const { ModelAssetCache } = await import('./model-asset-cache.js');
    const inspect = ModelAssetCache.prototype.inspect;
    ModelAssetCache.prototype.inspect = async () => { throw Error('Fixture inspection failure.'); };
    window.restoreInspection = () => { ModelAssetCache.prototype.inspect = inspect; };
  });
  await focus(page); await state(page, 'Error');
  await expect(card(page).getByRole('alert')).toContainText('Return to Models to check again automatically');
  await expect(card(page).getByRole('alert')).toContainText('Download / retry');
  await expect(card(page).getByRole('button', { name: 'Download / retry', exact: true })).toBeEnabled();
  await page.evaluate(() => window.restoreInspection());
  await focus(page); await state(page, 'Not downloaded');
  await expect(card(page).locator('.model-error')).toBeEmpty();
  await download(page); expect(f.requests).toHaveLength(7);
});
