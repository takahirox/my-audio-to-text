import { readFile, mkdir } from 'node:fs/promises';
import { test, expect, library, create } from './library-fixture.js';
import { graphNode, edge, defaultGraph } from '../../extension/graph.js';

const simple = (text = 'Graph output') => {
  const source = graphNode('Text', 'source'); source.settings.value = text;
  return { version: 15, nodes: [source, graphNode('Display', 'display', 300, 20)], edges: [edge('source', 'value', 'display', 'input1')] };
};
async function assign(page, target, id) {
  await page.evaluate(async ({ target, id }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign(target, id, readLibrary(localStorage).revision);
  }, { target, id });
}
async function rename(page, name, description = '') {
  await page.locator('#graph-name').fill(name); await page.locator('#graph-description').fill(description);
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText(`Selected graph: ${name}`);
}

test('Library manages independent named graphs, portable JSON, persistent targets, safeguards and responsive preview', async ({ libraryExtension: f }) => {
  const { page } = f;
  await expect(page.locator('#web-target')).toHaveValue('');
  await expect(page.getByText(/Web page voice typing is not yet available/)).toBeVisible();
  await expect(page.locator('#graph-list')).toContainText('Unknown');
  await expect(page.locator('#delete')).toBeDisabled();
  await page.locator('#new').click(); await expect(page.locator('#selected-title')).toHaveText('Selected graph: Untitled graph'); await rename(page, 'Meeting Notes', 'Summarize meetings locally');
  const meeting = (await library(page)).graphs.at(-1);
  await page.locator('#duplicate').click(); await expect(page.locator('#selected-title')).toHaveText('Selected graph: Meeting Notes copy'); await rename(page, 'Voice Typing', 'Future graph assignment');
  const voice = (await library(page)).graphs.at(-1);
  expect(voice.id).not.toBe(meeting.id); expect(voice.graph).toEqual(meeting.graph);
  await page.locator('#web-target').selectOption(voice.id);
  await expect(page.locator('#delete')).toBeDisabled();
  await page.locator('#live-target').selectOption(meeting.id);
  expect((await library(page)).assignments).toEqual({ live: meeting.id, webVoice: voice.id });
  await page.reload(); await expect(page.locator('#selected-title')).toHaveText('Selected graph: Voice Typing');
  await expect(page.locator('#live-target')).toHaveValue(meeting.id);
  await page.locator('#search').fill('meet'); await expect(page.locator('#graph-list button')).toHaveText(['Meeting Notes']);
  await page.locator('#search').fill(''); await page.locator('#sort').selectOption('name');
  await expect(page.locator('#graph-list button')).toHaveText(['Live transcription', 'Meeting Notes', 'Voice Typing']);
  await page.locator('#filter').selectOption('assigned'); await expect(page.locator('#graph-list button')).toHaveCount(2);
  await page.locator('#filter').selectOption('all');
  const beforeImport = await library(page);
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.locator('#errors')).toContainText('Cannot import'); expect(await library(page)).toEqual(beforeImport);
  await page.locator('#import-file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await expect(page.locator('#errors')).toContainText('version'); expect(await library(page)).toEqual(beforeImport);
  const graph = simple('Imported output');
  await page.locator('#import-file').setInputFiles({ name: 'Imported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await expect(page.locator('#selected-title')).toHaveText('Selected graph: Imported');
  expect((await library(page)).graphs.at(-1).graph).toEqual(graph);
  await expect(page.locator('#preview rect')).toHaveCount(graph.nodes.length); await expect(page.locator('#preview line')).toHaveCount(graph.edges.length);
  await expect(page.locator('#graph-list')).toContainText('Ready · no model files');
  const downloading = page.waitForEvent('download'); await page.locator('#export').click();
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(graph);
  const count = (await library(page)).graphs.length;
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#delete').click(); expect((await library(page)).graphs).toHaveLength(count);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#delete').click(); await expect(page.locator('#graph-list button')).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Select Meeting Notes', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#selected-title')).toHaveText('Selected graph: Meeting Notes');
  await mkdir('docs/evidence', { recursive: true });
  await page.screenshot({ path: 'docs/evidence/library-243-1440.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#open')).toBeVisible();
  await page.screenshot({ path: 'docs/evidence/library-243-390.png', fullPage: true });
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('selected editor saves only its ID, protects drafts across tabs and warns before leaving', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('B'));
  await page.reload(); const original = (await library(page)).graphs.find(entry => entry.id === b);
  const editor = await context.newPage(); await editor.goto(url + `graph-editor.html?id=${a}`);
  await expect(editor.locator('#graph-name')).toHaveText('Graph A');
  await editor.getByRole('button', { name: 'Select source', exact: true }).press('ArrowRight');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-state')).toHaveText('Saved');
  expect((await library(page)).graphs.find(entry => entry.id === b)).toEqual(original);
  expect((await library(page)).assignments.live).toBe('default-live');
  const second = await context.newPage(); await second.goto(editor.url());
  await editor.getByRole('button', { name: 'Select source', exact: true }).press('ArrowRight');
  await second.getByRole('button', { name: 'Select source', exact: true }).press('ArrowDown');
  await second.locator('#graph-save').click(); await expect(second.locator('#graph-state')).toHaveText('Saved');
  await expect(editor.locator('.graph-state-notice')).toContainText('draft kept');
  const saved = await library(page);
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('Load saved');
  expect(await library(page)).toEqual(saved);
  // An unrelated graph save cannot clear the selected entry's conflict.
  await page.evaluate(async id => {
    const { GraphLibrary, readLibrary, entryGraph } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    const graph = entryGraph(entry); graph.nodes[0].settings.value = 'B edited';
    await new GraphLibrary(localStorage).save(id, entry.revision, graph);
  }, b);
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('Load saved');
  await editor.locator('.graph-actions > summary').click();
  editor.once('dialog', dialog => dialog.accept()); await editor.locator('#graph-load').click();
  await expect(editor.locator('#graph-state')).toHaveText('Saved');
  await editor.getByRole('button', { name: 'Select source', exact: true }).press('ArrowRight');
  let warned = false;
  editor.once('dialog', async dialog => { warned = dialog.type() === 'beforeunload'; await dialog.dismiss(); });
  await editor.goto(url + 'graph-library.html').catch(() => {}); expect(warned).toBe(true);
  await expect(editor.locator('#graph-name')).toHaveText('Graph A');
  await editor.close();
});

test('toolbar activity follows only the running graph ID across snapshot saves, reload and Stop', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  // Identical payloads still represent independent library entries.
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('A'));
  await assign(page, 'live', a);
  const editorA = await context.newPage(); await editorA.goto(url + `graph-editor.html?id=${a}`);
  const editorB = await context.newPage(); await editorB.goto(url + `graph-editor.html?id=${b}`);
  const badgeA = editorA.locator('.graph-toolbar .graph-activity'), badgeB = editorB.locator('.graph-toolbar .graph-activity');
  await expect(badgeA).toBeHidden(); await expect(badgeB).toBeHidden();
  const live = await context.newPage(); await live.goto(url + 'recorder.html');
  await expect(live.locator('#start')).toBeEnabled(); await live.locator('#start').click();
  await expect(live.locator('#session-state')).toHaveText('Running');
  await expect(badgeA).toBeVisible(); await expect(badgeB).toBeHidden();
  await expect(editorA.locator('.graph-state-notice')).toBeHidden();
  await expect(editorB.locator('.graph-state-notice')).toBeHidden();
  await editorA.reload(); // Initial runtime lookup also respects the current graph ID.
  await editorB.reload();
  await expect(badgeA).toBeVisible(); await expect(badgeB).toBeHidden();
  await editorA.getByRole('button', { name: 'Select source', exact: true }).press('ArrowRight');
  await expect(editorA.locator('#graph-state')).toHaveText('Unsaved');
  await expect(editorA.locator('.graph-state-notice')).toBeHidden();
  await editorA.locator('#graph-save').click();
  await expect(editorA.locator('#graph-state')).toHaveText('Saved');
  await expect(editorA.locator('.graph-state-notice')).toContainText('earlier graph; saved edits apply next session');
  await expect(badgeA).toBeVisible(); await expect(badgeB).toBeHidden();
  await expect(live.locator('#live-displays')).toContainText('A');
  await assign(page, 'live', b);
  await expect(badgeA).toBeVisible(); await expect(badgeB).toBeHidden();
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(badgeA).toBeHidden(); await expect(badgeB).toBeHidden();
  await expect(editorA.locator('.graph-state-notice')).toBeHidden();
  await live.locator('#start').click();
  await expect(live.locator('#session-state')).toHaveText('Running');
  await expect(badgeB).toBeVisible(); await expect(badgeA).toBeHidden();
  await live.locator('#stop').click();
  await expect(badgeB).toBeHidden();
});

