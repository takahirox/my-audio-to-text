import { test, expect } from '@playwright/test';
import { installLiveScrollFixture, checkLiveScrolling, checkLiveTextFlowScrolling } from '../fixtures/live-scroll.js';

test('shared DOM Live renderer follows only regions reading the bottom through replacement, tails and layout changes', async ({ page }) => {
  await page.goto('/');
  await installLiveScrollFixture(page);
  await checkLiveScrolling(page, expect);
});

for (const rootType of ['inline', 'text', 'fragment']) {
  test(`Live layout following observes ${rootType} snapshots and preserves a scrolled-up region`, async ({ page }) => {
    await page.goto('/');
    await installLiveScrollFixture(page);
    await checkLiveTextFlowScrolling(page, expect, rootType);
  });
}
