import { expect } from '@playwright/test';

// Model loading belongs to Live opening/recovery. Explicit Start must reuse
// exactly these Workers; Stop/Cancel releases them and prepares an idle owner.
export async function startReadyLive(page, { workers = 'graphWorkers', timeout = 30000 } = {}) {
  await expect(page.locator('#model-status')).toHaveText(/Ready|Models unavailable|Preparation canceled/, { timeout });
  // Save publishes the graph before asset preparation finishes. A failed
  // preflight needs the same explicit recovery action as the production UI.
  if (await page.locator('#retry-models').isVisible()) await page.locator('#retry-models').click();
  await expect(page.locator('#model-status')).toHaveText('Ready', { timeout });
  await expect(page.locator('#start')).toBeEnabled({ timeout });
  await page.evaluate(workers => {
    window.lastSessionWorkers = window[workers].filter(worker => !worker.released);
    window.workerCountBeforeStart = window[workers].length;
  }, workers);
  await page.locator('#start').click();
  expect(await page.evaluate(workers => window[workers].length, workers)).toBe(await page.evaluate(() => window.workerCountBeforeStart));
}

export async function expectPreparedIdle(page, { workers = 'graphWorkers', timeout = 30000 } = {}) {
  await expect(page.locator('#model-status')).toHaveText('Ready', { timeout });
  await expect(page.locator('#start')).toBeEnabled({ timeout });
  expect(await page.evaluate(() => window.lastSessionWorkers.every(worker => worker.released))).toBe(true);
  expect(await page.evaluate(workers => window[workers].filter(worker => !worker.released).length, workers))
    .toBe(await page.evaluate(() => window.lastSessionWorkers.length));
}