test('migration preserves valid and malformed legacy sources; recovery never overwrites the original', async ({ libraryExtension: f }) => {
  const { page, url, context } = f;
  for (const raw of [JSON.stringify(defaultGraph(), null, 2), '{broken original']) {
    await page.evaluate(raw => {
      localStorage.removeItem('processing-graph-library-v1'); localStorage.setItem('processing-graph-v1', raw);
    }, raw);
    await page.reload();
    const migrated = await library(page); expect(migrated.graphs).toHaveLength(1); expect(migrated.assignments.live).toBe('legacy-graph');
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
    await page.reload(); expect(await library(page)).toEqual(migrated);
    if (raw.startsWith('{broken')) {
      await expect(page.locator('#graph-list')).toContainText('Error');
      const downloading = page.waitForEvent('download'); await page.locator('#export').click();
      expect(await readFile(await (await downloading).path(), 'utf8')).toBe(raw);
      const editor = await context.newPage(); await editor.goto(url + 'graph-editor.html?id=legacy-graph');
      await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('original has been kept');
      await page.locator('#new').click(); const recovery = (await library(page)).graphs.at(-1);
      await page.locator('#live-target').selectOption(recovery.id);
      expect((await library(page)).graphs.find(entry => entry.id === 'legacy-graph').source).toBe(raw);
      await editor.close();
    }
  }
});

