import { readFile, mkdir } from 'node:fs/promises';
import { test, expect, library, create } from './library-fixture.js';
import { graphNode, edge, defaultGraph } from '../../extension/graph.js';

const simple = (text = 'Graph output') => {
  const source = graphNode('Text', 'source'); source.settings.value = text;
  return { version: 15, nodes: [source, graphNode('Display', 'display', 300, 20)], edges: [edge('source', 'value', 'display', 'input1')] };
};
const microphoneGraph = () => ({ version: 15,
  nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
  edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] });
async function browse(page) {
  if (await page.locator('#selected').evaluate(node => node.open)) await page.locator('#back-to-graphs').click();
}
async function tools(page) {
  await browse(page);
  if (!await page.locator('#library-tools').evaluate(node => node.open)) await page.locator('#library-tools > summary').click();
}
async function details(page) {
  if (!await page.locator('#selected').evaluate(node => node.open)) await page.locator('#graph-list button[aria-pressed="true"]').click();
}
async function choose(page, target, id) {
  await browse(page);
  await page.locator(target === 'live' ? '#live-graph' : '#web-graph').selectOption(id ?? '');
  await expect.poll(async () => (await library(page)).assignments[target]).toBe(id);
}
async function assign(page, target, id) {
  await page.evaluate(async ({ target, id }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign(target, id, readLibrary(localStorage).revision);
  }, { target, id });
}
async function moreAction(page, id) {
  await details(page);
  if (!await page.locator('#graph-more').evaluate(node => node.open)) await page.locator('#graph-more > summary').click();
  await page.locator(`#${id}`).click();
}
async function rename(page, name, description = '') {
  await details(page);
  await page.locator('#graph-name').fill(name); await page.locator('#graph-description').fill(description);
  await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText(`${name}`);
}

