import { test, expect, openGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MEETING_SUMMARY_TYPES, meetingSummaryModel } from '../../web/meeting-summary-models.js';

test('both meeting processors: parked Save persists, independent settings, cancellation/retry, cache reuse and no inference', async ({ graphExtension: f }) => {
  for (const type of MEETING_SUMMARY_TYPES) {
    const model = meetingSummaryModel(type), body = Buffer.alloc(8192, 21);
    // Cache lifecycle fixture only; never used as a working inference model.
    const files = [{ path: 'weights.bin', bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: f.asset(model.key, body) }];
    await writeFile(path.join(f.root, 'extension', model.key + '-assets.json'), JSON.stringify(files));
  }
  const page = await openGraph(f), editor = page.editor;
  for (const type of MEETING_SUMMARY_TYPES) {
    await openPalette(editor); await editor.getByLabel('Node category', { exact: true }).selectOption({ label: 'Processors' });
    await editor.locator('#graph-node-type').selectOption(type); await editor.locator('#graph-add').click();
    await expect(editor.getByLabel(type.toLowerCase() + ' language', { exact: true })).toHaveValue('ja');
  }
  await editor.getByLabel('meetingsummaryqwen35 language', { exact: true }).selectOption('en');
  const cards = editor.locator('#graph-models .model-card');
  const save = async () => { await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled(); };
  f.mode('corrupt'); await save();
  await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) await expect(card).toHaveAttribute('data-state', 'Error');
  await editor.reload();
  expect(await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')).nodes.filter(n => n.type.startsWith('MeetingSummary')).map(n => n.settings.language))).toEqual(['ja', 'en']);
  f.mode('hold'); await save(); await expect(cards).toHaveCount(2);
  for (const card of await cards.all()) {
    await expect(card).toHaveAttribute('data-state', 'Downloading');
    await card.getByRole('button', { name: 'Cancel preparation', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Canceled');
  }
  f.mode('normal');
  for (const card of await cards.all()) {
    await card.getByRole('button', { name: 'Retry preparation', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready');
  }
  const count = f.requests.length; await save();
  for (const card of await cards.all()) await expect(card).toHaveAttribute('data-state', 'Ready');
  expect(f.requests.length).toBe(count);
  expect(await page.evaluate(() => window.graphWorkers.length)).toBe(0);
});
