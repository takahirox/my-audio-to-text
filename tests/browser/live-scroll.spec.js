import { test, expect } from '@playwright/test';
import { installLiveScrollFixture, checkLiveScrolling, checkLiveTextFlowScrolling } from '../fixtures/live-scroll.js';
import { livePreviewText, checkLivePreviewLayout, checkLivePreviewCopy } from '../fixtures/live-preview-layout.js';

test('combined bilingual history keeps the literal provisional tail in the original column at wide and narrow widths', async ({ page }, testInfo) => {
  await page.goto('/'); await installLiveScrollFixture(page);
  await page.evaluate(text => {
    scrollFixture.clear('a');
    scrollFixture.pair('a', 'The morning train arrives at platform three.', '朝の電車は3番ホームに到着します。\n'.repeat(3));
    scrollFixture.pair('a', 'Please keep the doors clear.', 'ドアの付近を空けてください。');
    scrollFixture.preview('a', text);
  }, livePreviewText);
  const content = page.locator('#scroll-fixture [data-display="a"] .display-content');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await checkLivePreviewLayout(page, content, expect);
    await testInfo.attach(`geometry-${width}`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
    if (process.env.UPDATE_LIVE_SCREENSHOT && testInfo.project.name === 'chromium') await content.locator('..').screenshot({ path: `docs/evidence/live-150-after-${width}.png` });
  }
  await checkLivePreviewCopy(page, content, expect);
  await content.focus();
  for (const text of ['new speech', 'short', '']) {
    await page.evaluate(text => scrollFixture.preview('a', text), text);
    await expect(content).toBeFocused();
    expect(await content.locator('.paired-text-tail').textContent()).toBe(text);
    await expect(content.locator('tr')).toHaveCount(2);
  }
  await expect(content.locator('.paired-text-tail')).toBeHidden();
  expect(await content.locator('.paired-text-tail').evaluate(el => el.getBoundingClientRect().height)).toBe(0);
});

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
