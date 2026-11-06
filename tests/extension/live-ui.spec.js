import { test, expect, openGraph } from './graph-fixture.js';
import { installLiveUIGraph, checkLiveUI } from '../fixtures/live-ui.js';

test('MV3 Concept A reading layout and truthful lifecycle preserve graph actions and recovery', async ({ graphExtension: f }, info) => {
  const live = await openGraph(f), errors = [];
  live.on('pageerror', error => errors.push(error.message));
  await installLiveUIGraph(live);
  await checkLiveUI(live, expect, async (size, geometry) => {
    await live.screenshot({ path: info.outputPath(`live-${size}.png`), fullPage: true });
    if (geometry) await info.attach(`geometry-${size}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
    if (process.env.UPDATE_LIVE_UI_SCREENSHOTS) await live.screenshot({ path: `docs/evidence/live-223-mv3-${size}.png`, fullPage: true });
  });
  expect(errors).toEqual([]);
  for (const page of [live.editor, live.models]) {
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
    expect(await page.locator('link[href="live.css"]').count()).toBe(0);
  }
});
