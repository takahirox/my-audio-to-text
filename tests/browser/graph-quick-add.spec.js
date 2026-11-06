import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkQuickAddInteraction, checkQuickAddPlacement, checkQuickAddTouch, openQuickAdd } from '../fixtures/graph-quick-add.js';

async function serveExtension(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
  await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
}
test.beforeEach(async ({ page }) => {
  await page.route('**/*', serveExtension); await page.goto('/extension/graph-editor.html');
});
test('search, categories, mouse/keyboard add, dismissal, focus and explicit Save', async ({ page }) => {
  await checkQuickAddInteraction(page);
});
for (const width of [390, 1440]) for (const zoom of ['0.25', '0.5', '1', '1.5', 'fit']) {
  test(`add in viewed region without moving zoom/pan at ${width}px / ${zoom}`, async ({ page }) => {
    await checkQuickAddPlacement(page, width, zoom);
  });
}
test('canvas translation and ancestor scaling are included in placement', async ({ page }) => {
  await checkQuickAddPlacement(page, 1440, '0.5', true);
});
test('menu flips above a low anchor, adjusts after resize and follows page scrolling', async ({ page }) => {
  await page.locator('.graph-toolbar').evaluate(toolbar => { toolbar.style.marginTop = '580px'; });
  await page.locator('#graph-palette-toggle').scrollIntoViewIfNeeded();
  await openQuickAdd(page);
  const menu = await page.locator('#graph-palette').boundingBox(), anchor = await page.locator('#graph-palette-toggle').boundingBox();
  expect(menu.y + menu.height).toBeLessThan(anchor.y);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.keyboard.press('Escape'); await openQuickAdd(page);
  await page.evaluate(() => scrollBy(0, 40));
  const moved = await page.locator('#graph-palette').boundingBox(), movedAnchor = await page.locator('#graph-palette-toggle').boundingBox();
  expect(Math.min(Math.abs(moved.y - movedAnchor.y - movedAnchor.height), Math.abs(moved.y + moved.height - movedAnchor.y))).toBeLessThanOrEqual(7);
});
test('touch selects a result once and outside tap dismisses', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage(); await page.route('**/*', serveExtension); await page.goto('/extension/graph-editor.html');
    await checkQuickAddTouch(page);
  } finally { await context.close(); }
});

test('tall cards keep their heading reachable when the view cannot fit the card', async ({ page }) => {
  await checkQuickAddPlacement(page, 390, '1.5', false, 'KeyedTextCoalesce');
});
for (const width of [1440, 390]) test(`anchored menu geometry and appearance at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await openQuickAdd(page);
  await page.screenshot({ path: info.outputPath(`quick-add-${width}.png`) });
  if (process.env.UPDATE_QUICK_ADD_SCREENSHOTS) {
    await mkdir('docs/evidence', { recursive: true });
    await page.screenshot({ path: `docs/evidence/graph-231-${width}.png` });
  }
});
