import { test, expect } from '@playwright/test';
import { installKeyedDOMBrowser } from '../fixtures/keyed-dom-browser.js';

for (const fast of [false, true]) test(`continuous keyed ASR rows with ${fast ? 'immediate' : 'held'} translation`, async ({ page }) => {
  await page.goto('/'); await page.evaluate(installKeyedDOMBrowser); await page.evaluate(value => window.keyedFast = value, fast);
  const rows = page.locator('#keyed-live tr'), cells = page.locator('#keyed-live td');
  await page.evaluate(() => keyedSend('partial', 0, 'draft')); await expect(cells).toHaveText(['draft', '']);
  await page.evaluate(() => keyedSend('final', 0, 'same')); await expect(cells).toHaveText(['same', fast ? 'translated:same' : '']);
  await page.evaluate(() => keyedSend('partial', 1, 'next')); await expect(rows).toHaveCount(2);
  if (!fast) { await page.evaluate(() => keyedComplete()); await expect(cells).toHaveText(['same', 'translated:same', 'next', '']); }
  await page.evaluate(() => { keyedSend('final', 1, 'same'); keyedSend('final', 2, 'fail'); });
  await expect(rows).toHaveCount(3);
  if (!fast) { await page.evaluate(() => keyedComplete()); await expect(cells).toHaveText(['same', 'translated:same', 'same', 'translated:same', 'fail', '']); await page.evaluate(() => keyedComplete()); }
  await expect(cells).toHaveText(['same', 'translated:same', 'same', 'translated:same', 'fail', '']);
  await page.evaluate(async () => { await keyedPipeline.stop(); keyedSend('final', 3, 'late'); });
  await expect(rows).toHaveCount(3);
  expect(await page.evaluate(() => keyedSnapshots.slice(keyedSnapshots.findIndex(snapshot => snapshot.length)).every(snapshot => snapshot.length > 0 && snapshot[0][0] !== ''))).toBe(true);
  expect(await page.evaluate(() => keyedPipeline.errors.map(e => e.message))).toEqual([]);
  await page.evaluate(() => keyedPipeline.dispose());
});
