import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { checkQuickAddInteraction, checkQuickAddPlacement, checkQuickAddTouch, checkQuickAddRows, openQuickAdd, seedQuickAdd } from '../fixtures/graph-quick-add.js';

async function serveExtension(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
  await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
}
test.beforeEach(async ({ page }) => {
  await page.route('**/*', serveExtension); await page.goto('/extension/graph-editor.html');
});
test('five sorted categories combine search/filter and refresh dynamic Japanese/Latin subgraphs', async ({ page, context }) => {
  await seedQuickAdd(page);
  const storedGraph = await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
    return library.graphs.find(entry => entry.id === library.assignments.live).graph;
  });
  await openQuickAdd(page);
  const category = page.getByLabel('Node category', { exact: true });
  await expect(category.locator('option')).toHaveText([
    'All categories', 'Sources / inputs', 'AI Models', 'Processors', 'Outputs', 'Subgraphs',
  ]);
  await expect(page.getByRole('group', { name: 'Sources / inputs', exact: true }).getByRole('option')).toHaveText([
    'Button', 'Chrome tab audio', 'Microphone audio', 'Number', 'Text',
  ]);
  await expect(page.getByRole('group', { name: 'AI Models', exact: true }).getByRole('option')).toHaveCount(16);
  await expect(page.getByRole('group', { name: 'Processors', exact: true }).getByRole('option')).toHaveText([
    'Hold', 'Keyed paired text accumulator', 'Keyed text coalesce', 'Keyed text pair',
    'Text accumulator', 'Text formatter', 'Text sliding window', 'Text window',
  ]);
  await expect(page.getByRole('group', { name: 'Outputs', exact: true }).getByRole('option')).toHaveText([
    'Audio player / WAV', 'Display', 'Focused input text output', 'Speaker', 'Speaker · streaming',
  ]);

  // Write real library definitions in another tab while the picker stays open.
  const libraryPage = await context.newPage();
  await libraryPage.route('**/*', serveExtension);
  await libraryPage.goto('/extension/graph-editor.html');
  await libraryPage.evaluate(async () => {
    const { GraphLibrary } = await import('/extension/graph-library.js');
    const store = new GraphLibrary(localStorage);
    const names = ['さくら', 'Model 10', 'いちご', 'beta', 'アオイ', 'Model 2', 'あかね', 'Alpha'];
    for (const [index, name] of names.entries()) await store.create({
      id: `palette-${index}`, name, kind: 'subgraph',
      graph: { version: 15, nodes: [], edges: [], interface: { inputs: [], outputs: [] } },
    });
  });
  const subgraphs = page.getByRole('group', { name: 'Subgraphs', exact: true }).getByRole('option');
  const sortedNames = ['Alpha', 'beta', 'Model 2', 'Model 10', 'アオイ', 'あかね', 'いちご', 'さくら'];
  await expect(subgraphs).toHaveText(sortedNames);
  await expect(page.locator('.graph-node-group > .muted')).toHaveText([
    'Sources / inputs', 'AI Models', 'Processors', 'Outputs', 'Subgraphs',
  ]);
  // Check every built-in group too, using displayed text independently of IDs.
  expect(await page.locator('.graph-node-group').evaluateAll(groups => {
    const collator = new Intl.Collator('ja-JP', { usage: 'sort', sensitivity: 'base', numeric: true });
    return groups.every(group => {
      const labels = [...group.querySelectorAll('[role="option"]')].map(option => option.textContent);
      return labels.every((label, i) => !i || collator.compare(labels[i - 1], label) <= 0);
    });
  })).toBe(true);
  await expect(page.locator('#graph-palette')).not.toContainText('Constants / utilities');
  await expect(page.locator('.graph-palette-status')).toBeEmpty();

  const search = page.getByRole('combobox', { name: 'Search nodes' });
  await category.selectOption('Processors'); await search.fill(' text ');
  await expect(page.locator('.graph-node-group > .muted')).toHaveText(['Processors']);
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'Keyed paired text accumulator', 'Keyed text coalesce', 'Keyed text pair',
    'Text accumulator', 'Text formatter', 'Text sliding window', 'Text window',
  ]);
  await category.selectOption('AI Models'); await search.fill('summary');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveText([
    'Text Summary · LFM2.5 1.2B JP', 'Text Summary · Qwen3.5 2B',
  ]);
  await category.selectOption('Outputs'); await search.fill('Number');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(0);
  await expect(page.locator('.graph-palette-status')).toHaveText('No matching nodes');
  await category.selectOption('Subgraphs'); await search.fill('あか');
  await expect(subgraphs).toHaveText(['あかね']);
  await search.fill('');
  await expect(subgraphs).toHaveText(sortedNames);

  await libraryPage.evaluate(async () => {
    const { GraphLibrary, readLibrary } = await import('/extension/graph-library.js');
    const store = new GraphLibrary(localStorage);
    await store.create({ id: 'last-added', name: 'Model 3', kind: 'subgraph',
      graph: { version: 15, nodes: [], edges: [], interface: { inputs: [], outputs: [] } } });
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === 'palette-0');
    await store.rename(entry.id, 'あおい', '', entry.revision);
  });
  await expect(subgraphs).toHaveText(['Alpha', 'beta', 'Model 2', 'Model 3', 'Model 10', 'あおい', 'アオイ', 'あかね', 'いちご']);
  expect(await page.evaluate(() => {
    const library = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
    return library.graphs.find(entry => entry.id === library.assignments.live).graph;
  })).toEqual(storedGraph);
  await libraryPage.close();
});
for (const width of [1440, 390]) test(`selection, search, categories, dismissal, focus and explicit Save at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await checkQuickAddInteraction(page);
});
for (const width of [1440, 320]) test(`compact centered rows and fully clickable wrapped labels at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await checkQuickAddRows(page);
});
for (const width of [390, 1440]) for (const zoom of ['0.25', '0.5', '1', '1.5', 'fit']) {
  test(`add in viewed region without moving zoom/pan at ${width}px / ${zoom}`, async ({ page }) => {
    await checkQuickAddPlacement(page, width, zoom);
  });
}
test('canvas translation and ancestor scaling are included in placement', async ({ page }) => {
  await checkQuickAddPlacement(page, 1440, '0.5', true);
});
test('menu flips above a low anchor, adjusts after resize and follows page scrolling', async ({ page }) => {
  await page.locator('.graph-toolbar').evaluate(toolbar => { toolbar.style.marginTop = '580px'; });
  await page.locator('#graph-palette-toggle').scrollIntoViewIfNeeded();
  await openQuickAdd(page);
  const menu = await page.locator('#graph-palette').boundingBox(), anchor = await page.locator('#graph-palette-toggle').boundingBox();
  expect(menu.y + menu.height).toBeLessThan(anchor.y);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.keyboard.press('Escape'); await openQuickAdd(page);
  await page.evaluate(() => scrollBy(0, 40));
  const moved = await page.locator('#graph-palette').boundingBox(), movedAnchor = await page.locator('#graph-palette-toggle').boundingBox();
  expect(Math.min(Math.abs(moved.y - movedAnchor.y - movedAnchor.height), Math.abs(moved.y + moved.height - movedAnchor.y))).toBeLessThanOrEqual(7);
});
test('touch selects a result once and outside tap dismisses', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage(); await page.route('**/*', serveExtension); await page.goto('/extension/graph-editor.html');
    await checkQuickAddTouch(page);
  } finally { await context.close(); }
});

test('tall cards keep their heading reachable when the view cannot fit the card', async ({ page }) => {
  await checkQuickAddPlacement(page, 390, '1.5', false, 'KeyedTextCoalesce');
});
for (const width of [1440, 390]) test(`anchored menu geometry and appearance at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await openQuickAdd(page);
  await page.screenshot({ path: info.outputPath(`quick-add-${width}.png`) });
  if (process.env.UPDATE_QUICK_ADD_SCREENSHOTS) {
    await mkdir('docs/evidence', { recursive: true });
    await page.screenshot({ path: `docs/evidence/graph-231-${width}.png` });
  }
});
