import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('Models wraps real manifests, licenses, expanded file paths and controls at narrow and wide widths', async ({ page, browserName }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css|json)$/.test(pathname)) return route.continue();
    const types = { js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json' };
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: types[pathname.split('.').at(-1)] });
  });
  await page.addInitScript(() => {
    window.openedPages = [];
    window.chrome = { runtime: { getURL: p => location.origin + '/' + p },
      tabs: { create: async options => window.openedPages.push(options) } };
  });
  await page.goto('/extension/model-cache.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Models');
  const navigation = page.getByRole('navigation', { name: 'View', exact: true });
  await expect(navigation.locator(':scope > *')).toHaveText(['Library']);
  const library = navigation.getByRole('link', { name: 'Library', exact: true });
  await expect(library).toHaveAttribute('href', 'graph-library.html');
  await expect(library).toHaveAttribute('data-page', 'graph-library.html');
  await expect(page.locator('#navigation-status')).toHaveCount(0);
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(library).toBeFocused();
  await expect(page.locator('.model-card')).toHaveCount(12);
  await expect(page.locator('.model-card[data-state="Not downloaded"]')).toHaveCount(12);
  await expect(page.getByRole('button', { name: 'Check cache', includeHidden: true })).toHaveCount(0);
  for (const card of await page.locator('.model-card').all()) {
    await expect(card.getByRole('button')).toHaveText(['Download / retry', 'Delete cached assets']);
    await expect(card.getByRole('button', { name: 'Cancel download', includeHidden: true })).toBeHidden();
    await expect(card.getByRole('status')).toHaveText('Not downloaded');
    for (const link of await card.locator('.model-license a').all()) await expect(link).toBeVisible();
  }
  const gemma = page.locator('#translategemma');
  await expect(gemma).toContainText('3.112 GB download shared by both directions');
  await expect(gemma).toContainText('Google / ONNX Community · Gemma Terms');
  await expect(gemma).toContainText('Gemma Terms of Use and Prohibited Use Policy apply to this conversion. Read before downloading or using.');
  await expect(page.locator('footer')).toHaveCount(0);
  await expect(page.getByText('Before using TranslateGemma 4B, read', { exact: false })).toHaveCount(0);
  for (const [id, name, href] of [
    ['translategemma', 'Gemma terms & attribution', '../web/licenses/gemma-notices.txt'],
    ['supertonic3', 'OpenRAIL-M weights and voices', '../web/licenses/tts-notices.txt'],
    ['kokoro', 'Apache-2.0 weights; frontends have separate notices', '../web/licenses/tts-notices.txt'],
    ['kokoro', 'eSpeak NG source / build bundle (GPL-3.0-or-later)', '../web/tts-assets/phonemizer-source.tar.gz'],
  ]) {
    const link = page.locator(`#${id}`).getByRole('link', { name, exact: true });
    await expect(link).toBeVisible(); await expect(link).toHaveAttribute('href', href);
  }
  await expect(page.locator('a[href="../web/licenses/gemma-notices.txt"]')).toHaveCount(1);
  await gemma.getByText('Verified files and size', { exact: true }).click();
  const spec = JSON.parse(await readFile('extension/translategemma-assets.json'));
  await expect(gemma.locator('li')).toHaveCount(spec.length);
  await gemma.locator('summary').focus();
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(gemma.getByRole('link', { name: 'Gemma terms & attribution', exact: true })).toBeFocused();
  for (const width of [320, 390, 800, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await gemma.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('#kokoro').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.locator('body').evaluate(el => el.getBoundingClientRect().bottom - document.querySelector('main').getBoundingClientRect().bottom)).toBeLessThanOrEqual(20);
    await expect(library).toBeInViewport({ ratio: 1 });
    expect((await library.boundingBox()).height).toBeGreaterThanOrEqual(44);
    for (const button of await gemma.locator('.actions button:visible').all()) {
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  const download = gemma.getByRole('button', { name: 'Download / retry', exact: true });
  const remove = gemma.getByRole('button', { name: 'Delete cached assets', exact: true });
  await download.focus(); await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(remove).toBeFocused();
  await remove.press('Enter');
  await expect(remove).toBeEnabled();
  await remove.focus(); await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await expect(download).toBeFocused();
  await expect(gemma.locator('.model-status')).toHaveText('Not downloaded');
  await library.press('Enter');
  expect(await page.evaluate(() => window.openedPages)).toEqual([{ url: new URL('/extension/graph-library.html', page.url()).href }]);
});
