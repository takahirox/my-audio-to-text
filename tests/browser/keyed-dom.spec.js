import { test, expect } from '@playwright/test';
import { installKeyedDOMBrowser, installIndependentIDBrowser } from '../fixtures/keyed-dom-browser.js';

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

for (const first of ['id', 'payload']) test(`independent Number ID and TEXT/DOM producers, ${first}-first`, async ({ page }) => {
  await page.route('**/independent-id-fixture-worker.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    self.onmessage=({data})=>{
      if(data.type==='load')postMessage({type:'ready',id:data.id});
      if(data.type==='translate')setTimeout(()=>postMessage({type:'result',id:data.id,texts:['translated:'+data.text]}),100);
      if(data.type==='drain')postMessage({type:'drained',id:data.id});
    };` }));
  await page.goto('/'); await page.evaluate(installIndependentIDBrowser);
  const cells = page.locator('#independent-live td');
  if (first === 'id') await page.evaluate(() => independentID(-1.5));
  await page.evaluate(() => independentText('first'));
  if (first === 'payload') {
    await expect(cells).toHaveCount(0);
    await page.evaluate(() => independentID(-1.5));
  }
  await expect(cells).toHaveText(['first', '']);
  await expect.poll(() => page.evaluate(() => independentResults.length)).toBe(1);
  expect(await page.evaluate(() => independentResults[0])).toEqual({ ...(first === 'id' ? { id: -1.5 } : {}), source: 'first', text: 'translated:first', error: '' });
  await page.evaluate(() => { independentID(-1.5); independentID(2.25); });
  await expect(cells).toHaveText(['first', '']);
  await page.evaluate(() => independentText('next')); await expect(cells).toHaveText(['first', '', 'next', '']);
  await expect.poll(() => page.evaluate(() => independentResults.length)).toBe(2);
  expect(await page.evaluate(() => independentResults[1].id)).toBe(2.25);
  await page.evaluate(() => independentText('')); await expect(cells).toHaveText(['first', '', '', '']);
  expect(await page.evaluate(() => independentKeys())).toEqual([-1.5, 2.25]);
  await page.evaluate(async () => { await independentPipeline.stop(); await independentPipeline.dispose(); });
  expect(await page.evaluate(() => independentPipeline.errors.map(error => error.message))).toEqual([]);
});
