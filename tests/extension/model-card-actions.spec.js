import { test, expect } from './graph-fixture.js';

const action = card => card.getByRole('button', { name: /^(Download|Retry)$/ });
async function open(f) {
  const page = await f.context.newPage(); await page.goto(f.url.replace('recorder.html', 'model-cache.html')); return page;
}
const focus = page => page.evaluate(() => window.dispatchEvent(new Event('focus')));

test('initial inspection hides Download; Ready hides it entirely; partial cache and delete allow download again', async ({ graphExtension: f }) => {
  await f.context.addInitScript(() => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    window.releaseInspection = release;
    const open = CacheStorage.prototype.open;
    CacheStorage.prototype.open = async function(...args) { await gate; return open.apply(this, args); };
  });
  const page = await open(f), card = page.locator('#opus-ja-en');
  await expect(card).toHaveAttribute('data-state', 'Checking');
  await expect(action(card)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Check cache' })).toHaveCount(0);
  await page.evaluate(() => window.releaseInspection());
  await expect(card).toHaveAttribute('data-state', 'Not downloaded');
  await card.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Ready');
  await expect(action(card)).toBeHidden();
  await expect(card.getByRole('button', { name: 'Delete cached assets' })).toBeEnabled();
  await expect(card.locator('.model-license a')).toBeVisible();
  await card.getByText('Verified files and size', { exact: true }).click();
  await expect(card.locator('li').first()).toContainText('Cached');
  const count = f.requests.length;
  await page.evaluate(async () => {
    const { opusMtManifest } = await import('./opus-mt-manifest.js');
    const manifest = await opusMtManifest(), cache = await caches.open('transformers-cache');
    await cache.delete(manifest.files.at(-1).url);
  });
  await focus(page);
  await expect(card).toHaveAttribute('data-state', 'Not downloaded');
  await expect(card.locator('li').first()).toContainText('Cached');
  await expect(card.locator('li').last()).toContainText('Missing');
  await card.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Ready');
  expect(f.requests).toHaveLength(count + 1);
  await card.getByRole('button', { name: 'Delete cached assets' }).click();
  await expect(card).toHaveAttribute('data-state', 'Not downloaded');
  await expect(card.locator('li').first()).toContainText('Missing');
  await card.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Ready');
  await expect(action(card)).toBeHidden();
});

