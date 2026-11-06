import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test('Models wraps real manifests, licenses, expanded file paths and controls at narrow and wide widths', async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css|json)$/.test(pathname)) return route.continue();
    const types = { js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json' };
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: types[pathname.split('.').at(-1)] });
  });
  await page.addInitScript(() => {
    window.chrome = { runtime: { getURL: p => location.origin + '/' + p, getContexts: async () => [] } };
  });
  await page.goto('/extension/model-cache.html');
  await expect(page.locator('.model-card')).toHaveCount(12);
  await expect(page.locator('.model-card[data-state="Not downloaded"]')).toHaveCount(12);
  const gemma = page.locator('#translategemma');
  await expect(gemma).toContainText('3.112 GB download shared by both directions');
  await expect(gemma).toContainText('Google / ONNX Community · Gemma Terms');
  await gemma.getByText('Verified files and size', { exact: true }).click();
  const spec = JSON.parse(await readFile('extension/translategemma-assets.json'));
  await expect(gemma.locator('li')).toHaveCount(spec.length);
  for (const width of [390, 800, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await gemma.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const button of await gemma.locator('.actions button:visible').all()) {
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
  const check = gemma.getByRole('button', { name: 'Check cache' });
  await check.focus(); await check.press('Enter');
  await expect(check).toBeFocused();
  await expect(gemma.locator('.model-status')).toHaveText('Not downloaded');
  await page.locator('nav [data-live]').click();
  await expect(page.locator('#navigation-status')).toHaveText('Open Live with the toolbar action on the tab you want to transcribe.');
});
