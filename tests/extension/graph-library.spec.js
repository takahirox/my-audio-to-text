import { readFile } from 'node:fs/promises';
import { test, expect, library, create } from './library-fixture.js';
import { graphNode, edge, defaultGraph } from '../../extension/graph.js';

const simple = (text = 'Graph output') => {
  const source = graphNode('Text', 'source'); source.settings.value = text;
  return { version: 15, nodes: [source, graphNode('Display', 'display', 300, 20)], edges: [edge('source', 'value', 'display', 'input1')] };
};
const microphoneGraph = () => ({ version: 15,
  nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
  edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] });
async function tools(page) {
  if (!await page.locator('#library-tools').evaluate(node => node.open)) await page.locator('#library-tools > summary').click();
}
async function assign(page, target, id) {
  await page.evaluate(async ({ target, id }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign(target, id, readLibrary(localStorage).revision);
  }, { target, id });
}
async function moreAction(page, id) {
  if (!await page.locator('#graph-more').evaluate(node => node.open)) await page.locator('#graph-more > summary').click();
  await page.locator(`#${id}`).click();
}
async function rename(page, name, description = '') {
  await page.locator('#graph-name').fill(name); await page.locator('#graph-description').fill(description);
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText(`${name}`);
}

test('Library manages independent named graphs, portable JSON, persistent targets, safeguards and responsive preview', async ({ libraryExtension: f }) => {
  const { page } = f;
  await expect(page.locator('#launch-settings, #live-graph, #web-graph, #filter option[value=assigned]')).toHaveCount(0);
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(page.locator('#web-voice-status')).toContainText('No compatible graphs');
  await expect(page.locator('#graph-cache')).toHaveText('Unknown');
  await expect(page.locator('#delete')).toBeDisabled();
  await page.locator('#new').click(); await expect(page.locator('#selected-title')).toHaveText('Untitled graph'); await rename(page, 'Meeting Notes', 'Summarize meetings locally');
  const meeting = (await library(page)).graphs.at(-1);
  await page.locator('#duplicate').click(); await expect(page.locator('#selected-title')).toHaveText('Meeting Notes copy'); await rename(page, 'Voice Typing', 'Microphone dictation');
  const voice = (await library(page)).graphs.at(-1);
  expect(voice.id).not.toBe(meeting.id); expect(voice.graph).toEqual(meeting.graph);
  await page.evaluate(async ({ id, revision, graph }) => {
    const { GraphLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).save(id, revision, graph);
  }, { id: voice.id, revision: voice.revision, graph: { version: 15,
    nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
    edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] } });
  await page.reload();
  await assign(page, 'webVoice', voice.id);
  await expect(page.locator('#delete')).toBeEnabled();
  await page.getByRole('button', { name: 'Open details for Meeting Notes', exact: true }).click();
  await assign(page, 'live', meeting.id);
  await page.getByRole('button', { name: 'Open details for Voice Typing', exact: true }).click();
  expect((await library(page)).assignments).toEqual({ live: meeting.id, webVoice: voice.id });
  await page.reload(); await expect(page.locator('#selected-title')).toHaveText('Voice Typing');
  await expect(page.getByRole('button', { name: 'Open details for Meeting Notes', exact: true })).toContainText('Meeting Notes');
  await page.locator('#search').fill('meet'); await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Meeting Notes']);
  await page.locator('#search').fill(''); await tools(page); await page.locator('#sort').selectOption('name');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Meeting Notes', 'Voice Typing']);
  await tools(page); await page.locator('#filter').selectOption('all');
  const beforeImport = await library(page);
  await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.locator('#errors')).toContainText('Cannot import'); expect(await library(page)).toEqual(beforeImport);
  await page.locator('#import-file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await expect(page.locator('#errors')).toContainText('version'); expect(await library(page)).toEqual(beforeImport);
  const graph = simple('Imported output');
  await page.locator('#import-file').setInputFiles({ name: 'Imported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await expect(page.locator('#selected-title')).toHaveText('Imported');
  expect((await library(page)).graphs.at(-1).graph).toEqual(graph);
  await expect(page.locator('#preview rect')).toHaveCount(graph.nodes.length); await expect(page.locator('#preview line')).toHaveCount(graph.edges.length);
  await expect(page.locator('#graph-cache')).toHaveText('Ready · no model files');
  const downloading = page.waitForEvent('download'); await moreAction(page, 'export');
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(graph);
  const count = (await library(page)).graphs.length;
  page.once('dialog', dialog => dialog.dismiss()); await moreAction(page, 'delete'); expect((await library(page)).graphs).toHaveLength(count);
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'delete'); await expect(page.locator('#graph-list button[data-id]')).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Open details for Meeting Notes', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#selected-title')).toHaveText('Meeting Notes');
  await page.locator('#library-tools > summary').click();
  await page.screenshot({ path: test.info().outputPath('library-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#open')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('library-narrow.png'), fullPage: true });
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
  await expect(badgeA).toBeVisible(); await expect(badgeB).toBeHidden();
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
      await expect(page.locator('#selected-error')).toContainText('Invalid saved graph');
      const downloading = page.waitForEvent('download'); await moreAction(page, 'export');
      expect(await readFile(await (await downloading).path(), 'utf8')).toBe(raw);
      const editor = await context.newPage(); await editor.goto(url + 'graph-editor.html?id=legacy-graph');
      await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('original has been kept');
      await page.locator('#new').click();
      await expect(page.locator('#selected-title')).toHaveText('Untitled graph');
      await assign(page, 'live', (await library(page)).graphs.at(-1).id);
      expect((await library(page)).graphs.find(entry => entry.id === 'legacy-graph').source).toBe(raw);
      await editor.close();
    }
  }
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
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'load-details');
  await expect(page.locator('#graph-name')).toHaveValue('Saved elsewhere');
  const raw = JSON.stringify(simple('Legacy edit from old tab'));
  await other.evaluate(raw => localStorage.setItem('processing-graph-v1', raw), raw);
  await expect(page.locator('#recovery')).toBeVisible(); await page.locator('#recover-legacy').click();
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(2);
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
  page.once('dialog', dialog => dialog.accept()); await page.reload();
  await expect(page.locator('#selected-error')).toContainText('deleted in another page');
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved details before deletion');
  await expect(page.locator('#save-details')).toBeDisabled();
  const downloading = page.waitForEvent('download'); await moreAction(page, 'export');
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(original.graphs[0].graph);
});

