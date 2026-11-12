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
async function assign(page, target, id) {
  await page.evaluate(async ({ target, id }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign(target, id, readLibrary(localStorage).revision);
  }, { target, id });
}
async function expand(page, id) {
  const row = id ? page.locator(`#graph-list button[data-id="${id}"]`) : page.locator('#graph-list button[data-id]').first();
  if (await row.getAttribute('aria-expanded') !== 'true') await row.click();
}
async function detailAction(page, id) {
  if (id === 'load-details') { await page.locator('#load-details').click(); return; }
  await page.locator(`#${id}`).click();
}
async function rename(page, name, description = '') {
  await page.locator('#graph-name').fill(name); await page.locator('#graph-description').fill(description);
  await expect(page.locator('#selected-title')).toHaveText(`${name}`);
}

async function composition(page, type, value) {
  await page.locator('#graph-name').evaluate((node, { type, value }) => {
    node.dispatchEvent(new CompositionEvent(`composition${type}`, { bubbles: true }));
    node.value = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: type === 'start' }));
  }, { type, value });
}
async function holdDetailsWrites(page) {
  await page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    const rename = GraphLibrary.prototype.rename;
    let release; const gate = new Promise(resolve => { release = resolve; });
    window.detailWrites = []; window.releaseDetailsWrites = release;
    GraphLibrary.prototype.rename = async function(...args) {
      detailWrites.push(args); await gate; return rename.apply(this, args);
    };
  });
}