test('Live assignment cancels stale preload, shows exact names and keeps active graph immutable until Stop', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const graph = simple('Model input'); graph.nodes.splice(1, 0, graphNode('TextSummaryLfm2', 'summary', 200, 20), graphNode('TextSummaryQwen35', 'parked', 200, 200));
  graph.edges = [edge('source', 'value', 'summary', 'text'), edge('summary', 'summary', 'display', 'input1')];
  const a = await create(page, 'Meeting Notes', graph), b = await create(page, 'Text only', simple('B output'));
  await assign(page, 'live', a); await page.reload();
  await page.getByRole('button', { name: 'Select Meeting Notes', exact: true }).click();
  await expect(page.locator('#graph-list')).toContainText('Unknown');
  await expect(page.locator('#graph-list')).toContainText('LFM2.5'); await expect(page.locator('#graph-list')).toContainText('Qwen3.5');
  await page.locator('#check-cache').click(); await expect(page.locator('#graph-list')).toContainText('Needs preparation');
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
  const live = await context.newPage(); await live.addInitScript(() => { window.holdModelLoads = true; });
  await live.goto(url + 'recorder.html');
  await expect(live.locator('#live-graph-name')).toHaveText('Meeting Notes'); await expect(live.locator('#start')).toBeDisabled();
  await expect.poll(() => live.evaluate(() => modelWorkers.length)).toBe(1); // Parked summary does not load.
  await assign(page, 'live', b);
  await expect(live.locator('#live-graph-name')).toHaveText('Text only'); await expect(live.locator('#start')).toBeEnabled();
  await expect.poll(() => live.evaluate(() => modelWorkers.every(worker => worker.released))).toBe(true);
  await live.evaluate(() => releaseModels());
  await assign(page, 'live', a); await expect(live.locator('#start')).toBeEnabled(); await expect(live.locator('#live-graph-name')).toHaveText('Meeting Notes');
  await live.locator('#start').click(); await expect(live.locator('#session-state')).toHaveText('Running');
  await expect(live.locator('#live-displays')).toContainText('Summary from selected graph');
  const workers = await live.evaluate(() => modelWorkers.length);
  await assign(page, 'live', b);
  await expect(live.locator('#saved-state')).toContainText('Next session: Text only');
  await expect(live.locator('#live-graph-name')).toHaveText('Meeting Notes'); expect(await live.evaluate(() => modelWorkers.length)).toBe(workers);
  await page.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).delete(id, readLibrary(localStorage).revision);
  }, a);
  await expect(live.locator('#live-graph-name')).toHaveText('Meeting Notes'); expect(await live.evaluate(() => modelWorkers.length)).toBe(workers);
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(live.locator('#live-graph-name')).toHaveText('Text only');
  await expect.poll(() => live.evaluate(() => modelWorkers.every(worker => worker.released))).toBe(true);
  await live.locator('#start').click(); await expect(live.locator('#live-displays')).toContainText('B output');
  await live.locator('#stop').click();
});

