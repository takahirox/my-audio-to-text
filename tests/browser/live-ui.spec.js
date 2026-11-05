import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { installLiveUIGraph, checkLiveUI } from '../fixtures/live-ui.js';

test('Concept A keeps real controls, graph actions and reading dominant at wide, Live and narrow sizes', async ({ page }, info) => {
  await page.context().route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css|json)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.json') ? 'application/json' : 'text/html' });
  });
  await page.addInitScript(() => {
    const event = { addListener() {} };
    window.chrome = { runtime: { onMessage: event, getURL: p => location.origin + '/' + p }, tabs: { onRemoved: event, onUpdated: event, create: ({ url }) => window.open(url) } };
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/extension/recorder.html');
  await installLiveUIGraph(page);
  const measurements = {};
  await checkLiveUI(page, expect, async (size, geometry) => {
    if (geometry) measurements[size] = geometry;
    await page.screenshot({ path: info.outputPath(`live-${size}.png`), fullPage: true });
    if (geometry) await info.attach(`geometry-${size}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
    if (process.env.UPDATE_LIVE_UI_SCREENSHOTS && info.project.name === 'chromium') await page.screenshot({ path: `docs/evidence/live-223-browser-${size}.png`, fullPage: true });
  });
  if (process.env.UPDATE_LIVE_UI_SCREENSHOTS && info.project.name === 'chromium') await writeFile('docs/evidence/live-223-geometry.json', JSON.stringify(measurements, null, 2) + '\n');
  expect(errors).toEqual([]);
  // Navigation remains operable and shared pages retain their original palette.
  for (const name of ['Graph', 'Models']) {
    const popup = page.waitForEvent('popup');
    await page.getByRole('link', { name, exact: true }).click();
    const target = await popup; await target.waitForLoadState('load');
    expect(await target.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    expect(await target.locator('link[href="live.css"]').count()).toBe(0);
    await target.close();
  }
});