test('create and import share the heading above search at desktop and narrow widths', async ({ libraryExtension: { page } }) => {
  await expect(page.locator('#library-tools, #sort, #filter')).toHaveCount(0);
  await expect(page.getByText(/Filters & more|Sort graphs|Filter graphs/)).toHaveCount(0);
  const heading = page.locator('#graphs > .section-heading');
  const newGraph = heading.getByRole('button', { name: '+ New Graph', exact: true });
  const importGraph = heading.getByRole('button', { name: 'Import JSON', exact: true });
  const search = page.getByRole('searchbox', { name: 'Search graphs', exact: true });
  for (const width of [1440, 390, 320, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(zoom => { document.documentElement.style.zoom = zoom; }, width === 640 ? '2' : '1');
    for (const control of [newGraph, importGraph, search]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const headingBox = await heading.boundingBox(), searchBox = await search.boundingBox();
    expect(searchBox.y).toBeGreaterThanOrEqual(headingBox.y + headingBox.height);
    const newBox = await newGraph.boundingBox(), importBox = await importGraph.boundingBox();
    expect(importBox.y).toBe(newBox.y);
    expect(importBox.x).toBeGreaterThanOrEqual(newBox.x + newBox.width);
    expect(await search.evaluate(node => node.parentElement.previousElementSibling.classList.contains('section-heading'))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await newGraph.focus();
    for (const control of [newGraph, importGraph, search]) {
      await expect(control).toBeFocused();
      expect(await control.evaluate(node => {
        const style = getComputedStyle(node);
        return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
      })).toBe(true);
      await page.keyboard.press('Tab');
    }
  }
});

test('all graph kinds stay in natural Japanese name order through search, autosave and external updates', async ({ libraryExtension: { page, context, url } }) => {
  await page.evaluate(async graph => {
    const { LIBRARY_KEY, readLibrary } = await import('./graph-library.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const subgraph = extractSubgraph(graph, ['source'], 'alpha').shared;
    const saved = readLibrary(localStorage), template = saved.graphs[0];
    // Reverse insertion order, timestamps and kinds must not override names or ID ties.
    saved.graphs.push(...[
      ['zebra', 'Zebra'], ['twin-z', 'Twin'], ['twin-a', 'Twin'],
      ['kana-z', 'アヒル'], ['dog', 'いぬ'], ['kana-a', 'あひる'],
      ['ten', 'Graph 10'], ['two', 'Graph 2'], ['bravo', 'Bravo'], ['alpha', 'alpha'],
    ].map(([id, name], index) => ({ ...template, id, name, description: 'Searchable description',
      updatedAt: `2025-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      ...(id === 'alpha' ? { kind: 'subgraph', graph: subgraph } : { graph: id === 'two' ? { version: 999 } : graph }) })));
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(saved));
  }, simple());
  await page.reload();
  const names = page.locator('#graph-list .graph-row-name');
  const initial = ['alpha · Subgraph', 'Bravo', 'Graph 2', 'Graph 10', 'Live transcription', 'Twin', 'Twin', 'Zebra', 'あひる', 'アヒル', 'いぬ'];
  const tiedIds = () => page.locator('#graph-list button[data-id^="twin-"]').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  await expect(names).toHaveText(initial);
  expect(await tiedIds()).toEqual(['twin-a', 'twin-z']);
  await page.locator('#search').fill('sEaRcHaBlE');
  await expect(names).toHaveText(initial.filter(name => name !== 'Live transcription'));
  await page.locator('#search').fill('graph');
  await expect(names).toHaveText(['Graph 2', 'Graph 10']);
  await expand(page, 'two');
  await expect(page.locator('#selected-error')).toContainText('Invalid saved graph');
  await expect(page.locator('#export')).toBeEnabled();
  await expect(page.locator('#duplicate')).toBeDisabled();
  await page.locator('#search').fill(''); await expand(page, 'zebra');
  await rename(page, 'Aardvark');
  const renamed = ['Aardvark', ...initial.filter(name => name !== 'Zebra')];
  await expect(names).toHaveText(renamed);
  await page.reload(); await expect(names).toHaveText(renamed);
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await other.evaluate(async () => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const store = new GraphLibrary(localStorage);
    for (const [id, name] of [['ten', 'Zulu'], ['twin-z', 'Twin']]) {
      const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
      await store.rename(id, name, 'Updated elsewhere', entry.revision);
    }
  });
  const refreshed = ['Aardvark', 'alpha · Subgraph', 'Bravo', 'Graph 2', 'Live transcription', 'Twin', 'Twin', 'Zulu', 'あひる', 'アヒル', 'いぬ'];
  await expect(names).toHaveText(refreshed);
  expect(await tiedIds()).toEqual(['twin-a', 'twin-z']);
  await page.reload(); await expect(names).toHaveText(refreshed);
  expect(await tiedIds()).toEqual(['twin-a', 'twin-z']);
});

test('compact microphone header keeps Models last, help accessible and nominal status out of the workspace', async ({ libraryExtension: { page } }) => {
  await expect(page.locator('#web-voice-status')).toBeVisible();
  await expect(page.locator('#web-voice-status')).toContainText('No compatible graphs');
  await expect(page.locator('#web-voice-status')).toHaveAttribute('role', 'status');
  await create(page, 'Dictation', microphoneGraph()); await page.reload();
  const toggle = page.getByRole('switch', { name: 'Show microphone buttons on web pages' });
  const help = page.getByLabel('Website access and microphone help', { exact: true });
  const models = page.locator('.library-header').getByRole('link', { name: 'Models', exact: true });
  await expect(toggle).toBeEnabled();
  await expect(page.locator('#web-voice-status')).toBeEmpty();
  await expect(page.locator('#web-voice-status')).toBeHidden();
  await expect(models).toHaveAttribute('href', 'model-cache.html');
  await expect(models).toHaveAttribute('data-page', 'model-cache.html');
  const titleBox = await page.getByRole('heading', { name: 'Graph Library', exact: true }).boundingBox();
  const toggleBox = await page.locator('.web-microphone').boundingBox(), modelsBox = await models.boundingBox();
  expect(titleBox.x + titleBox.width).toBeLessThan(toggleBox.x);
  expect(toggleBox.x + toggleBox.width).toBeLessThan(modelsBox.x);
  expect(Math.abs(titleBox.y + titleBox.height / 2 - modelsBox.y - modelsBox.height / 2)).toBeLessThan(1);
  expect(await models.evaluate(node => node === node.parentElement.lastElementChild)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('compact-header-desktop.png') });
  const workspaceTop = (await page.locator('.library-workspace').boundingBox()).y;
  await toggle.focus(); await page.keyboard.press('Tab'); await expect(help).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#web-voice-help > div')).toBeVisible();
  const accessibility = await page.context().newCDPSession(page);
  const { nodes } = await accessibility.send('Accessibility.getFullAXTree');
  expect(nodes.find(node => node.name?.value === 'Website access and microphone help')?.properties).toContainEqual({ name: 'expanded', value: { type: 'booleanOrUndefined', value: true } });
  await expect(page.locator('#web-voice-help')).toContainText('current website requests Chrome’s native microphone permission');
  expect((await page.locator('.library-workspace').boundingBox()).y).toBe(workspaceTop);
  await page.keyboard.press('Escape'); await expect(help).toBeFocused();
  await expect(page.locator('#web-voice-help > div')).toBeHidden();
  await page.keyboard.press('Space'); await expect(page.locator('#web-voice-help > div')).toBeVisible();
  await page.keyboard.press('Tab'); await expect(models).toBeFocused();
  await page.getByRole('heading', { name: 'Graph Library', exact: true }).click();
  await expect(page.locator('#web-voice-help > div')).toBeHidden();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 320) {
      const box = await help.boundingBox();
      await accessibility.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await accessibility.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
      await accessibility.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await help.click();
    for (const control of [toggle, help, models, page.locator('#web-voice-help > div')]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
    expect((await help.boundingBox()).width).toBeGreaterThanOrEqual(44);
    expect((await help.boundingBox()).height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 320) await page.screenshot({ path: test.info().outputPath('compact-header-touch-help.png') });
    await page.keyboard.press('Escape');
  }
  await accessibility.detach();
});

test('microphone reconciliation errors remain visible even while OFF', async ({ libraryExtension: { page } }) => {
  await create(page, 'Dictation', microphoneGraph()); await page.reload();
  const toggle = page.locator('#web-voice-enabled'), status = page.locator('#web-voice-status');
  await expect(toggle).toBeEnabled();
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => message.type === 'web-voice-reconcile' ? Promise.resolve({ error: 'Microphone setup failed. Retry by turning ON again.' }) : send(message);
  });
  await toggle.click(); await page.locator('#cancel-voice').click();
  await expect(status).toBeEmpty();
  // OFF reconciliation can fail too; the error must not disappear with the
  // nominal OFF instructions.
  await toggle.evaluate(node => { node.checked = true; });
  await expect(toggle).toBeChecked(); await toggle.uncheck();
  await expect(status).toBeVisible(); await expect(status).toContainText('Microphone setup failed. Retry');
  await expect(toggle).not.toBeChecked(); await expect(toggle).toBeEnabled();
});

test('Library manages independent named graphs, portable JSON, persistent targets, safeguards and responsive details', async ({ libraryExtension: f }) => {
  const { page } = f;
  await expect(page.locator('#launch-settings, #live-graph, #web-graph')).toHaveCount(0);
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  await expect(page.locator('#web-voice-status')).toContainText('No compatible graphs');
  await expect(page.locator('#selected')).toBeHidden(); await expand(page);
  await expect(page.locator('#graph-models')).toBeVisible();
  await expect(page.locator('#graph-models')).toHaveText('ReazonSpeech ja-en ASR');
  await expect(page.locator('#delete')).toBeVisible();
  await expect(page.locator('#delete')).toBeDisabled();
  await expect(page.locator('#delete')).toHaveAccessibleDescription('Keep at least one usable graph.');
  await expect(page.locator('#delete-hint')).toBeVisible();
  await page.locator('#new').click(); await expect(page.locator('#selected-title')).toHaveText('Untitled graph'); await rename(page, 'Meeting Notes', 'Summarize meetings locally');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Meeting Notes']);
  const meeting = (await library(page)).graphs.at(-1);
  await page.locator('#duplicate').click(); await expect(page.locator('#selected-title')).toHaveText('Meeting Notes copy');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Meeting Notes', 'Meeting Notes copy']);
  await rename(page, 'Voice Typing', 'Microphone dictation');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Meeting Notes', 'Voice Typing']);
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
  await page.locator('#search').fill('meet'); await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Meeting Notes', 'Voice Typing']);
  await page.locator('#search').fill('');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Meeting Notes', 'Voice Typing']);
  const beforeImport = await library(page);
  const choosing = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import JSON', exact: true }).press('Enter');
  await (await choosing).setFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
  await expect(page.locator('#errors')).toContainText('Cannot import'); expect(await library(page)).toEqual(beforeImport);
  await page.locator('#import-file').setInputFiles({ name: 'unsupported.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') });
  await expect(page.locator('#errors')).toContainText('version'); expect(await library(page)).toEqual(beforeImport);
  const graph = simple('Imported output');
  await page.locator('#import-file').setInputFiles({ name: 'Imported.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await expect(page.locator('#selected-title')).toHaveText('Imported');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Imported', 'Live transcription', 'Meeting Notes', 'Voice Typing']);
  expect((await library(page)).graphs.at(-1).graph).toEqual(graph);
  await expect(page.locator('#preview-scroll, #preview, #save-details')).toHaveCount(0);
  await expect(page.locator('#graph-models')).toBeVisible();
  await expect(page.locator('#graph-models')).toHaveText('None');
  const downloading = page.waitForEvent('download'); await detailAction(page, 'export');
  expect(JSON.parse(await readFile(await (await downloading).path(), 'utf8'))).toEqual(graph);
  const count = (await library(page)).graphs.length;
  const beforeDelete = await library(page), confirmations = [];
  const onDialog = dialog => { confirmations.push({ type: dialog.type(), message: dialog.message() }); };
  page.on('dialog', onDialog);
  page.once('dialog', dialog => dialog.dismiss()); await detailAction(page, 'delete');
  expect(confirmations).toEqual([{ type: 'confirm', message: 'Delete “Imported”? This cannot be undone.' }]);
  expect(await library(page)).toEqual(beforeDelete);
  await expect(page.locator('#selected-title')).toHaveText('Imported');
  await expect(page.locator('#delete')).toBeFocused();
  page.once('dialog', dialog => dialog.accept()); await detailAction(page, 'delete');
  expect(confirmations).toHaveLength(2); page.off('dialog', onDialog);
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(count - 1);
  await page.getByRole('button', { name: 'Open details for Meeting Notes', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#selected-title')).toHaveText('Meeting Notes');
  await page.screenshot({ path: test.info().outputPath('library-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('#open')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('library-narrow.png'), fullPage: true });
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('Required models stays visible through selection, model search and resolved subgraph refreshes', async ({ libraryExtension: { page, context, url } }) => {
  const graph = simple(); graph.nodes.push(graphNode('OpusMtJaEn', 'translate'), graphNode('IfCondition', 'condition'));
  const modelId = await create(page, 'Processing graph', graph), plainId = await create(page, 'Plain graph', simple());
  const parentId = await page.evaluate(async () => {
    const { graphNode, edge } = await import('./graph.js');
    const { GraphLibrary } = await import('./graph-library.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const extracted = extractSubgraph({ version: 15,
      nodes: [graphNode('Text', 'source'), graphNode('OpusMtJaEn', 'translate'), graphNode('Display', 'display')],
      edges: [edge('source', 'value', 'translate', 'text'), edge('translate', 'text', 'display', 'input1')] }, ['translate'], 'shared-translation');
    const store = new GraphLibrary(localStorage);
    await store.create({ id: 'shared-translation', name: 'Shared processor', kind: 'subgraph', graph: extracted.shared });
    return (await store.create({ name: 'Parent graph', graph: extracted.parent })).graphs.at(-1).id;
  });
  await page.reload();
  const original = await library(page), value = page.locator('#graph-models');
  await page.locator('#search').fill('XtremeDistil');
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(1);
  await expand(page, modelId);
  await expect(value).toBeVisible();
  await expect(value).toHaveText('OPUS-MT · Japanese → English, IfCondition · XtremeDistil');
  await expect(page.locator('#selected > dl > dt')).toHaveText('Required models');
  await expect(value).toHaveRole('definition');
  await expect(page.locator('#graph-metadata, #graph-updated, #graph-cache, #check-cache, #cache-hint, #selected details')).toHaveCount(0);
  await expect(page.locator('#selected')).not.toContainText(/Models & saved information|File cache|Check model files|Live verifies runtime readiness|Manage model files/);
  await expect(page.locator('#selected a[href="model-cache.html"]')).toHaveCount(0);
  expect(await value.evaluate(node => node.parentElement === document.querySelector('#selected').lastElementChild)).toBe(true);
  await page.locator('#search').fill('opus-mt');
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Parent graph', 'Processing graph', 'Shared processor · Subgraph']);
  await page.locator('#search').fill(''); await expand(page, plainId);
  await expect(value).toBeVisible(); await expect(value).toHaveText('None');
  await expand(page, parentId);
  await expect(value).toBeVisible(); await expect(value).toHaveText('OPUS-MT · Japanese → English');
  expect(await library(page)).toEqual(original);
  // Updating the shared definition in another page refreshes the selected parent.
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await other.evaluate(async () => {
    const { GraphLibrary, readLibrary, entryGraph } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === 'shared-translation');
    const graph = entryGraph(entry); graph.nodes.find(node => node.id === 'translate').type = 'OpusMtEnJa';
    await new GraphLibrary(localStorage).save(entry.id, entry.revision, graph);
  });
  await expect(value).toHaveText('OPUS-MT · English → Japanese');
  await page.reload(); await expect(value).toBeVisible(); await expect(value).toHaveText('OPUS-MT · English → Japanese');
  expect((await library(page)).graphs.find(entry => entry.id === parentId)).toEqual(original.graphs.find(entry => entry.id === parentId));
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
      await expand(page, 'legacy-graph');
      await expect(page.locator('#selected-error')).toContainText('Invalid saved graph');
      await expect(page.locator('#graph-models')).toBeVisible();
      await expect(page.locator('#graph-models')).toHaveText('Unknown · repair graph first');
      const downloading = page.waitForEvent('download'); await detailAction(page, 'export');
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
  await expand(page); await expand(other);
  await composition(page, 'start', 'My unsaved name');
  await rename(other, 'Saved elsewhere');
  await composition(page, 'end', 'My unsaved name');
  await expect(page.locator('#details-state')).toContainText('Load saved'); await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  expect((await library(page)).graphs[0].name).toBe('Saved elsewhere');
  page.once('dialog', dialog => dialog.accept()); await detailAction(page, 'load-details');
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
  await expect(page.locator('#details-state')).toContainText('Recovered unsaved details');
  const downloading = page.waitForEvent('download'); await detailAction(page, 'export');
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

test('metadata drafts survive search, library refresh and reload with original revision conflicts', async ({ libraryExtension: { page, context, url } }) => {
  const id = await create(page, 'Draft graph', simple('A')); await create(page, 'Other graph', simple('B'));
  await page.reload(); await page.locator(`#graph-list button[data-id="${id}"]`).click();
  await composition(page, 'start', 'My unsaved name');
  await page.locator('#graph-description').fill('My unsaved description');
  await page.locator('#search').fill('Other');
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(2);
  await expect(page.locator('#selected')).toBeVisible();
  await page.getByRole('button', { name: 'Open details for Other graph', exact: true }).click();
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  await page.locator('#search').fill('no matching graph');
  await expect(page.locator('#empty')).toBeVisible();
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await other.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).rename(id, 'Saved elsewhere', 'Remote details', entry.revision);
  }, id);
  await expect(page.locator('#details-state')).toContainText('Your details are kept');
  page.once('dialog', dialog => dialog.accept()); await page.reload();
  await expect(page.locator('#graph-name')).toHaveValue('My unsaved name');
  await expect(page.locator('#graph-description')).toHaveValue('My unsaved description');
  await expect(page.locator('#graph-list button[aria-expanded="true"]')).toBeFocused();
  await expect(page.locator(`#graph-list button[data-id="${id}"]`)).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#graph-description').fill('Reviewed description');
  await expect(page.locator('#details-state')).toContainText('Load saved');
  expect((await library(page)).graphs.find(entry => entry.id === id).name).toBe('Saved elsewhere');
  page.once('dialog', dialog => dialog.accept()); await detailAction(page, 'load-details');
  await expect(page.locator('#graph-name')).toHaveValue('Saved elsewhere');
  await page.locator('#graph-name').fill('  Trimmed name  ');
  await expect(page.locator('#selected-title')).toHaveText('Trimmed name');
  await expect(page.locator('#details-state')).toHaveText('Saved');
  await expect(page.locator('#errors')).toBeEmpty();
  await expect(page.locator('#details-state')).toBeEmpty();
  await page.reload(); await expect(page.locator('#graph-name')).toHaveValue('Trimmed name');
  expect(await page.evaluate(() => sessionStorage.getItem('graph-library-details-draft'))).toBeNull();
});

test('Library expands one full-width inline row with keyboard controls and no collapsed actions', async ({ libraryExtension: { page } }) => {
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('B'));
  await page.reload();
  await expect(page.locator('#selected')).toBeHidden();
  await expect(page.locator('#graph-list details')).toHaveCount(0);
  await expect(page.locator('#graph-list button[aria-expanded="true"]')).toHaveCount(0);
  const first = page.locator(`#graph-list button[data-id="${a}"]`), second = page.locator(`#graph-list button[data-id="${b}"]`);
  await first.press('Enter');
  await expect(first).toBeFocused(); await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(first).toHaveAttribute('aria-controls', 'selected');
  await expect(page.locator(`#graph-list li[data-id="${a}"] > #selected`)).toBeVisible();
  const workspace = await page.locator('.library-workspace').boundingBox(), row = await first.boundingBox();
  expect(row.width).toBeGreaterThan(workspace.width * .9);
  await expect(page.locator('#selected #open')).toHaveCount(1);
  await expect(page.locator('#selected #duplicate')).toHaveCount(1);
  await expect(page.locator('#graph-more')).toHaveCount(0);
  await expect(page.locator('.detail-actions > a, .detail-actions > button')).toHaveText(['Edit graph', 'Duplicate', 'Export JSON', 'Delete graph']);
  for (const id of ['open', 'duplicate', 'export', 'delete']) await expect(page.locator(`#${id}`)).toBeVisible();
  await expect(page.locator('#load-details')).toBeHidden();
  await first.press('ArrowUp'); await expect(first).toBeFocused();
  await first.press('ArrowDown'); await expect(second).toBeFocused(); await second.press('Space');
  await expect(second).toHaveAttribute('aria-expanded', 'true');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#graph-list li.selected')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Graph B', exact: true })).toBeVisible();
  await page.reload(); await expect(second).toHaveAttribute('aria-expanded', 'true');
  await second.press('Enter');
  await expect(second).toBeFocused(); await expect(second).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#selected')).toBeHidden();
  await page.reload(); await expect(page.locator('#selected')).toBeHidden();
  expect((await library(page)).assignments).toEqual({ live: 'default-live', webVoice: null });
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('row hover preserves the expanded background, collapsed feedback and keyboard focus', async ({ libraryExtension: { page } }) => {
  const header = page.locator('#graph-list button[data-id]').first();
  const row = page.locator('#graph-list li').first();
  const heading = page.getByRole('heading', { name: 'Graph Library', exact: true });
  const transparent = 'rgba(0, 0, 0, 0)';
  await heading.hover();
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(header).toHaveCSS('background-color', transparent);
  await header.hover();
  await expect(header).toHaveCSS('background-color', 'rgb(247, 249, 252)');

  await heading.hover();
  await header.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#selected')).toBeVisible();
  await expect(row).toHaveCSS('background-color', 'rgb(237, 243, 252)');
  await expect(header).toHaveCSS('background-color', transparent);
  const selectedStyle = await row.evaluate(node => {
    const style = getComputedStyle(node);
    return { borderColor: style.borderColor, boxShadow: style.boxShadow };
  });
  await header.hover();
  await expect(header).toHaveCSS('background-color', transparent);
  await expect(row).toHaveCSS('background-color', 'rgb(237, 243, 252)');
  await expect(row).toHaveCSS('border-color', selectedStyle.borderColor);
  await expect(row).toHaveCSS('box-shadow', selectedStyle.boxShadow);
  await expect(header).toBeFocused();
  await expect(header).toHaveCSS('outline-style', 'solid');
  await expect(header).toHaveCSS('outline-width', '3px');
  await expect(header).toHaveCSS('outline-color', 'rgb(50, 106, 198)');

  await header.press('Enter');
  await expect(header).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#selected')).toBeHidden();
  await expect(header).toHaveCSS('background-color', 'rgb(247, 249, 252)');
  await expect(header).toBeFocused();
  await expect(header).toHaveCSS('outline-style', 'solid');
  await expect(header).toHaveCSS('outline-width', '3px');
  await expect(header).toHaveCSS('outline-color', 'rgb(50, 106, 198)');
  await heading.hover();
  await expect(header).toHaveCSS('background-color', transparent);
});

test('rapid switching and collapsing wait for the latest pending details before unified actions', async ({ libraryExtension: { page } }) => {
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('B'));
  const c = await create(page, 'Graph C', simple('C'));
  await page.reload();
  const first = page.locator(`#graph-list button[data-id="${a}"]`), second = page.locator(`#graph-list button[data-id="${b}"]`), third = page.locator(`#graph-list button[data-id="${c}"]`);
  await first.click(); await holdDetailsWrites(page);
  await page.locator('#graph-name').fill('Saved A'); await second.click(); await third.click();
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#graph-name')).toBeEnabled();
  await page.locator('#graph-description').fill('Latest description');
  await page.evaluate(() => releaseDetailsWrites());
  await expect(third).toHaveAttribute('aria-expanded', 'true');
  await expect(second).toHaveAttribute('aria-expanded', 'false');
  const saved = (await library(page)).graphs.find(entry => entry.id === a);
  expect(saved.name).toBe('Saved A'); expect(saved.description).toBe('Latest description');
  expect(saved.graph).toEqual(simple('A'));
  await page.locator('#graph-name').fill('Renamed C'); await third.click();
  await expect(page.locator('#selected')).toBeHidden();
  expect((await library(page)).graphs.find(entry => entry.id === c).name).toBe('Renamed C');
  await second.click(); await page.locator('#duplicate').click();
  await expect(page.locator('#selected-title')).toHaveText('Graph B copy');
  expect((await library(page)).graphs.at(-1).graph).toEqual(simple('B'));
  await expect(page.locator('#graph-models')).toBeVisible();
  await expect(page.locator('#graph-models')).toHaveText('None');
  expect(await page.evaluate(() => modelWorkers.length)).toBe(0);
});

test('subgraph rows retain their distinction and explain referenced-subgraph deletion safeguards', async ({ libraryExtension: { page } }) => {
  await page.evaluate(async () => {
    const { graphNode, edge } = await import('./graph.js');
    const { GraphLibrary } = await import('./graph-library.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const extracted = extractSubgraph({ version: 15,
      nodes: [graphNode('Text', 'source'), graphNode('TextFormatter', 'format'), graphNode('Display', 'display')],
      edges: [edge('source', 'value', 'format', 'input1'), edge('format', 'text', 'display', 'input1')] }, ['format'], 'shared');
    const store = new GraphLibrary(localStorage);
    await store.create({ id: 'shared', name: 'Reusable formatter', kind: 'subgraph', graph: extracted.shared });
    await store.create({ name: 'Parent graph', graph: extracted.parent });
  });
  await page.reload();
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Parent graph', 'Reusable formatter · Subgraph']);
  const row = page.getByRole('button', { name: 'Open details for Reusable formatter · Subgraph', exact: true });
  await row.press('Enter');
  await expect(page.getByRole('button', { name: 'Delete graph', exact: true })).toBeDisabled();
  await expect(page.locator('#delete-hint')).toContainText('Referenced by: Parent graph. Replace or remove instances');
  await expect(page.locator('#delete')).toBeVisible();
  await expect(page.locator('#delete')).toHaveAccessibleDescription(/Referenced by: Parent graph/);
  await expect(page.locator('#delete-hint')).toBeVisible();
  await page.locator('#export').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#graph-name')).toBeFocused();
  await row.click();
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Parent graph', 'Reusable formatter · Subgraph']);
});

test('export waits for autosave, and a later selection cancels an earlier pending action', async ({ libraryExtension: { page } }) => {
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', simple('B'));
  await page.reload(); await expand(page, a); await holdDetailsWrites(page);
  await page.locator('#graph-name').fill('Saved export name');
  const downloads = []; page.on('download', download => downloads.push(download));
  await detailAction(page, 'export');
  expect(downloads).toHaveLength(0);
  await page.evaluate(() => releaseDetailsWrites());
  await expect.poll(() => downloads.length).toBe(1);
  expect(downloads[0].suggestedFilename()).toBe('Saved export name.json');
  expect(JSON.parse(await readFile(await downloads[0].path(), 'utf8'))).toEqual(simple('A'));
  // Reinstall a gate and race the editor action against switching to B.
  await holdDetailsWrites(page); await page.locator('#graph-description').fill('Latest export details');
  await page.locator('#open').click(); await expand(page, b);
  await page.evaluate(() => releaseDetailsWrites());
  await expect(page.locator('#selected-title')).toHaveText('Graph B');
  await expect(page).toHaveURL(/graph-library\.html$/);
  expect((await library(page)).graphs.find(entry => entry.id === a).description).toBe('Latest export details');
});

test('inline accordion, direct actions and consent fit desktop, mobile, zoom and forced colors', async ({ libraryExtension: { page } }) => {
  const graph = simple(); graph.nodes.push(graphNode('OpusMtJaEn', 'translate'), graphNode('IfCondition', 'condition'));
  const id = await create(page, 'A long graph name that wraps on small screens', graph);
  await page.reload();
  const row = page.locator(`#graph-list button[data-id="${id}"]`);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expand(page, id); await expect(row).toBeFocused();
    const header = await row.boundingBox(), detail = await page.locator('#selected').boundingBox();
    expect(detail.y).toBeGreaterThanOrEqual(header.y + header.height);
    expect(Math.abs(detail.x - header.x)).toBeLessThan(2);
    expect(Math.abs(detail.width - header.width)).toBeLessThan(2);
    const controls = ['open', 'duplicate', 'export', 'delete'];
    const boxes = [];
    for (const id of controls) {
      await page.keyboard.press('Tab');
      const control = page.locator(`#${id}`);
      await expect(control).toBeVisible(); await expect(control).toBeFocused();
      expect(await control.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('solid');
      const box = await control.boundingBox(); boxes.push(box);
      expect(box.x).toBeGreaterThanOrEqual(detail.x);
      expect(box.x + box.width).toBeLessThanOrEqual(detail.x + detail.width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y);
      if (Math.abs(boxes[i].y - boxes[i - 1].y) < 1) expect(boxes[i].x).toBeGreaterThanOrEqual(boxes[i - 1].x + boxes[i - 1].width);
    }
    const actionRow = await page.locator('.detail-actions').boundingBox();
    const deletion = boxes.at(-1);
    expect(Math.abs(deletion.x + deletion.width - actionRow.x - actionRow.width)).toBeLessThan(1);
    if (width === 1440) {
      expect(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1)).toBe(true);
      expect(deletion.x - boxes[2].x - boxes[2].width).toBeGreaterThan(16);
    }
    await page.keyboard.press('Tab'); await expect(page.locator('#graph-name')).toBeFocused();
    await expect(page.locator('#graph-models')).toBeVisible();
    await expect(page.locator('#graph-models')).toHaveText('OPUS-MT · Japanese → English, IfCondition · XtremeDistil');
    const form = await page.locator('#details-form').boundingBox();
    for (const field of [page.locator('.required-models dt'), page.locator('#graph-models')]) {
      const box = await field.boundingBox();
      expect(box.y).toBeGreaterThanOrEqual(form.y + form.height);
      expect(box.x).toBeGreaterThanOrEqual(detail.x);
      expect(box.x + box.width).toBeLessThanOrEqual(detail.x + detail.width);
      expect(await field.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await expect(page.locator('.row-menu, dialog#selected, aside, nav, #launch-settings, #preview')).toHaveCount(0);
    await page.locator('#web-voice-enabled').press('Space'); await expect(page.locator('#voice-consent')).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#web-voice-enabled')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`accordion-${width}.png`), fullPage: true });
    await row.click(); await expect(page.locator('#selected')).toBeHidden();
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
  await page.setViewportSize({ width: 640, height: 1000 });
  await page.emulateMedia({ forcedColors: 'active' }); await row.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  for (const id of ['open', 'duplicate', 'export', 'delete']) {
    await page.keyboard.press('Tab'); await expect(page.locator(`#${id}`)).toBeFocused();
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(640);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('list refresh and autosave preserve input focus, caret, composition and row keyboard navigation', async ({ libraryExtension: { page, context, url } }) => {
  const id = await create(page, 'Focus regression', simple()); await page.reload(); await expand(page, id);
  const row = page.locator(`#graph-list button[data-id="${id}"]`);
  await row.press('Tab'); await expect(page.locator('#open')).toBeFocused();
  await page.locator('#graph-name').fill('Z Focus autosave');
  await page.locator('#graph-name').press('ArrowLeft');
  const caret = await page.locator('#graph-name').evaluate(node => node.selectionStart);
  await expect(page.locator('#selected-title')).toHaveText('Z Focus autosave');
  await expect(page.locator('#graph-name')).toBeFocused();
  expect(await page.locator('#graph-name').evaluate(node => node.selectionStart)).toBe(caret);
  await composition(page, 'start', '未確定');
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  const added = await create(other, 'Added elsewhere', simple());
  await expect(page.locator(`#graph-list button[data-id="${added}"]`)).toBeVisible();
  await expect(page.locator('#graph-name')).toBeFocused();
  await row.click(); await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#details-state')).toContainText('finish composing');
  await composition(page, 'end', '確定した名前');
  await expect(page.locator('#selected-title')).toHaveText('確定した名前');
  await row.click(); await expect(row).toBeFocused(); await expect(page.locator('#selected')).toBeHidden();
  await row.press('Home'); await expect(page.locator('#graph-list button[data-id]').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(page.locator('#graph-list button[data-id]').last()).toBeFocused();
});

test('collapsing a filtered-out row saves edits and restores focus to search', async ({ libraryExtension: { page } }) => {
  const id = await create(page, 'Filtered graph', simple()); await page.reload(); await expand(page, id);
  await page.locator('#graph-description').fill('Keep the last edit');
  await page.locator('#search').fill('no matching graph');
  await expect(page.locator('#selected')).toBeVisible();
  await expect(page.locator('#empty')).toBeVisible();
  await page.locator(`#graph-list button[data-id="${id}"]`).click();
  await expect(page.locator('#selected')).toBeHidden(); await expect(page.locator('#search')).toBeFocused();
  await expect(page.locator('#graph-list li')).toHaveCount(0);
  expect((await library(page)).graphs.find(entry => entry.id === id).description).toBe('Keep the last edit');
});

test('long lists scroll the document with details beneath the selected row', async ({ libraryExtension: { page } }) => {
  for (let i = 0; i < 24; i++) await create(page, `Graph ${String(i).padStart(2, '0')}`, simple());
  await page.reload();
  const row = page.getByRole('button', { name: 'Open details for Graph 23', exact: true });
  await row.click(); await expect(row).toBeFocused();
  await expect(page.locator('#selected-title')).toHaveText('Graph 23');
  expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
  expect(await page.locator('#graph-list').evaluate(node => node.scrollHeight <= node.clientHeight)).toBe(true);
  await row.press('Tab'); await expect(page.locator('#open')).toBeFocused(); await expect(page.locator('#open')).toBeInViewport();
});

test('Models utility and the expanded Edit graph action preserve launch choices', async ({ libraryExtension: { page, context, url } }) => {
  const a = await create(page, 'Graph A', simple('A')), b = await create(page, 'Graph B', microphoneGraph());
  await page.reload();
  const opened = context.waitForEvent('page'); await page.getByRole('link', { name: 'Models', exact: true }).click();
  const models = await opened; await expect(models).toHaveURL(url + 'model-cache.html'); await models.close();
  await expand(page, a); await expect(page.locator('#open')).toHaveAttribute('href', `graph-editor.html?id=${a}`);
  await assign(page, 'live', b); await assign(page, 'webVoice', b);
  await expect(page.locator('#web-voice-enabled')).not.toBeChecked();
  // Edit graph waits for a pending rename before leaving the Library.
  await holdDetailsWrites(page); await page.locator('#graph-name').fill('Renamed A');
  await page.locator('#open').click(); await expect(page).toHaveURL(url + 'graph-library.html');
  await page.evaluate(() => releaseDetailsWrites());
  await expect(page).toHaveURL(url + `graph-editor.html?id=${a}`);
  await expect(page.locator('#graph-name')).toHaveText('Renamed A');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.locator('#selected-title')).toHaveText('Renamed A');
  await expand(page, b); await page.locator('#open').click();
  await expect(page).toHaveURL(url + `graph-editor.html?id=${b}`);
  await expect(page.locator('#graph-name')).toHaveText('Graph B');
  expect((await library(page)).assignments).toEqual({ live: b, webVoice: b });
});

test('autosave waits for Japanese IME, rejects interim validation errors and shows only local status', async ({ libraryExtension: { page } }) => {
  const original = await library(page); await expand(page);
  await expect(page.locator('#preview-scroll, #preview, #save-details')).toHaveCount(0);
  await expect(page.locator('#details-state')).toBeEmpty();
  await page.locator('#graph-description').fill('Description before composition');
  await composition(page, 'start', 'にほ');
  await page.waitForTimeout(650);
  expect(await library(page)).toEqual(original);
  await expect(page.locator('#details-state')).toContainText('finish composing');
  await composition(page, 'end', '日本語のグラフ');
  await expect(page.locator('#selected-title')).toHaveText('日本語のグラフ');
  expect((await library(page)).graphs[0].description).toBe('Description before composition');
  await expect(page.locator('#details-state')).toHaveText('Saved');
  await expect(page.locator('#errors')).toBeEmpty();
  const saved = await library(page);
  await page.locator('#graph-name').fill('');
  await expect(page.locator('#details-state')).toContainText('Enter a graph name');
  await page.locator('#graph-description').fill('Keep this too');
  await page.waitForTimeout(650); expect(await library(page)).toEqual(saved);
  await expect(page.locator('#graph-name')).toHaveValue('');
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('graph-library-details-draft')));
  expect(draft.name).toBe(''); expect(draft.description).toBe('Keep this too');
  await page.locator('#graph-name').fill('Valid again');
  await expect(page.locator('#selected-title')).toHaveText('Valid again');
  expect((await library(page)).graphs[0].description).toBe('Keep this too');
});

test('composition starting during a delayed save keeps its unfinished text out of storage', async ({ libraryExtension: { page } }) => {
  await expand(page); await holdDetailsWrites(page);
  await page.locator('#graph-name').fill('Before IME');
  await expect.poll(() => page.evaluate(() => detailWrites.length)).toBe(1);
  await composition(page, 'start', 'へん');
  await page.evaluate(() => releaseDetailsWrites());
  await expect.poll(async () => (await library(page)).graphs[0].name).toBe('Before IME');
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => detailWrites.length)).toBe(1);
  await expect(page.locator('#graph-name')).toHaveValue('へん');
  await composition(page, 'end', '変更した名前');
  await expect(page.locator('#selected-title')).toHaveText('変更した名前');
  expect(await page.evaluate(() => detailWrites.length)).toBe(2);
});

test('quota failures retain drafts, block selection and recover through an explicit retry', async ({ libraryExtension: { page } }) => {
  const other = await create(page, 'Other graph', simple()); await page.reload();
  const before = await library(page), id = before.graphs[0].id; await expand(page, id);
  await page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    const rename = GraphLibrary.prototype.rename, set = Storage.prototype.setItem;
    window.detailsAttempts = 0; window.failDetails = true;
    GraphLibrary.prototype.rename = function(...args) { detailsAttempts++; return rename.apply(this, args); };
    Storage.prototype.setItem = function(key, value) {
      if (key === 'processing-graph-library-v1' && failDetails) throw Error('Fixture quota exceeded');
      return set.call(this, key, value);
    };
  });
  await page.locator('#graph-name').fill('Keep my name');
  await page.locator('#graph-description').fill('Keep my description');
  await expect(page.locator('#details-state')).toContainText('quota exceeded');
  await expect(page.locator('#retry-details')).toBeVisible();
  await page.locator(`#graph-list button[data-id="${other}"]`).click();
  await page.locator(`#graph-list button[data-id="${id}"]`).click();
  await expect(page.locator('#selected')).toBeVisible();
  await page.locator('#open').click();
  await expect(page).toHaveURL(/graph-library\.html$/);
  await expect(page.locator('#load-details')).toBeVisible();
  await page.locator('#new').click(); await page.locator('#duplicate').click();
  await page.locator('#import-file').setInputFiles({ name: 'blocked.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(simple())) });
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => detailsAttempts)).toBe(1);
  expect(await library(page)).toEqual(before);
  await expect(page.locator(`#graph-list button[data-id="${id}"]`)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#graph-name')).toHaveValue('Keep my name');
  await page.evaluate(() => { failDetails = false; }); await page.locator('#retry-details').click();
  await expect(page.locator('#selected-title')).toHaveText('Keep my name');
  await expect(page.locator('#retry-details')).toBeHidden();
  await page.locator(`#graph-list button[data-id="${other}"]`).click();
  await expect(page.locator('#selected-title')).toHaveText('Other graph');
  expect((await library(page)).graphs.find(entry => entry.id === id).description).toBe('Keep my description');
});

test('reload and editor navigation recover pending details without unload-time writes', async ({ libraryExtension: { page, url } }) => {
  const before = await library(page); await expand(page);
  await holdDetailsWrites(page);
  await page.locator('#graph-name').fill('Recover after reload');
  await page.locator('#graph-description').fill('Recover description');
  await expect.poll(() => page.evaluate(() => detailWrites.length)).toBe(1);
  page.once('dialog', dialog => dialog.accept()); await page.reload();
  await expect(page.locator('#graph-name')).toHaveValue('Recover after reload');
  await expect(page.locator('#graph-description')).toHaveValue('Recover description');
  await expect(page.locator('#details-state')).toContainText('Recovered unsaved details');
  await page.waitForTimeout(650); expect(await library(page)).toEqual(before);
  await holdDetailsWrites(page);
  await page.locator('#graph-name').fill('Recover after navigation');
  await expect.poll(() => page.evaluate(() => detailWrites.length)).toBe(1);
  page.once('dialog', dialog => dialog.accept()); await page.goto(url + `graph-editor.html?id=${before.graphs[0].id}`);
  await expect(page).toHaveURL(url + `graph-editor.html?id=${before.graphs[0].id}`);
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.locator('#graph-name')).toHaveValue('Recover after navigation');
  await expect(page.locator('#graph-description')).toHaveValue('Recover description');
  await expect(page.locator('#details-state')).toContainText('Recovered unsaved details');
  expect(await library(page)).toEqual(before);
  await page.locator('#graph-name').fill('Reviewed and saved');
  await expect(page.locator('#selected-title')).toHaveText('Reviewed and saved');
  expect(await page.evaluate(() => sessionStorage.getItem('graph-library-details-draft'))).toBeNull();
});

test('delayed details writes reject concurrent editor changes but permit unrelated graph updates', async ({ libraryExtension: { page, context, url } }) => {
  const otherId = await create(page, 'Other graph', simple('Other'));
  await page.reload(); await expand(page, (await library(page)).graphs[0].id); const original = (await library(page)).graphs[0];
  await holdDetailsWrites(page); await page.locator('#graph-name').fill('Local draft');
  await expect.poll(() => page.evaluate(() => detailWrites.length)).toBe(1);
  const editor = await context.newPage(); await editor.goto(url + `graph-editor.html?id=${original.id}`);
  await editor.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-state')).toHaveText('Saved');
  const remote = await library(page);
  await page.locator('#graph-description').fill('Newer local text');
  await page.evaluate(() => releaseDetailsWrites());
  await expect(page.locator('#details-state')).toContainText('Load saved');
  expect(await library(page)).toEqual(remote);
  await expect(page.locator('#graph-name')).toHaveValue('Local draft');
  await expect(page.locator('#graph-description')).toHaveValue('Newer local text');
  page.once('dialog', dialog => dialog.accept()); await detailAction(page, 'load-details');
  await page.locator('#graph-name').fill('Independent local update');
  await editor.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).rename(id, 'Independent remote update', 'Remote description', entry.revision);
  }, otherId);
  await expect(page.locator('#selected-title')).toHaveText('Independent local update');
  const saved = await library(page);
  expect(saved.graphs.find(entry => entry.id === otherId).name).toBe('Independent remote update');
  expect(saved.graphs.find(entry => entry.id === original.id).graph).toEqual(remote.graphs.find(entry => entry.id === original.id).graph);
});

test('a remote commit arriving before local save completion keeps conflict feedback and the latest list', async ({ libraryExtension: { page, context, url } }) => {
  const original = (await library(page)).graphs[0]; await expand(page);
  await page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    const rename = GraphLibrary.prototype.rename;
    let release; const gate = new Promise(resolve => { release = resolve; });
    window.releaseSaveCompletion = release;
    GraphLibrary.prototype.rename = async function(...args) {
      const next = await rename.apply(this, args); await gate; return next;
    };
  });
  await page.locator('#graph-name').fill('My committed name');
  await expect.poll(async () => (await library(page)).graphs[0].name).toBe('My committed name');
  const other = await context.newPage(); await other.goto(url + 'graph-library.html');
  await rename(other, 'Newer remote name');
  await expect(page.locator('#details-state')).toContainText('changed in another page');
  await page.evaluate(() => releaseSaveCompletion());
  await expect(page.locator('#graph-name')).toHaveValue('My committed name');
  await expect(page.locator('#details-state')).toContainText('Load saved details');
  await expect(page.locator('#retry-details')).toBeVisible();
  await expect(page.locator(`#graph-list button[data-id="${original.id}"]`)).toHaveAccessibleName('Open details for Newer remote name');
  expect((await library(page)).graphs[0].name).toBe('Newer remote name');
});
