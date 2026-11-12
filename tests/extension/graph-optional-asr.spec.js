import { settleAutoSave } from './ui-controls.js';
import { expectPreparedIdle } from './live-lifecycle.js';
import { test, expect, openGraph, startGraph } from './graph-fixture.js';
import { openPalette } from './ui-controls.js';

test('both optional ASRs are searchable independent Graph v11 Nodes; Save prepares parked weights, retry survives failure and reload retains exact paths', async ({ graphExtension: f }) => {
  const page = await openGraph(f), editor = page.editor;
  for (const [type, search, key] of [['SpeechToTextParakeetV3', 'Parakeet', 'parakeet-v3'], ['SpeechToTextMoonshineMediumEn', 'Moonshine', 'moonshine-medium-en']]) {
    const before = f.requests.length;
    await openPalette(editor);
    await editor.getByRole('combobox', { name: 'Search nodes' }).fill(search);
    await editor.locator(`#graph-node-type [data-type="${type}"]`).click();
    expect(f.requests).toHaveLength(before);
    f.mode('error'); await settleAutoSave(editor);
    const card = editor.locator('#graph-models .model-card').filter({ has: editor.getByRole('heading', { name: new RegExp(search) }) });
    await expect(card).toHaveAttribute('data-state', 'Error');
    f.mode('normal'); await card.getByRole('button', { name: 'Retry preparation' }).click();
    await expect(card).toHaveAttribute('data-state', 'Ready');
    expect(f.requests.some(url => url.includes(key))).toBe(true);
  }
  const nodes = await editor.evaluate(async () => (await import('./graph-library.js')).readLiveGraphData(localStorage));
  expect(nodes.version).toBe(15); expect(nodes.nodes.filter(n => n.type.includes('Parakeet') || n.type.includes('Moonshine'))).toHaveLength(2);
  await editor.reload();
  expect(await editor.evaluate(async () => (await import('./graph-library.js')).readLiveGraphData(localStorage))).toEqual(nodes);
  await expect(editor.getByRole('button', { name: 'speechtotextparakeetv3 output provisional', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'speechtotextparakeetv3 output final', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'speechtotextmoonshinemediumen output provisional', exact: true })).toBeVisible();
});

test('parallel production Nodes fan out finals, preserve repeats, clear failed preview, drain/release and Start fresh', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  await page.evaluate(async () => {
    const { graphNode, edge, assertGraph } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');

  });
  for (let repeat = 0; repeat < 2; repeat++) {
    await startGraph(page);
    expect(await page.evaluate(() => window.graphWorkers.filter(w => !w.released).length)).toBe(2);
    await page.evaluate(() => {
      const parakeet = window.graphWorkers.filter(w => !w.released).find(w => w.url.endsWith('parakeet-v3-worker.js'));
      const moonshine = window.graphWorkers.filter(w => !w.released).find(w => w.url.endsWith('moonshine-medium-worker.js'));
      moonshine.postMessage({ type: 'fixture-partial', id: 0, text: 'real interim in production; deterministic fixture here' });
      for (const id of [0, 0, 1]) parakeet.postMessage({ type: 'fixture-final', id, text: 'repeat' });
    });
    await expect(page.locator('[data-display="p"] .display-content')).toHaveText('repeat\nrepeat');
    await expect(page.locator('[data-display="formatted"] .display-content')).toHaveText('repeat\nrepeat');
    await expect(page.locator('[data-display="m"] .display-content')).not.toBeEmpty();
    await page.evaluate(() => window.graphWorkers.filter(w => !w.released).find(w => w.url.endsWith('moonshine-medium-worker.js')).postMessage({ type: 'fixture-error' }));
    await expect(page.locator('#errors')).toContainText('moonshine:');

    await expect(page.locator('#status')).toHaveText('Transcription active');
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    await expectPreparedIdle(page);
    await expect(page.locator('[data-display="p"] .display-content')).toHaveText('repeat\nrepeat');
  }
});