test('active download hides actions on both pages; cancellation and failure retain Retry through focus and cache notifications', async ({ graphExtension: f }) => {
  const first = await open(f), second = await open(f);
  const card = first.locator('#opus-ja-en'), other = second.locator('#opus-ja-en');
  await expect(other).toHaveAttribute('data-state', 'Not downloaded');
  f.mode('hold'); await card.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(card.locator('progress')).toBeVisible();
  await expect.poll(() => card.locator('progress').evaluate(p => p.value)).toBeGreaterThan(0);
  await expect(action(card)).toBeHidden();
  await expect(other).toHaveAttribute('data-state', 'Checking');
  await expect(action(other)).toBeHidden();
  await expect(other.getByRole('button', { name: 'Cancel download' })).toBeHidden();
  await focus(first); // Queued reinspection must not erase cancellation's error.
  await card.getByRole('button', { name: 'Cancel download' }).click();
  await expect(card).toHaveAttribute('data-state', 'Error');
  await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(card.locator('.model-error')).not.toBeEmpty();
  f.mode('corrupt'); await card.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Error');
  const error = await card.locator('.model-error').textContent();
  await focus(first);
  await second.evaluate(() => { const channel = new BroadcastChannel('model-cache-updates'); channel.postMessage({ id: 'opus-ja-en' }); channel.close(); });
  await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(card.locator('.model-error')).toHaveText(error);
  f.mode('normal'); await card.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Ready');
  await expect(other).toHaveAttribute('data-state', 'Ready');
  await expect(action(card)).toBeHidden(); await expect(action(other)).toBeHidden();
  await card.getByRole('button', { name: 'Delete cached assets' }).click();
  await expect(other).toHaveAttribute('data-state', 'Not downloaded');
  await expect(other.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
});

test('successful deletion on another Models page clears an obsolete failure through later focus checks', async ({ graphExtension: f }) => {
  const first = await open(f), second = await open(f);
  const card = first.locator('#opus-ja-en'), other = second.locator('#opus-ja-en');
  await expect(other).toHaveAttribute('data-state', 'Not downloaded');
  f.mode('corrupt');
  await card.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Error');
  await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(card.locator('.model-error')).not.toBeEmpty();
  const count = f.requests.length;
  await other.getByRole('button', { name: 'Delete cached assets' }).click();
  for (const model of [other, card]) {
    await expect(model).toHaveAttribute('data-state', 'Not downloaded');
    await expect(model.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await expect(model.locator('.model-error')).toBeEmpty();
  }
  await focus(first);
  await expect(card).toHaveAttribute('data-state', 'Not downloaded');
  await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
  expect(f.requests).toHaveLength(count);
  f.mode('normal');
  await card.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(card).toHaveAttribute('data-state', 'Ready');
  await expect(other).toHaveAttribute('data-state', 'Ready');
});

for (const [id, firstVoice, secondVoice] of [['supertonic3', 'F1', 'M1'], ['kokoro', 'jf_alpha', 'af_heart']]) {
  test(`${id} cross-page deletion clears only the deleted voice's remembered failure`, async ({ graphExtension: f }) => {
    const first = await open(f), second = await open(f);
    const card = first.locator(`#${id}`), other = second.locator(`#${id}`);
    f.mode('corrupt');
    for (const voice of [firstVoice, secondVoice]) {
      await card.locator('select').selectOption(voice);
      await card.getByRole('button', { name: 'Download', exact: true }).click();
      await expect(card).toHaveAttribute('data-state', 'Error');
    }
    const error = await card.locator('.model-error').textContent();
    await other.locator('select').selectOption(firstVoice);
    await other.getByRole('button', { name: 'Delete cached assets' }).click();
    await expect(other).toHaveAttribute('data-state', 'Not downloaded');
    await focus(first);
    await expect(card.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await expect(card.locator('.model-error')).toHaveText(error);
    await card.locator('select').selectOption(firstVoice);
    await expect(card).toHaveAttribute('data-state', 'Not downloaded');
    await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await expect(card.locator('.model-error')).toBeEmpty();
  });

  test(`${id} actions follow selected voice, shared files and cross-page deletion without changing unrelated assets`, async ({ graphExtension: f }) => {
    const page = await open(f), card = page.locator(`#${id}`), unrelated = page.locator('#opus-en-ja');
    await unrelated.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(unrelated).toHaveAttribute('data-state', 'Ready');
    await card.locator('select').selectOption(firstVoice);
    await card.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready'); await expect(action(card)).toBeHidden();
    const count = f.requests.length;
    await card.locator('select').selectOption(secondVoice);
    await expect(card.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready'); expect(f.requests).toHaveLength(count + 1);
    const other = await open(f), otherCard = other.locator(`#${id}`);
    await expect(otherCard).toHaveAttribute('data-state', 'Ready');
    await card.getByRole('button', { name: 'Delete cached assets' }).click();
    await expect(otherCard.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await card.locator('select').selectOption(firstVoice);
    await card.getByText('Verified files and size', { exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Not downloaded');
    await expect(card.locator('li').filter({ hasText: id === 'kokoro' ? 'voices/jf_alpha.bin: Cached' : 'voice_styles/F1.json: Cached' })).toHaveCount(1);
    await expect(unrelated).toHaveAttribute('data-state', 'Ready'); await expect(action(unrelated)).toBeHidden();
    const before = f.requests.length;
    await card.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready');
    expect(f.requests.slice(before).some(url => url.includes(id === 'kokoro' ? 'voices/' : 'voice_styles/'))).toBe(false);
  });
}
