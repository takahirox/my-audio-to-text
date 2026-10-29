import { test, expect } from '@playwright/test';
import { installLiveScrollFixture, checkLiveScrolling } from '../fixtures/live-scroll.js';

test('shared DOM Live renderer follows only regions reading the bottom through replacement, tails and layout changes', async ({ page }) => {
  await page.goto('/');
  await installLiveScrollFixture(page);
  await checkLiveScrolling(page, expect);
});