test('Library preserves conflicting metadata and explicitly recovers legacy edits from other pages', async ({ libraryExtension: f }) => {
  const { page, context, url } = f, original = await library(page), id = original.assignments.live;
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await page.locator('#graph-name').fill('My unsaved name');
  await other.locator('#graph-name').fill('Saved elsewhere'); await other.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#errors')).toContainText('Unsaved details have been kept');
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#errors')).toContainText('Load saved'); await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  expect((await library(page)).graphs[0].name).toBe('Saved elsewhere');
  page.once('dialog', dialog => dialog.accept()); await page.locator('#load-details').click();
  await expect(page.locator('#graph-name')).toHaveValue('Saved elsewhere');
  const raw = JSON.stringify(simple('Legacy edit from old tab'));
  await other.evaluate(raw => localStorage.setItem('processing-graph-v1', raw), raw);
  await expect(page.locator('#recovery')).toBeVisible(); await page.locator('#recover-legacy').click();
  await expect(page.locator('#graph-list button')).toHaveCount(2);
  const recovered = await library(page);
  expect(recovered.assignments.live).toBe(id); expect(recovered.graphs.at(-1).source).toBe(raw);
  expect(recovered.graphs[0].graph).toEqual(original.graphs[0].graph);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await page.locator('#graph-name').fill('Unsaved details before deletion');
  await other.evaluate(async ({ oldId, nextId }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const store = new GraphLibrary(localStorage);
    const next = await store.assign('live', nextId, readLibrary(localStorage).revision);
    await store.delete(oldId, next.revision);
  }, { oldId: id, nextId: recovered.graphs.at(-1).id });
  await expect(page.locator('#selected-error')).toContainText('deleted in another page');
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved details before deletion');
  await expect(page.locator('#open')).toBeHidden(); await expect(page.locator('#delete')).toBeDisabled();
  const downloading = page.waitForEvent('download'); await page.locator('#export').click();
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(original.graphs[0].graph);
});

test('concurrent migration, quota errors and corrupt envelopes keep originals recoverable in the browser', async ({ libraryExtension: f }) => {
  const { page, context, url } = f, graph = simple('Original migration'), raw = JSON.stringify(graph, null, 2);
  await page.evaluate(raw => { localStorage.removeItem('processing-graph-library-v1'); localStorage.setItem('processing-graph-v1', raw); }, raw);
  const pages = await Promise.all(Array.from({ length: 3 }, () => context.newPage()));
  await Promise.all(pages.map(p => p.goto(url + 'graph-library.html')));
  for (const p of pages) await expect(p.locator('#graph-list button')).toHaveCount(1);
  expect((await library(page)).graphs[0].graph).toEqual(graph);
  const before = await library(page);
  await pages[0].evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'processing-graph-library-v1') throw Error('Fixture quota exceeded'); return set.call(this, key, value); };
  });
  await pages[0].locator('#new').click(); await expect(pages[0].locator('#errors')).toContainText('quota exceeded');
  expect(await library(page)).toEqual(before);
  const corrupt = '{broken library envelope';
  await page.evaluate(raw => localStorage.setItem('processing-graph-library-v1', raw), corrupt);
  await page.reload(); await expect(page.locator('#recovery')).toBeVisible(); await expect(page.locator('#new')).toBeDisabled();
  const downloading = page.waitForEvent('download'); await page.locator('#export-storage').click();
  expect(await readFile(await (await downloading).path(), 'utf8')).toBe(corrupt);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
});