test('Library manages independent named graphs, portable JSON, persistent targets, safeguards and responsive preview', async ({ libraryExtension: f }) => {
  const { page } = f;
  await expect(page.getByLabel('Web Page Microphone', { exact: true })).toHaveValue('');
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(page.locator('#web-graph option[value="default-live"]')).toBeDisabled();
  await expect(page.locator('#graph-cache')).toHaveText('Unknown');
  await expect(page.locator('#delete')).toBeDisabled();
  await browse(page); await page.locator('#new').click(); await expect(page.locator('#selected-title')).toHaveText('Untitled graph'); await rename(page, 'Meeting Notes', 'Summarize meetings locally');
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
  await browse(page); await page.locator('#web-graph').selectOption(voice.id);
  await expect(page.locator('#delete')).toBeDisabled();
  await browse(page); await page.getByRole('button', { name: 'Select Meeting Notes', exact: true }).click();
  await browse(page); await page.locator('#live-graph').selectOption(meeting.id);
  await browse(page); await page.getByRole('button', { name: 'Select Voice Typing', exact: true }).click();
  expect((await library(page)).assignments).toEqual({ live: meeting.id, webVoice: voice.id });
  await page.reload(); await expect(page.locator('#selected-title')).toHaveText('Voice Typing');
  await expect(page.getByRole('button', { name: 'Select Meeting Notes', exact: true })).toContainText('Meeting Notes');
  await expect(page.locator('#live-graph')).toHaveValue(meeting.id);
  await expect(page.locator('#web-graph')).toHaveValue(voice.id);
  await browse(page); await page.locator('#search').fill('meet'); await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Meeting Notes']);
  await browse(page); await page.locator('#search').fill(''); await tools(page); await page.locator('#sort').selectOption('name');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Meeting Notes', 'Voice Typing']);
  await tools(page); await page.locator('#filter').selectOption('assigned'); await expect(page.locator('#graph-list button[data-id]')).toHaveCount(2);
  await tools(page); await page.locator('#filter').selectOption('all');
  const beforeImport = await library(page);
  await browse(page); await page.locator('#import-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.locator('#errors')).toContainText('Cannot import'); expect(await library(page)).toEqual(beforeImport);
  await browse(page); await page.locator('#import-file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await expect(page.locator('#errors')).toContainText('version'); expect(await library(page)).toEqual(beforeImport);
  const graph = simple('Imported output');
  await browse(page); await page.locator('#import-file').setInputFiles({ name: 'Imported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await expect(page.locator('#selected-title')).toHaveText('Imported');
  expect((await library(page)).graphs.at(-1).graph).toEqual(graph);
  await expect(page.locator('#preview rect')).toHaveCount(graph.nodes.length); await expect(page.locator('#preview line')).toHaveCount(graph.edges.length);
  await expect(page.locator('#graph-cache')).toHaveText('Ready · no model files');
  const downloading = page.waitForEvent('download'); await moreAction(page, 'export');
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(graph);
  const count = (await library(page)).graphs.length;
  page.once('dialog', dialog => dialog.dismiss()); await moreAction(page, 'delete'); expect((await library(page)).graphs).toHaveLength(count);
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'delete'); await expect(page.locator('#graph-list button[data-id]')).toHaveCount(count - 1);
  await browse(page); await page.getByRole('button', { name: 'Select Meeting Notes', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#selected-title')).toHaveText('Meeting Notes');
  await mkdir('docs/evidence', { recursive: true });
  await browse(page);
  await page.locator('#library-tools > summary').click();
  await page.screenshot({ path: 'docs/evidence/library-255-1440.png', fullPage: true });
  await details(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#open')).toBeVisible();
  await page.screenshot({ path: 'docs/evidence/library-255-390.png', fullPage: true });
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
      await details(page); await expect(page.locator('#selected-error')).toContainText('Invalid saved graph');
      const downloading = page.waitForEvent('download'); await moreAction(page, 'export');
      expect(await readFile(await (await downloading).path(), 'utf8')).toBe(raw);
      const editor = await context.newPage(); await editor.goto(url + 'graph-editor.html?id=legacy-graph');
      await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-errors')).toContainText('original has been kept');
      await browse(page); await page.locator('#new').click();
      await expect(page.locator('#selected-title')).toHaveText('Untitled graph');
      await browse(page); await page.locator('#live-graph').selectOption((await library(page)).graphs.at(-1).id);
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
  await browse(page); await page.getByRole('button', { name: 'Select Meeting Notes', exact: true }).click();
  await expect(page.locator('#graph-cache')).toHaveText('Unknown');
  await expect(page.locator('#graph-models')).toContainText('LFM2.5'); await expect(page.locator('#graph-models')).toContainText('Qwen3.5');
  await moreAction(page, 'check-cache'); await expect(page.locator('#graph-cache')).toHaveText('Needs preparation');
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
  const live = await context.newPage(); await live.addInitScript(() => { window.holdModelLoads = true; });
  await live.goto(url + 'recorder.html');
  await expect(live.locator('#live-graph-name')).toHaveText('Meeting Notes'); await expect(live.locator('#start')).toBeDisabled();
  await expect.poll(() => live.evaluate(() => modelWorkers.length)).toBe(1); // Parked summary does not load.
  await choose(page, 'live', b);
  await expect(live.locator('#live-graph-name')).toHaveText('Text only'); await expect(live.locator('#start')).toBeEnabled();
  await expect.poll(() => live.evaluate(() => modelWorkers.every(worker => worker.released))).toBe(true);
  await live.evaluate(() => releaseModels());
  await choose(page, 'live', a); await expect(live.locator('#start')).toBeEnabled(); await expect(live.locator('#live-graph-name')).toHaveText('Meeting Notes');
  await live.locator('#start').click(); await expect(live.locator('#session-state')).toHaveText('Running');
  await expect(live.locator('#live-displays')).toContainText('Summary from selected graph');
  const workers = await live.evaluate(() => modelWorkers.length);
  await choose(page, 'live', b);
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
  await details(page); await page.locator('#graph-name').fill('My unsaved name');
  await details(other); await other.locator('#graph-name').fill('Saved elsewhere'); await details(other); await other.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#errors')).toContainText('Unsaved details have been kept');
  await details(page); await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#errors')).toContainText('Load saved'); await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  expect((await library(page)).graphs[0].name).toBe('Saved elsewhere');
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'load-details');
  await expect(page.locator('#graph-name')).toHaveValue('Saved elsewhere');
  const raw = JSON.stringify(simple('Legacy edit from old tab'));
  await other.evaluate(raw => localStorage.setItem('processing-graph-v1', raw), raw);
  await expect(page.locator('#recovery')).toBeVisible(); await browse(page); await page.locator('#recover-legacy').click();
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(2);
  const recovered = await library(page);
  expect(recovered.assignments.live).toBe(id); expect(recovered.graphs.at(-1).source).toBe(raw);
  expect(recovered.graphs[0].graph).toEqual(original.graphs[0].graph);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await details(page); await page.locator('#graph-name').fill('Unsaved details before deletion');
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
  await browse(pages[0]); await pages[0].locator('#new').click(); await expect(pages[0].locator('#errors')).toContainText('quota exceeded');
  expect(await library(page)).toEqual(before);
  const corrupt = '{broken library envelope';
  await page.evaluate(raw => localStorage.setItem('processing-graph-library-v1', raw), corrupt);
  await page.reload(); await expect(page.locator('#recovery')).toBeVisible(); await expect(page.locator('#new')).toBeDisabled();
  const downloading = page.waitForEvent('download'); await page.locator('#export-storage').click();
  expect(await readFile(await (await downloading).path(), 'utf8')).toBe(corrupt);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
});

test('sidebar and paired panels separate keyboard selection from accessible launch settings and consent', async ({ libraryExtension: f }) => {
  const { page } = f;
  const a = await create(page, 'Notes', simple('notes'));
  const voiceGraph = { version: 15, nodes: [graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'), graphNode('FocusedInputTextOutputNode', 'field')],
    edges: [edge('mic', 'audio', 'asr', 'audio'), edge('asr', 'final', 'field', 'text')] };
  const b = await create(page, 'Voice Input', voiceGraph);
  await page.reload();
  const before = (await library(page)).assignments;
  await tools(page); await page.locator('#sort').selectOption('name');
  const notes = page.getByRole('button', { name: 'Select Notes', exact: true });
  await notes.focus(); await notes.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Select Voice Input', exact: true })).toBeFocused();
  await expect(page.locator('#selected-title')).toHaveText('Live transcription');
  await page.keyboard.press('Enter');
  await expect(page.locator('#selected-title')).toHaveText('Voice Input');
  expect((await library(page)).assignments).toEqual(before);
  await expect(page.locator('#open')).toHaveAttribute('href', `graph-editor.html?id=${b}`);
  await browse(page);
  await expect(page.getByRole('button', { name: 'Select Voice Input', exact: true })).toBeFocused();
  const master = await page.locator('#graphs').boundingBox();
  const liveSelect = page.getByLabel('Live Window', { exact: true });
  const webSelect = page.getByLabel('Web Page Microphone', { exact: true });
  const launch = await page.locator('#launch-settings').boundingBox();
  expect(launch.y).toBe(master.y);
  expect(launch.x).toBeGreaterThanOrEqual(master.x + master.width);
  const sidebar = await page.locator('.library-sidebar').boundingBox();
  expect(sidebar.width).toBeGreaterThanOrEqual(180); expect(sidebar.width).toBeLessThanOrEqual(220);
  await expect(page.locator('#selected')).not.toContainText('Use this graph for');
  await expect(page.locator('#selected select')).toHaveCount(0);
  await expect(page.locator('#graph-list .graph-markers')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Show microphone buttons on web pages' })).not.toBeChecked();
  await browse(page); await webSelect.selectOption(b);
  await expect(page.locator('#web-launch-status')).toContainText('Saved');
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  expect((await library(page)).assignments).toEqual({ live: before.live, webVoice: b });
  await expect(page.getByRole('button', { name: 'Select Voice Input', exact: true })).toHaveText('Voice Input');
  await browse(page); await notes.click();
  await expect(page.locator(`#web-graph option[value="${a}"]`)).toBeDisabled();
  await expect(page.locator(`#web-graph option[value="${a}"]`)).toContainText('MicrophoneAudio');
  expect((await library(page)).assignments.webVoice).toBe(b);
  // Native keyboard selection changes a launch setting without selecting a Library row.
  await browse(page); await liveSelect.focus(); await liveSelect.press('n'); await liveSelect.press('Tab');
  await expect(liveSelect).toHaveValue(a);
  await expect(page.locator('#live-launch-status')).toContainText('Saved');
  expect((await library(page)).assignments).toEqual({ live: a, webVoice: b });
  await expect(page.locator('#selected-title')).toHaveText('Notes');
  await browse(page); await page.getByRole('button', { name: 'Select Voice Input', exact: true }).click();
  await moreAction(page, 'check-cache');
  await expect(page.locator('#delete')).toBeDisabled();
  await expect(page.locator('#delete-hint')).toContainText('Launch settings');
  await browse(page); await webSelect.selectOption('');
  await expect(webSelect).toHaveValue('');
  await expect(page.locator('#delete')).toBeEnabled();
  expect((await library(page)).assignments).toEqual({ live: a, webVoice: null });
  await page.locator('#web-voice-enabled').click();
  await expect(page.locator('#voice-consent')).not.toBeVisible();
  await expect(page.locator('#web-voice-status')).toContainText('Choose a graph');
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  await details(page); await page.locator('#graph-more > summary').press('Enter');
  await expect(page.locator('#export')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#export')).not.toBeVisible();
  await expect(page.locator('#graph-more > summary')).toBeFocused();
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('metadata drafts survive filtering, canceled selection, async refresh and reload with original revision conflicts', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const id = await create(page, 'Draft graph', simple('A')); await create(page, 'Other graph', simple('B'));
  await page.reload();
  await browse(page); await page.getByRole('button', { name: 'Select Draft graph', exact: true }).click();
  await details(page); await page.locator('#graph-name').fill('My unsaved name');
  await details(page); await page.locator('#graph-description').fill('My unsaved description');
  await expect(page.locator('#details-state')).toContainText('Unsaved changes');
  await browse(page); await page.locator('#search').fill('Other');
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(1);
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  page.once('dialog', dialog => dialog.dismiss());
  await browse(page); await page.getByRole('button', { name: 'Select Other graph', exact: true }).click();
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  await tools(page); await page.locator('#filter').selectOption('assigned');
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
  await page.keyboard.press('Escape');
  await expect(page.locator('#graph-list button[aria-pressed="true"]')).toBeFocused();
  await details(page); await page.locator('#save-details').click();
  await expect(page.locator('#errors')).toContainText('Load saved');
  expect((await library(page)).graphs.find(entry => entry.id === id).name).toBe('Saved elsewhere');
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'load-details');
  await expect(page.locator('#graph-name')).toHaveValue('Saved elsewhere');
  await details(page); await page.locator('#graph-name').fill('  Trimmed name  '); await details(page); await page.locator('#save-details').click();
  await expect(page.locator('#selected-title')).toHaveText('Trimmed name');
  await expect(page.locator('#details-state')).toBeEmpty();
  await page.reload(); await details(page); await expect(page.locator('#graph-name')).toHaveValue('Trimmed name');
  expect(await page.evaluate(() => sessionStorage.getItem('graph-library-details-draft'))).toBeNull();
});

test('narrow Library has a focused Back action, usable menus and no overflow at small screen zoom', async ({ libraryExtension: f }) => {
  const { page } = f;
  const long = await create(page, 'A long graph name that wraps on small screens', simple());
  const mic = await create(page, 'A long microphone pipeline name that should fit within its selector', microphoneGraph());
  await page.reload(); await choose(page, 'live', long); await choose(page, 'webVoice', mic);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#graphs')).toBeVisible(); await expect(page.locator('#selected')).not.toBeVisible();
    await browse(page); await page.getByRole('button', { name: 'Select A long graph name that wraps on small screens', exact: true }).click();
    await expect(page.locator('#selected-title')).toBeFocused();
    await expect(page.locator('#selected')).toHaveAttribute('open', ''); await expect(page.locator('#open')).toBeVisible();
    await details(page); await page.locator('#graph-more > summary').press('Enter');
    const box = await page.locator('#graph-more .graph-command-list').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#back-to-graphs').click();
    await expect(page.getByRole('button', { name: 'Select A long graph name that wraps on small screens', exact: true })).toBeFocused();
    await expect(page.locator('#graphs')).toBeVisible();
    await expect(page.locator('#launch-settings')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Live Window', exact: true })).toHaveValue(long);
    await expect(page.getByRole('combobox', { name: 'Web Page Microphone', exact: true })).toHaveValue(mic);
    await page.locator('#web-graph').focus(); await page.keyboard.press('Tab');
    await expect(page.getByRole('switch', { name: 'Show microphone buttons on web pages' })).toBeFocused();
    await page.keyboard.press('Space'); await expect(page.locator('#voice-consent')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#web-voice-enabled')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#launch-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `docs/evidence/library-255-list-${width}.png`, fullPage: true });
  }
});

test('closing graph details restores focus once without interrupting subsequent focus changes', async ({ libraryExtension: f }) => {
  const { page } = f;
  const id = await create(page, 'Focus regression', simple());
  await page.reload();
  for (const menu of [false, true]) {
    const invoker = menu ? page.getByLabel('Actions for Focus regression', { exact: true })
      : page.getByRole('button', { name: 'Select Focus regression', exact: true });
    await invoker.click();
    if (menu) await page.locator('.row-menu[open]').getByRole('button', { name: 'Graph details', exact: true }).click();
    await expect(page.locator('#selected-title')).toBeFocused();
    const focus = await page.evaluate(({ id, menu }) => new Promise(resolve => {
      const dialog = document.getElementById('selected');
      const row = [...document.querySelectorAll('#graph-list li')].find(row => row.dataset.id === id);
      const target = row.querySelector(menu ? 'summary' : 'button[data-id]');
      let restored;
      dialog.addEventListener('close', () => resolve({ restored, afterClose: document.activeElement.id }), { once: true });
      document.getElementById('back-to-graphs').click();
      restored = document.activeElement === target;
      // Move focus in the same task, before the native dialog's queued close event.
      document.getElementById('web-graph').focus();
    }), { id, menu });
    expect(focus).toEqual({ restored: true, afterClose: 'web-graph' });
    await page.keyboard.press('Tab');
    await expect(page.locator('#web-voice-enabled')).toBeFocused();
  }
});

test('long lists scroll independently and details return focus to the invoking row', async ({ libraryExtension: f }) => {
  const { page } = f;
  for (let i = 0; i < 24; i++) await create(page, `Graph ${String(i).padStart(2, '0')}`, simple());
  await page.reload(); await tools(page); await page.locator('#sort').selectOption('name');
  const title = await page.locator('#launch-title').boundingBox();
  await browse(page); await page.getByRole('button', { name: 'Select Graph 23', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText('Graph 23');
  expect(await page.locator('#graph-list').evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await browse(page);
  await expect(page.getByRole('button', { name: 'Select Graph 23', exact: true })).toBeFocused();
  expect((await page.locator('#launch-title').boundingBox()).y).toBe(title.y);
  await details(page);
  await expect(page.locator('#open')).toBeInViewport();
});

test('launch selectors synchronize across tabs and renames without discarding metadata drafts', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const a = await create(page, 'Meeting Notes', simple()), b = await create(page, 'Voice Input', microphoneGraph());
  await page.reload();
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await details(page); await page.locator('#graph-name').fill('Unsaved library name');
  await details(page); await page.locator('#graph-description').fill('Unsaved description');
  await choose(other, 'live', a); await choose(other, 'webVoice', b);
  await expect(page.locator('#live-graph')).toHaveValue(a);
  await expect(page.locator('#web-graph')).toHaveValue(b);
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved library name');
  await expect(page.locator('#graph-description')).toHaveValue('Unsaved description');
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  await browse(other); await other.getByRole('button', { name: 'Select Voice Input', exact: true }).click();
  await rename(other, 'Renamed pipeline');
  await expect(page.locator(`#web-graph option[value="${b}"]`)).toHaveText('Renamed pipeline');
  await tools(page); await page.locator('#sort').selectOption('name');
  await expect(page.locator('#web-graph')).toHaveValue(b);
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved library name');
  await details(page); await page.locator('#save-details').click();
  await expect(page.locator('#selected-title')).toHaveText('Unsaved library name');
  await page.reload();
  await expect(page.locator('#live-graph')).toHaveValue(a); await expect(page.locator('#web-graph')).toHaveValue(b);
  await expect(page.locator(`#web-graph option[value="${b}"]`)).toHaveText('Renamed pipeline');
  await choose(other, 'webVoice', null); await expect(page.locator('#web-graph')).toHaveValue('');
  expect((await library(page)).assignments.live).toBe(a);
});

test('launch conflicts and failed writes restore saved choices, retain drafts and focus actionable errors', async ({ libraryExtension: f }) => {
  const { page } = f;
  const a = await create(page, 'Meeting Notes', simple()), b = await create(page, 'Voice Input', microphoneGraph());
  await page.reload(); await details(page); await page.locator('#graph-name').fill('Unsaved details');
  // Simulate a write winning before this tab receives the storage event.
  await page.evaluate(id => {
    const next = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
    next.revision = crypto.randomUUID(); next.assignments.live = id;
    localStorage.setItem('processing-graph-library-v1', JSON.stringify(next));
  }, b);
  await browse(page); await page.locator('#live-graph').selectOption(a);
  await expect(page.locator('#live-launch-status')).toContainText('not saved');
  await expect(page.locator('#live-launch-status')).toBeFocused();
  await expect(page.locator('#live-graph')).toHaveValue(b);
  expect((await library(page)).assignments.live).toBe(b);
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved details');
  await choose(page, 'live', a);
  await expect(page.locator('#live-launch-status')).toContainText('Saved');
  await expect(page.locator('#live-graph')).toBeFocused();
  await page.evaluate(() => {
    const nativeSet = Storage.prototype.setItem;
    window.restoreStorage = () => { Storage.prototype.setItem = nativeSet; };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'processing-graph-library-v1') throw Error('Fixture quota exceeded');
      return nativeSet.call(this, key, value);
    };
  });
  const before = await library(page);
  await browse(page); await page.locator('#web-graph').selectOption(b);
  await expect(page.locator('#web-launch-status')).toContainText('quota exceeded');
  await expect(page.locator('#web-launch-status')).toBeFocused();
  await expect(page.locator('#web-graph')).toHaveValue('');
  expect(await library(page)).toEqual(before);
  await expect(page.locator('#graph-name')).toHaveValue('Unsaved details');
  await page.evaluate(() => restoreStorage());
  await choose(page, 'webVoice', b);
  await expect(page.locator('#web-launch-status')).toContainText('Saved');
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
});

test('invalid launch choices are disabled and rejected; changed bound graphs retain their identity and recovery', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const a = await create(page, 'Notes', simple()), b = await create(page, 'Voice Input', microphoneGraph());
  const empty = await create(page, 'Unconnected draft', { version: 15, nodes: [graphNode('Text', 'source')], edges: [] });
  await page.reload();
  await expect(page.locator(`#live-graph option[value="${empty}"]`)).toBeDisabled();
  await expect(page.locator(`#live-graph option[value="${empty}"]`)).toContainText('executable path');
  await expect(page.locator('#live-graph option[value=""]')).toHaveCount(0);
  await expect(page.locator(`#web-graph option[value="${a}"]`)).toBeDisabled();
  const before = (await library(page)).assignments;
  // Defense in depth for a synthetic change event bypassing native disabled options.
  await page.locator('#web-graph').evaluate((node, id) => { node.value = id; node.dispatchEvent(new Event('change')); }, a);
  await expect(page.locator('#web-launch-status')).toContainText('MicrophoneAudio');
  await expect(page.locator('#web-launch-status')).toBeFocused();
  expect((await library(page)).assignments).toEqual(before);
  await choose(page, 'webVoice', b);
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await other.evaluate(async ({ id, graph }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).save(id, entry.revision, graph);
  }, { id: b, graph: simple('Changed to another purpose') });
  await expect(page.locator('#web-graph')).toHaveValue(b);
  await expect(page.locator('#web-launch-status')).toContainText('MicrophoneAudio');
  await page.locator('#web-voice-enabled').click();
  await expect(page.locator('#voice-consent')).not.toBeVisible();
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  expect((await library(page)).assignments.webVoice).toBe(b);
  await browse(page); await page.getByRole('button', { name: 'Select Voice Input', exact: true }).click();
  await moreAction(page, 'check-cache'); await expect(page.locator('#delete')).toBeDisabled();
  await choose(page, 'webVoice', null); await expect(page.locator('#delete')).toBeEnabled();
  page.once('dialog', dialog => dialog.accept()); await moreAction(page, 'delete');
  await expect(page.getByRole('button', { name: 'Select Voice Input', exact: true })).toHaveCount(0);
  expect((await library(page)).graphs.some(entry => entry.id === b)).toBe(false);
  // Corrupt stored entries stay visible and recoverable, with no launch fallback.
  await other.evaluate(id => {
    const next = JSON.parse(localStorage.getItem('processing-graph-library-v1'));
    next.graphs.find(entry => entry.id === id).graph = { version: 999 };
    next.revision = crypto.randomUUID(); localStorage.setItem('processing-graph-library-v1', JSON.stringify(next));
  }, empty);
  await expect(page.locator(`#live-graph option[value="${empty}"]`)).toBeDisabled();
  await expect(page.locator(`#web-graph option[value="${empty}"]`)).toBeDisabled();
  await tools(page); await page.locator('#filter').selectOption('invalid');
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(1);
  await page.locator('#graph-list button[data-id]').click();
  await expect(page.locator('#selected-error')).toContainText('Invalid saved graph');
  expect((await library(page)).assignments).toEqual(before);
});

test('sidebar destinations, row action menus and modal keyboard focus remain usable', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const id = await create(page, 'Research notes', simple('Research'));
  await page.reload();
  await expect(page.locator('#selected')).not.toBeVisible();
  await page.getByRole('link', { name: 'Launch Settings', exact: true }).click();
  await expect(page.locator('#launch-settings')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Launch Settings', exact: true })).toHaveAttribute('aria-current', 'location');
  await page.getByRole('link', { name: 'Graphs', exact: true }).click();
  await expect(page.locator('#graphs')).toBeFocused();
  await expect(page.getByRole('link', { name: 'Graphs', exact: true })).toHaveAttribute('aria-current', 'location');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page.locator('#navigation-status')).toContainText('Open Live with the toolbar action');
  const opened = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Models', exact: true }).click();
  const models = await opened; await expect(models).toHaveURL(url + 'model-cache.html'); await models.close();
  const menu = page.getByLabel('Actions for Research notes', { exact: true });
  await menu.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.row-menu[open]')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
  await expect(page.locator('.row-menu[open]')).toHaveCount(0);
  await menu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Graph details', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Research notes', exact: true })).toBeVisible();
  await expect(page.locator('#selected-title')).toBeFocused();
  await page.locator('#graph-metadata > summary').focus(); await page.keyboard.press('Tab');
  // Native dialog tabbing may visit browser chrome, but never background page controls.
  expect(await page.evaluate(() => !!document.activeElement.closest('.library-sidebar, .library-workspace'))).toBe(false);
  await page.keyboard.press('Tab');
  await expect(page.locator('#back-to-graphs')).toBeFocused();
  await page.locator('#graph-name').fill('Unfinished name');
  await page.keyboard.press('Escape'); await expect(menu).toBeFocused();
  await page.getByRole('button', { name: 'Select Research notes', exact: true }).click();
  await expect(page.locator('#graph-name')).toHaveValue('Unfinished name');
  await expect(page.locator('#details-state')).toContainText('Unsaved');
  await page.locator('#save-details').click(); await browse(page);
  const renamedMenu = page.getByLabel('Actions for Unfinished name', { exact: true });
  await renamedMenu.press('Enter');
  const downloading = page.waitForEvent('download');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Export JSON', exact: true }).click();
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(simple('Research'));
  await browse(page); await expect(renamedMenu).toBeFocused();
  await renamedMenu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText('Unfinished name copy');
  await browse(page);
  expect((await library(page)).assignments).toEqual({ live: 'default-live', webVoice: null });
  // A 200% zoomed desktop has the same compact navigation and stacked panels as a narrow viewport.
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.setViewportSize({ width: 640, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.emulateMedia({ forcedColors: 'active' });
  await page.getByRole('button', { name: 'Select Unfinished name', exact: true }).click();
  await expect(page.locator('#selected-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Select Unfinished name', exact: true })).toBeFocused();
  await page.emulateMedia({ forcedColors: 'none' });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await renamedMenu.press('Enter');
  await page.locator('.row-menu[open]').getByRole('button', { name: 'Edit graph', exact: true }).click();
  await expect(page).toHaveURL(url + `graph-editor.html?id=${id}`);
  await expect(page.locator('#graph-name')).toHaveText('Unfinished name');
});
