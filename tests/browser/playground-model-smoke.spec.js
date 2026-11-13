import { test, expect } from '@playwright/test';
import { asrPages, textPages, streamPages, wavFixture } from './model-playground-fixture.js';

// Explicit opt-in only: no mocks, remote inference, or default CI downloads.
// Select named pages to control disk/RAM/download costs on the test machine.
const enabled = process.env.PLAYGROUND_MODEL_SMOKE === '1';
const selected = (process.env.PLAYGROUND_MODELS || '').split(',').filter(Boolean);
const pages = [...asrPages, ...textPages, ...streamPages];
test.beforeAll(() => {
  if (enabled && (!selected.length || selected.some(slug => !pages.includes(slug)))) {
    throw Error(`Set PLAYGROUND_MODELS to a comma-separated subset of: ${pages.join(',')}`);
  }
});
for (const slug of pages) test(`${slug}: real standalone model readiness and local run`, async ({ page }) => {
  test.skip(!enabled || !selected.includes(slug), 'Opt-in selected real-model check; downloads weights and requires matching hardware.');
  test.setTimeout(30 * 60 * 1000);
  await page.goto(`./nodes/${slug}/`); await expect(page.locator('#run')).toBeEnabled();
  if (asrPages.includes(slug)) await page.locator('#file').setInputFiles(process.env.PLAYGROUND_AUDIO_FILE || wavFixture(1));
  if (textPages.includes(slug) && slug !== 'if-condition') await page.locator('#language').selectOption('en');
  await page.locator('#run').click();
  await expect(page.locator('#status')).toHaveText(/^(Complete|Error|Browser setup failed)$/, { timeout: 29 * 60 * 1000 });
  await expect(page.locator('#errors')).toBeEmpty();
  await expect(page.locator('#status')).toHaveText('Complete');
  await expect(page.locator('#load-time')).toContainText('ms'); await expect(page.locator('#latency')).toContainText('ms');
  if (textPages.includes(slug)) await expect(page.locator('#output')).not.toBeEmpty();
  if (streamPages.includes(slug)) {
    await expect(page.locator('#waveform')).toContainText('PCM chunks');
    await expect(page.locator('#download')).toBeVisible();
  }
});