test('concurrent migration, quota errors and corrupt envelopes keep originals recoverable in the browser', async ({ libraryExtension: f }) => {
  const { page, context, url } = f, graph = simple('Original migration'), raw = JSON.stringify(graph, null, 2);
  await page.evaluate(raw => { localStorage.removeItem('processing-graph-library-v1'); localStorage.setItem('processing-graph-v1', raw); }, raw);
  const pages = await Promise.all(Array.from({ length: 3 }, () => context.newPage()));
  await Promise.all(pages.map(p => p.goto(url + 'graph-library.html')));
  for (const p of pages) await expect(p.locator('#graph-list button[data-id]')).toHaveCount(1);
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

test('metadata drafts survive filtering, canceled selection, async refresh and reload with original revision conflicts', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const id = await create(page, 'Draft graph', simple('A')); await create(page, 'Other graph', simple('B'));
  await page.reload();
  await page.getByRole('button', { name: 'Open details for Draft graph', exact: true }).click();
  await page.locator('#graph-name').fill('My unsaved name');
  await page.locator('#graph-description').fill('My unsaved description');
  await expect(page.locator('#details-state')).toContainText('Unsaved changes');
  await page.locator('#search').fill('Other');
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(1);
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'Open details for Other graph', exact: true }).click();
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  await tools(page); await page.locator('#filter').selectOption('invalid');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#graph-description')).toHaveValue('My unsaved description');
  await page.evaluate(() => { const channel = new BroadcastChannel('model-cache-updates'); channel.postMessage({}); channel.close(); });
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await other.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).rename(id, 'Saved elsewhere', 'Remote details', entry.revision);
  }, id);
  await expect(page.locator('#errors')).toContainText('Unsaved details have been kept');
  page.once('dialog', dialog => dialog.accept()); await page.reload();
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  await expect(page.locator('#graph-description')).toHaveValue('My unsaved description');
  await expect(page.locator('#selected-title')).toBeFocused();
  await expect(page.locator(`#graph-list button[data-id="${id}"]`)).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#save-details').click();
  await expect(page.locator('#errors')).toContainText('Load saved');
  expect((await library(page)).graphs.find(entry => entry.id === id).name).toBe('Saved elsewhere');
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'load-details');
  await expect(page.locator('#graph-name')).toHaveValue('Saved elsewhere');
  await page.locator('#graph-name').fill('  Trimmed name  '); await page.locator('#save-details').click();
  await expect(page.locator('#selected-title')).toHaveText('Trimmed name');
  await expect(page.locator('#details-state')).toBeEmpty();
  await page.reload(); await expect(page.locator('#graph-name')).toHaveValue('Trimmed name');
  expect(await page.evaluate(() => sessionStorage.getItem('graph-library-details-draft'))).toBeNull();
});

test('Library keeps both panes visible, marks selection and preserves browsing focus on desktop', async ({ libraryExtension: f }) => {
  const { page } = f;
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('B'));
  await page.reload();
  await expect(page.locator('dialog#selected, #back-to-graphs')).toHaveCount(0);
  await expect(page.locator('#selected')).toBeVisible();
  const list = await page.locator('#graphs').boundingBox(), detail = await page.locator('#selected').boundingBox();
  expect(list.x + list.width).toBeLessThan(detail.x);
  expect(list.y).toBe(detail.y);
  expect(list.width).toBeGreaterThan(300); expect(detail.width).toBeGreaterThan(450);
  const first = page.locator(`#graph-list button[data-id="${a}"]`), second = page.locator(`#graph-list button[data-id="${b}"]`);
  await first.click();
  await expect(first).toBeFocused(); await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(first).not.toHaveAttribute('aria-haspopup');
  await expect(page.locator('#selected-title')).toHaveText('Graph A');
  await first.press('ArrowUp'); await expect(second).toBeFocused(); await second.press('Enter');
  await expect(second).toBeFocused(); await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#graph-list li.selected')).toHaveCount(1);
  await expect(page.locator('#selected-title')).toHaveText('Graph B');
  await page.reload();
  await expect(page.locator('#selected-title')).toHaveText('Graph B');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  expect((await library(page)).assignments).toEqual({ live: 'default-live', webVoice: null });
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('switching graphs confirms draft discard and keeps canceled selections and row actions safe', async ({ libraryExtension: f }) => {
  const { page } = f;
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('B'));
  await page.reload();
  const first = page.locator(`#graph-list button[data-id="${a}"]`), second = page.locator(`#graph-list button[data-id="${b}"]`);
  await first.click(); await page.locator('#graph-name').fill('Unsaved A');
  page.once('dialog', dialog => dialog.dismiss()); await second.click();
  await expect(second).toBeFocused(); await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved A');
  expect(await page.evaluate(() => localStorage.getItem('graph-library-selection'))).toBe(a);
  const menu = page.getByLabel('Actions for Graph B', { exact: true });
  await menu.press('Enter'); page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(menu).toBeFocused(); await expect(page.locator('#graph-list button[data-id]')).toHaveCount(3);
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved A');
  page.once('dialog', dialog => dialog.accept()); await second.click();
  await expect(second).toBeFocused(); await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#graph-name')).toHaveValue('Graph B');
  expect(await page.evaluate(() => sessionStorage.getItem('graph-library-details-draft'))).toBeNull();
  await first.click(); await expect(page.locator('#graph-name')).toHaveValue('Graph A');
  expect((await library(page)).assignments).toEqual({ live: 'default-live', webVoice: null });
  await moreAction(page, 'check-cache');
  await expect(page.locator('#graph-metadata')).toHaveAttribute('open', '');
  await expect(page.locator('#graph-cache')).toHaveText('Ready · cached files');
  await expect(page.locator('#graph-models')).toHaveText('None');
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('narrow Library stacks panes, keeps menus and consent accessible and has no overflow', async ({ libraryExtension: f }) => {
  const { page } = f;
  const long = await create(page, 'A long graph name that wraps on small screens', simple());
  const mic = await create(page, 'A long microphone pipeline name that should fit within its selector', microphoneGraph());
  await page.reload(); await assign(page, 'live', long); await assign(page, 'webVoice', mic);
  for (const width of [768, 600, 500, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#graphs')).toBeVisible(); await expect(page.locator('#selected')).toBeVisible();
    await expect(page.locator('#launch-settings, #live-graph, #web-graph')).toHaveCount(0);
    await expect(page.locator('aside, nav, [data-section]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open details for A long graph name that wraps on small screens', exact: true }).click();
    await expect(page.locator('#selected-title')).toBeFocused();
    await expect(page.locator('#open')).toBeInViewport();
    const list = await page.locator('#graphs').boundingBox(), detail = await page.locator('#selected').boundingBox();
    expect(detail.y).toBeGreaterThanOrEqual(list.y + list.height);
    await page.locator('#graph-more > summary').press('Enter');
    const box = await page.locator('#graph-more .graph-command-list').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await expect(page.locator('#graph-more > summary')).toBeFocused();
    await expect(page.locator('#graph-more')).not.toHaveAttribute('open');
    await expect(page.locator('#selected')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const menu = page.getByLabel('Actions for A long graph name that wraps on small screens', { exact: true });
    await menu.press('Enter');
    const commands = await page.locator('.row-menu[open] .row-commands').boundingBox();
    expect(commands.x).toBeGreaterThanOrEqual(0); expect(commands.x + commands.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
    await page.locator('#web-voice-enabled').focus();
    await page.keyboard.press('Space'); await expect(page.locator('#voice-consent')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#web-voice-enabled')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test('selection and refresh keep keyboard access to the list without trapping focus in details', async ({ libraryExtension: f }) => {
  const { page } = f;
  await create(page, 'Focus regression', simple()); await page.reload();
  const row = page.getByRole('button', { name: 'Open details for Focus regression', exact: true });
  await row.click(); await expect(row).toBeFocused();
  await page.keyboard.press('Escape'); await expect(row).toBeFocused();
  const menu = page.getByLabel('Actions for Focus regression', { exact: true });
  await page.keyboard.press('Tab'); await expect(menu).toBeFocused();
  await menu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Graph details', exact: true }).click();
  await expect(page.locator('#selected-title')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#preview-scroll')).toBeFocused();
  await page.locator('#graph-name').fill('Unsaved focus regression');
  await row.click(); await expect(page.locator('#graph-name')).toHaveValue('Unsaved focus regression');
  await expect(row).toBeFocused();
  await page.evaluate(() => { const channel = new BroadcastChannel('model-cache-updates'); channel.postMessage({}); channel.close(); });
  await expect(row).toBeFocused();
  await page.locator('#graph-name').fill('Focus regression');
});

test('long lists scroll independently while selected details remain available', async ({ libraryExtension: f }) => {
  const { page } = f;
  for (let i = 0; i < 24; i++) await create(page, `Graph ${String(i).padStart(2, '0')}`, simple());
  await page.reload(); await tools(page); await page.locator('#sort').selectOption('name');
  const row = page.getByRole('button', { name: 'Open details for Graph 23', exact: true });
  await row.click();
  await expect(page.locator('#selected-title')).toHaveText('Graph 23');
  expect(await page.locator('#graph-list').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await expect(row).toBeFocused();
  await expect(page.locator('#open')).toBeInViewport();
});

test('header Models utility and row actions work alongside persistent details at zoom and in forced colors', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const id = await create(page, 'Research notes', simple('Research'));
  await page.reload();
  await expect(page.locator('#selected')).toBeVisible();
  await expect(page.locator('.library-header').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Models', exact: true })).toHaveAttribute('href', 'model-cache.html');
  const opened = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  const models = await opened; await expect(models).toHaveURL(url + 'model-cache.html'); await models.close();
  const menu = page.getByLabel('Actions for Research notes', { exact: true });
  await menu.press('Enter');
  await expect(page.locator('.row-menu[open]')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
  await expect(page.locator('.row-menu[open]')).toHaveCount(0);
  await menu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Graph details', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Research notes', exact: true })).toBeVisible();
  await expect(page.locator('#selected-title')).toBeFocused();
  await page.locator('#graph-name').fill('Unfinished name');
  await page.keyboard.press('Escape');
  await expect(page.locator('#graph-name')).toBeFocused();
  await page.getByRole('button', { name: 'Open details for Research notes', exact: true }).click();
  await expect(page.locator('#graph-name')).toHaveValue('Unfinished name');
  await expect(page.locator('#details-state')).toContainText('Unsaved');
  await page.locator('#save-details').click();
  const renamedMenu = page.getByLabel('Actions for Unfinished name', { exact: true });
  await renamedMenu.press('Enter');
  const downloading = page.waitForEvent('download');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Export JSON', exact: true }).click();
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(simple('Research'));
  await expect(renamedMenu).toBeFocused();
  await renamedMenu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText('Unfinished name copy');
  expect((await library(page)).assignments).toEqual({ live: 'default-live', webVoice: null });
  // A 200% zoomed desktop has the same header and stacked panes as a narrow viewport.
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.setViewportSize({ width: 640, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  const row = page.getByRole('button', { name: 'Open details for Unfinished name', exact: true });
  await row.click();
  await expect(page.locator('#selected-title')).toBeFocused();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await renamedMenu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Edit graph', exact: true }).click();
  await expect(page).toHaveURL(url + `graph-editor.html?id=${id}`);
  await expect(page.locator('#graph-name')).toHaveText('Unfinished name');
});

test('detail and card Edit graph actions target the clicked graph independently of launch choices', async ({ libraryExtension: f }) => {
  const { page, url } = f;
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', microphoneGraph());
  await page.reload();
  await page.getByRole('button', { name: 'Open details for Graph A', exact: true }).click();
  await expect(page.locator('#open')).toHaveAttribute('href', `graph-editor.html?id=${a}`);
  await assign(page, 'live', b); await assign(page, 'webVoice', b);
  await expect(page.locator('#selected-title')).toHaveText('Graph A');
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  await page.getByRole('link', { name: 'Edit graph', exact: true }).click();
  await expect(page).toHaveURL(url + `graph-editor.html?id=${a}`);
  await expect(page.locator('#graph-name')).toHaveText('Graph A');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page).toHaveURL(url + 'graph-library.html');
  await expect(page.locator('#selected-title')).toHaveText('Graph A');
  // The menu belongs to B even though the last opened detail and saved selection were A.
  await page.getByLabel('Actions for Graph B', { exact: true }).press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Edit graph', exact: true }).click();
  await expect(page).toHaveURL(url + `graph-editor.html?id=${b}`);
  await expect(page.locator('#graph-name')).toHaveText('Graph B');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  expect((await library(page)).assignments).toEqual({ live: b, webVoice: b });
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
});
