import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

test.beforeEach(async ({ context, page }) => {
  await context.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  // Only the host APIs are controlled; these pages use real storage, Web Locks,
  // canvas, persistence and cross-tab storage events.
  await context.addInitScript(() => {
    const event = { addListener() {} };
    globalThis.chrome = { runtime: { sendMessage: async () => ({ state: 'idle' }) },
      storage: { local: { get: async () => ({}) }, onChanged: event },
      permissions: { contains: async () => true, onRemoved: event, onAdded: event } };
  });
  await page.goto('/extension/graph-editor.html');
  await expect(page.locator('#graph-save')).toBeVisible();
  await page.evaluate(async () => {
    const { graphNode, edge } = await import('/extension/graph.js');
    const { saveLiveGraphData } = await import('/extension/graph-library.js');
    const source = graphNode('Text', 'source', 20, 30); source.settings.value = 'hello';
    const formatter = graphNode('TextFormatter', 'format', 340, 30); formatter.settings.template = 'Before: {1}';
    await saveLiveGraphData(localStorage, { version: 15, nodes: [source, formatter, graphNode('TextAccumulator', 'history', 680, 30), graphNode('Display', 'output', 1020, 30)],
      edges: [edge('source', 'value', 'format', 'input1'), edge('format', 'text', 'history', 'append'), edge('history', 'text', 'output', 'input1')] });
  });
  await page.reload();
});

async function openExtraction(page, advanced = true) {
  await page.getByRole('button', { name: 'Select format', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Select history', exact: true }).focus(); await page.keyboard.press('Shift+Enter');
  await expect(page.locator('.selected-node')).toHaveCount(2);
  await page.locator('#graph-create-subgraph').click();
  const dialog = page.getByRole('dialog', { name: 'Create Subgraph', exact: true });
  await dialog.getByLabel('Subgraph name', { exact: true }).fill('Shared formatting');
  if (advanced) {
    await dialog.getByText('Edit input / output ports', { exact: true }).click();
    await dialog.getByLabel('inputs in1 name').fill('Transcript'); await dialog.getByLabel('outputs out1 name').fill('History');
  }
  return dialog;
}
async function extract(page) {
  const dialog = await openExtraction(page);
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'subgraph input in1', exact: true })).toContainText('Transcript');
  return page.evaluate(async () => {
    const { readLibrary } = await import('/extension/graph-library.js');
    const library = readLibrary(localStorage);
    return { shared: library.graphs.find(entry => entry.kind === 'subgraph').id, parent: library.assignments.live };
  });
}
const save = async page => { await page.locator('#graph-save').click(); await expect(page.locator('#graph-state')).toHaveText('Saved'); };

for (const receiveStorageEvent of [true, false]) test(`open extraction rejects concurrent parent saves (storage event ${receiveStorageEvent ? 'received' : 'pending'})`, async ({ page, context }) => {
  if (!receiveStorageEvent) {
    // Register before the editor to hold its notification back and exercise
    // the revision check inside the storage lock.
    await page.addInitScript(() => window.addEventListener('storage', event => event.stopImmediatePropagation()));
    await page.reload();
  }
  const dialog = await openExtraction(page);
  await page.evaluate(receive => {
    if (receive) {
      globalThis.parentStorageEvent = new Promise(resolve => window.addEventListener('storage', event => {
        if (event.key === 'processing-graph-library-v1') resolve();
      }));
    }
  }, receiveStorageEvent);
  const other = await context.newPage(); await other.goto(page.url());
  await other.getByRole('button', { name: 'Select source', exact: true }).click();
  await other.getByLabel('source value', { exact: true }).fill('Saved concurrently'); await save(other);
  if (receiveStorageEvent) await page.evaluate(() => globalThis.parentStorageEvent);
  const concurrent = await other.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog.getByRole('alert')).toContainText('Parent graph changed while Create Subgraph was open');
  await expect(page.locator('.graph-node')).toHaveCount(4);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(concurrent);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Saving after rejecting the extraction must never restore its old snapshot.
  await page.locator('#graph-save').click();
  if (receiveStorageEvent) await expect(page.locator('#graph-state')).toHaveText('Saved');
  else await expect(page.locator('#graph-errors')).toContainText('Load saved before saving');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')));
  expect(stored.graphs).toHaveLength(1);
  expect(stored.graphs[0].graph.nodes.find(node => node.id === 'source').settings.value).toBe('Saved concurrently');
  // The user can reopen extraction from the refreshed graph and save safely.
  if (!receiveStorageEvent) await page.reload();
  await extract(page); await save(page);
  expect(await page.evaluate(async () => {
    const { readLiveGraph } = await import('/extension/graph-library.js');
    return readLiveGraph(localStorage).graph.nodes.find(node => node.id === 'source').settings.value;
  })).toBe('Saved concurrently');
});

test('extract, review port names, edit on the same canvas and return to an unsaved parent without losing it', async ({ page }) => {
  const ids = await extract(page);
  const inspector = page.locator('.graph-inspector');
  await expect(inspector.getByText('Node help and ports', { exact: true })).toHaveCount(0);
  await expect(inspector.locator('details')).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Remove subgraph', exact: true })).toBeVisible();
  await expect(page.locator('#graph-state')).toHaveText('Unsaved');
  await page.locator('#graph-edit-subgraph').click();
  await expect(page).toHaveURL(new RegExp(`id=${ids.shared}`));
  await expect(page.locator('.graph-node')).toHaveCount(2);
  const exposedPorts = inspector.locator('details').filter({ has: page.getByText('Exposed ports', { exact: true }) });
  await expect(exposedPorts).toHaveAttribute('open', '');
  await expect(exposedPorts.getByLabel('inputs in1 name', { exact: true })).toHaveValue('Transcript');
  await expect(exposedPorts.getByLabel('outputs out1 name', { exact: true })).toHaveValue('History');
  await page.getByRole('button', { name: 'Select format', exact: true }).click();
  await page.getByLabel('format template', { exact: true }).fill('After: {1}'); await save(page);
  await page.getByRole('link', { name: 'Back to parent graph' }).click();
  await expect(page.locator('.graph-node')).toHaveCount(3);
  await expect(page.locator('#graph-state')).toHaveText('Unsaved'); await save(page);
  const result = await page.evaluate(async id => {
    const { readLibrary, resolvedEntryGraph } = await import('/extension/graph-library.js');
    const library = readLibrary(localStorage);
    return resolvedEntryGraph(library.graphs.find(entry => entry.id === id), library).nodes.find(node => node.type === 'TextFormatter').settings.template;
  }, ids.parent);
  expect(result).toBe('After: {1}');
});

test('Add Node in another graph shares identity; saved updates and names refresh open parents across tabs', async ({ page, context }) => {
  const ids = await extract(page); await save(page);
  const secondId = await page.evaluate(async () => {
    const { GraphLibrary } = await import('/extension/graph-library.js'), { graphNode } = await import('/extension/graph.js');
    const library = await new GraphLibrary(localStorage).create({ name: 'Other parent', graph: { version: 15, nodes: [graphNode('Text', 'source'), graphNode('Display', 'output', 700, 30)], edges: [] } });
    return library.graphs.at(-1).id;
  });
  const second = await context.newPage(); await second.goto(`/extension/graph-editor.html?id=${secondId}`);
  await second.locator('#graph-palette-toggle').click();
  await second.getByRole('combobox', { name: 'Search nodes' }).fill('Shared formatting'); await second.keyboard.press('Enter');
  await second.getByRole('button', { name: 'source output value', exact: true }).click();
  await second.getByRole('button', { name: 'subgraph input in1', exact: true }).click();
  await second.getByRole('button', { name: 'subgraph output out1', exact: true }).click();
  await second.getByRole('button', { name: 'output input input1', exact: true }).click(); await save(second);
  const editor = await context.newPage(); await editor.goto(`/extension/graph-editor.html?id=${ids.shared}`);
  await editor.getByRole('button', { name: 'Select format', exact: true }).click();
  await editor.getByLabel('format template', { exact: true }).fill('Updated: {1}'); await save(editor);
  for (const parent of [page, second]) {
    await expect(parent.locator('#graph-state')).toHaveText('Saved');
    expect(await parent.evaluate(async () => {
      const { readLibrary, resolvedEntryGraph } = await import('/extension/graph-library.js');
      const library = readLibrary(localStorage), id = new URLSearchParams(location.search).get('id') || library.assignments.live;
      return resolvedEntryGraph(library.graphs.find(entry => entry.id === id), library).nodes.find(node => node.type === 'TextFormatter').settings.template;
    })).toBe('Updated: {1}');
  }
  await editor.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('/extension/graph-library.js'); const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).rename(id, 'Renamed component', '', entry.revision);
  }, ids.shared);
  await expect(page.getByRole('button', { name: 'Select subgraph', exact: true })).toHaveText('Renamed component');
  await expect(second.getByRole('button', { name: 'Select subgraph', exact: true })).toHaveText('Renamed component');
});

test('breaking ports list references before saving, and stale subgraph editors keep their drafts', async ({ page, context }) => {
  const ids = await extract(page); await save(page);
  await page.goto(`/extension/graph-editor.html?id=${ids.shared}`);
  await page.getByRole('button', { name: 'Select format', exact: true }).click();
  await page.getByLabel('format template', { exact: true }).fill('Stale draft: {1}');
  const other = await context.newPage(); await other.goto(`/extension/graph-editor.html?id=${ids.shared}`);
  await other.getByRole('button', { name: 'Select format', exact: true }).click();
  await other.getByLabel('format template', { exact: true }).fill('Saved elsewhere: {1}'); await save(other);
  await expect(page.locator('.graph-state-notice')).toContainText('Saved graph changed elsewhere');
  await page.locator('#graph-save').click();
  await expect(page.locator('#graph-errors')).toContainText('Load saved before saving');
  await expect(page.getByLabel('format template', { exact: true })).toHaveValue('Stale draft: {1}');
  await other.getByLabel('Graph actions', { exact: true }).click(); await other.locator('#graph-exposed-ports').click();
  await other.getByRole('button', { name: 'Remove out1', exact: true }).click();
  await other.locator('#graph-save').click();
  await expect(other.locator('#graph-errors')).toContainText('Referenced by: Live transcription');
  await expect(other.locator('#graph-errors')).toContainText('Duplicate this subgraph');
  await expect(other.locator('#graph-state')).toHaveText('Unsaved');
});

test('shared library lists all kinds with a safe deletion hint, bundle export and atomic import reuse existing screens', async ({ page }) => {
  const ids = await extract(page); await save(page); await page.goto('/extension/graph-library.html');
  await expect(page.locator('#graph-list > li')).toHaveCount(2);
  await expect(page.locator('#graph-list .graph-row-name')).toHaveText(['Live transcription', 'Shared formatting · Subgraph']);
  await page.locator(`#graph-list button[data-id="${ids.shared}"]`).click();
  await expect(page.locator('#delete')).toBeDisabled(); await expect(page.locator('#delete-hint')).toContainText('Live transcription');
  await page.locator(`#graph-list button[data-id="${ids.parent}"]`).click();
  const downloading = page.waitForEvent('download'); await page.locator('#export').click(); const download = await downloading;
  const bundle = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(bundle.format).toBe('graph-bundle'); expect(bundle.root).toBe(ids.parent); expect(bundle.graphs).toHaveLength(2);
  await page.locator('#import-file').setInputFiles({ name: 'shared.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')).graphs.length)).toBe(4);
  await expect(page.locator('#selected')).toBeVisible();
});

test('simple and advanced creation fit a narrow screen and Escape cancels without saving a definition', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Select format', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Select history', exact: true }).focus(); await page.keyboard.press('Shift+Enter');
  await page.locator('#graph-create-subgraph').click();
  const dialog = page.getByRole('dialog', { name: 'Create Subgraph', exact: true });
  const box = await dialog.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(dialog.getByLabel('inputs in1 name')).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('simple-creation.png') });
  await dialog.getByText('Edit input / output ports', { exact: true }).click();
  await expect(dialog.getByLabel('inputs in1 name')).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('advanced-creation.png') });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')).graphs.length)).toBe(1);
});

test('returning after a parent was deleted externally exposes its preserved draft for recovery', async ({ page, context }) => {
  const ids = await extract(page);
  await page.locator('#graph-edit-subgraph').click();
  const other = await context.newPage(); await other.goto('/extension/graph-editor.html?id=' + ids.parent);
  await other.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('/extension/graph-library.js');
    const store = new GraphLibrary(localStorage); const created = await store.create();
    await store.assign('live', created.graphs.at(-1).id, created.revision);
    await store.delete(id, readLibrary(localStorage).revision);
  }, ids.parent);
  await page.getByRole('link', { name: 'Back to parent graph' }).click();
  await expect(page.locator('#errors')).toContainText('draft is kept below');
  const draft = JSON.parse(await page.getByLabel('Deleted parent draft JSON').inputValue());
  expect(draft.nodes.find(node => node.type === 'Subgraph').subgraphId).toBe(ids.shared);
});

test('exporting a restored invalid migrated draft retains extraction and text edits after dependency deletion', async ({ page }) => {
  await page.evaluate(async () => {
    const { readLiveGraph, LIBRARY_KEY } = await import('/extension/graph-library.js');
    const { GRAPH_KEY } = await import('/extension/graph.js');
    const graph = readLiveGraph(localStorage).graph;
    localStorage.removeItem(LIBRARY_KEY);
    localStorage.setItem(GRAPH_KEY, '  ' + JSON.stringify(graph) + '\n');
  });
  await page.goto('/extension/graph-editor.html');
  const ids = await extract(page);
  await page.getByRole('button', { name: 'Select source', exact: true }).click();
  await page.getByLabel('source value', { exact: true }).fill('Preserve this draft');
  await page.getByRole('button', { name: 'Select subgraph', exact: true }).click();
  await page.locator('#graph-edit-subgraph').click();
  await expect(page.getByRole('link', { name: 'Back to parent graph' })).toBeVisible();
  await page.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('/extension/graph-library.js');
    await new GraphLibrary(localStorage).delete(id, readLibrary(localStorage).revision);
  }, ids.shared);
  await page.getByRole('link', { name: 'Back to parent graph' }).click();
  await expect(page.locator('#graph-errors')).toContainText('Missing or invalid subgraph');
  await page.getByLabel('Graph actions', { exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.locator('#graph-export').click();
  const download = await downloading, draft = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(draft.nodes.find(node => node.type === 'Subgraph').subgraphId).toBe(ids.shared);
  expect(draft.nodes.find(node => node.id === 'source').settings.value).toBe('Preserve this draft');
});

test('disconnecting shared processing reports affected parents in Validate and blocks saving without changing storage', async ({ page }) => {
  const ids = await extract(page); await save(page);
  await page.goto(`/extension/graph-editor.html?id=${ids.shared}`);
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await page.locator('.graph-wire').focus(); await page.keyboard.press('Delete');
  await page.getByLabel('Graph actions', { exact: true }).click(); await page.locator('#graph-validate').click();
  await expect(page.locator('#graph-errors')).toContainText('Cannot disable executable paths. Referenced by: Live transcription');
  await page.locator('#graph-save').click();
  await expect(page.locator('#graph-errors')).toContainText('Restore the internal connections');
  await expect(page.locator('#graph-state')).toHaveText('Unsaved');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
});

test('invalid reviewed extraction leaves storage and canvas unchanged and can be corrected in the same dialog', async ({ page }) => {
  await page.getByRole('button', { name: 'Select format', exact: true }).click();
  await page.getByRole('button', { name: 'Select history', exact: true }).focus(); await page.keyboard.press('Shift+Enter');
  await page.locator('#graph-create-subgraph').click();
  const dialog = page.getByRole('dialog', { name: 'Create Subgraph', exact: true });
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await dialog.getByText('Edit input / output ports', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove out1', exact: true }).click();
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog.getByRole('alert')).toContainText('Keep connected output out1 mapped to history.text');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
  await expect(page.locator('.graph-node')).toHaveCount(4);
  await dialog.getByRole('button', { name: 'Expose output', exact: true }).click();
  await dialog.getByLabel('outputs out1 endpoint').selectOption(JSON.stringify(['history', 'text']));
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.graph-node')).toHaveCount(3);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')).graphs.filter(entry => entry.kind === 'subgraph').length)).toBe(1);
});

async function modifiedClick(heading, modifier) {
  // Chromium on a macOS host translates real Control+click into secondary-click
  // before DOM click handlers, even when navigator reports Windows/Linux.
  if (modifier === 'Control' && process.platform === 'darwin') {
    await heading.dispatchEvent('pointerdown', { button: 0, ctrlKey: true });
    await heading.dispatchEvent('click', { button: 0, ctrlKey: true });
  } else await heading.click({ modifiers: [modifier] });
}

for (const [platform, modifier] of [['Win32', 'Control'], ['Linux x86_64', 'Control'], ['MacIntel', 'Meta']]) {
  test(`${platform} headings toggle with Shift and ${modifier}, preserving focus and accessible state`, async ({ page }) => {
    await page.addInitScript(platform => {
      Object.defineProperty(navigator, 'platform', { value: platform });
      Object.defineProperty(navigator, 'userAgentData', { value: { platform } });
    }, platform);
    await page.reload();
    const first = page.getByRole('button', { name: 'Select format', exact: true });
    const second = page.getByRole('button', { name: 'Select history', exact: true });
    const create = page.locator('#graph-create-subgraph');
    await expect(create).toBeHidden();
    await first.click(); await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(create).toBeHidden();
    for (const key of ['Shift', modifier]) {
      await modifiedClick(second, key);
      await expect(second).toBeFocused();
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await expect(second).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.graph-selection')).toContainText('2 nodes selected');
      await expect(create).toBeVisible();
      // A redraw must retain the selected/pressed state for every heading.
      await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'processing-graph-library-v1' })));
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await expect(second).toHaveAttribute('aria-pressed', 'true');
      await modifiedClick(second, key);
      await expect(second).toHaveAttribute('aria-pressed', 'false');
      await expect(first).toHaveAttribute('aria-pressed', 'true');
      await expect(create).toBeHidden();
    }
    await modifiedClick(second, modifier);
    // A plain click on an already selected node in a group selects it alone.
    await second.click(); await expect(page.locator('.selected-node')).toHaveCount(1);
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await second.click(); await expect(page.locator('.selected-node')).toHaveCount(0);
    await first.focus(); await first.press('Enter');
    await second.focus(); await second.press('Shift+Enter');
    await expect(create).toBeVisible();
    await second.press('Shift+Enter'); await expect(create).toBeHidden();
    await first.press('Escape'); await expect(page.locator('.selected-node')).toHaveCount(0);
    await first.press('Space'); await expect(first).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.graph-scroll').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.selected-node')).toHaveCount(0);
    expect(await page.locator('.graph-command-list #graph-create-subgraph').count()).toBe(0);
    if (platform === 'MacIntel') {
      // Native secondary-click gestures must reach the browser untouched.
      const prevented = await first.evaluate(element => ['pointerdown', 'click'].map(type => {
        const event = new MouseEvent(type, { ctrlKey: true, bubbles: true, cancelable: true });
        element.dispatchEvent(event); return event.defaultPrevented;
      }));
      expect(prevented).toEqual([false, false]);
      await expect(page.locator('.selected-node')).toHaveCount(0);
    }
  });
}

test('simple creation summarizes the selection, requires a name and preserves inferred ports without opening advanced settings', async ({ page }) => {
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  const dialog = await openExtraction(page, false);
  await expect(dialog).toContainText('Included nodes (2): Text formatter (format), Text accumulator (history)');
  await expect(dialog).toContainText('Connections preserved. Automatically inferred: 1 input, 1 output.');
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
  await expect(dialog.getByLabel('inputs in1 name')).toBeHidden();
  await dialog.getByLabel('Subgraph name', { exact: true }).fill('  ');
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog.getByRole('alert')).toHaveText('Enter a Subgraph name.');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#graph-create-subgraph')).toBeFocused();
  await expect(page.locator('.selected-node')).toHaveCount(2);
  await page.locator('#graph-create-subgraph').click();
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Select subgraph', exact: true })).toBeFocused();
  await expect(page.locator('#graph-state')).toHaveText('Unsaved');
  await save(page);
  const graph = await page.evaluate(async () => {
    const { readLibrary, readLiveGraph } = await import('/extension/graph-library.js');
    return { shared: readLibrary(localStorage).graphs.find(entry => entry.kind === 'subgraph').graph, resolved: readLiveGraph(localStorage).graph };
  });
  expect(graph.shared.interface).toEqual({ inputs: [{ id: 'in1', name: 'format input1', node: 'format', port: 'input1' }], outputs: [{ id: 'out1', name: 'history text', node: 'history', port: 'text' }] });
  expect(graph.resolved.edges).toHaveLength(3);
});

for (const multiple of [false, true]) test(`creation reports actual inferred counts (${multiple ? 'multiple' : 'zero'} boundary ports)`, async ({ page }) => {
  await page.evaluate(async multiple => {
    const { graphNode, edge } = await import('/extension/graph.js');
    const { readLiveGraph, saveLiveGraphData } = await import('/extension/graph-library.js');
    const graph = readLiveGraph(localStorage).graph;
    if (multiple) {
      graph.nodes.find(node => node.id === 'output').settings.inputCount = 2;
      graph.nodes.push(graphNode('Text', 'context'), graphNode('Display', 'fanout'));
      graph.edges.push(edge('context', 'value', 'format', 'input2'), edge('format', 'text', 'output', 'input2'), edge('history', 'text', 'fanout', 'input1'));
    } else graph.edges = [edge('format', 'text', 'history', 'append')];
    await saveLiveGraphData(localStorage, graph);
  }, multiple);
  await page.reload();
  const dialog = await openExtraction(page, false);
  await expect(dialog).toContainText(`Automatically inferred: ${multiple ? 2 : 0} inputs, ${multiple ? 2 : 0} outputs.`);
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog).not.toBeVisible(); await save(page);
  expect(await page.evaluate(async () => {
    const { readLiveGraph } = await import('/extension/graph-library.js');
    return readLiveGraph(localStorage).graph.edges.length;
  })).toBe(multiple ? 6 : 1);
});

test('invalid selections explain the restriction beside Create Subgraph and keep selection correctable', async ({ page }) => {
  await page.getByRole('button', { name: 'Select format', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Select output', exact: true }).focus(); await page.keyboard.press('Shift+Enter');
  await page.locator('#graph-create-subgraph').click();
  await expect(page.locator('.graph-selection [role="alert"]')).toContainText('Select one connected group');
  await expect(page.locator('.selected-node')).toHaveCount(2);
  await page.getByRole('button', { name: 'Select history', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Select output', exact: true }).focus(); await page.keyboard.press('Shift+Enter');
  await page.locator('#graph-create-subgraph').click();
  await expect(page.locator('.graph-selection [role="alert"]')).toContainText('output destinations');
  await expect(page.locator('.selected-node')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await openExtraction(page, false);
  await expect(page.getByRole('dialog', { name: 'Create Subgraph', exact: true })).toBeVisible();
});

test('advanced review rejects same-type rerouting but permits labels and editable optional ports', async ({ page }) => {
  const dialog = await openExtraction(page);
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await dialog.getByLabel('outputs out1 endpoint').selectOption(JSON.stringify(['format', 'text']));
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog.getByRole('alert')).toContainText('Keep connected output out1 mapped to history.text');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
  await dialog.getByLabel('outputs out1 endpoint').selectOption(JSON.stringify(['history', 'text']));
  await dialog.getByRole('button', { name: 'Expose input', exact: true }).click();
  await dialog.getByLabel('inputs in2 name').fill('Context');
  await dialog.getByLabel('inputs in2 endpoint').selectOption(JSON.stringify(['format', 'input3']));
  await dialog.getByRole('button', { name: 'Expose output', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove out2', exact: true }).click();
  await expect(dialog.locator('details')).toHaveAttribute('open', '');
  await dialog.getByText('Edit input / output ports', { exact: true }).click();
  await dialog.getByText('Edit input / output ports', { exact: true }).click();
  await expect(dialog.getByLabel('inputs in2 name')).toHaveValue('Context');
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog).not.toBeVisible();
  await save(page);
});

for (const failingStorage of ['session', 'local']) test(`${failingStorage} storage failure keeps the parent and library unchanged and permits retry`, async ({ page }) => {
  const dialog = await openExtraction(page, false);
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  await page.evaluate(kind => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (kind === 'session' ? this === sessionStorage : this === localStorage) throw Error('Storage full');
      return original.call(this, key, value);
    };
    globalThis.restoreStorage = () => { Storage.prototype.setItem = original; };
  }, failingStorage);
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog.getByRole('alert')).toContainText(failingStorage === 'session' ? 'Cannot preserve the parent draft' : 'Storage full');
  await expect(page.locator('.graph-node')).toHaveCount(4);
  await expect(page.locator('.selected-node')).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('subgraph-parent-draft:')))).toHaveLength(0);
  await page.evaluate(() => globalThis.restoreStorage());
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog).not.toBeVisible();
});

test('refresh recovers the unsaved replacement and later edits with its original revision', async ({ page, context }) => {
  const ids = await extract(page);
  await page.getByRole('button', { name: 'Select source', exact: true }).click();
  await page.getByLabel('source value', { exact: true }).fill('Recovered text');
  await page.reload();
  await expect(page.locator('.graph-node')).toHaveCount(3);
  await expect(page.locator('#graph-state')).toHaveText('Unsaved');
  await page.getByRole('button', { name: 'Select source', exact: true }).click();
  await expect(page.getByLabel('source value', { exact: true })).toHaveValue('Recovered text');
  const other = await context.newPage(); await other.goto(`/extension/graph-editor.html?id=${ids.parent}`);
  await other.getByRole('button', { name: 'Select source', exact: true }).click();
  await other.getByLabel('source value', { exact: true }).fill('Concurrent text'); await save(other);
  await expect(page.locator('.graph-state-notice')).toContainText('Saved graph changed elsewhere');
  // Recovery redraws must not accidentally bless the stale draft's revision.
  await page.reload(); await page.reload();
  await page.locator('#graph-save').click();
  await expect(page.locator('#graph-errors')).toContainText('Load saved before saving');
  await expect(page.locator('.graph-node')).toHaveCount(3);
  await page.getByRole('button', { name: 'Select source', exact: true }).click();
  await expect(page.getByLabel('source value', { exact: true })).toHaveValue('Recovered text');
  await page.getByRole('button', { name: 'Select subgraph', exact: true }).click();
  await page.locator('#graph-edit-subgraph').click();
  await page.getByRole('link', { name: 'Back to parent graph' }).click();
  await page.locator('#graph-save').click();
  await expect(page.locator('#graph-errors')).toContainText('Load saved before saving');
});

test('pending creation stays open until its library transaction completes', async ({ page }) => {
  const dialog = await openExtraction(page, false);
  await page.evaluate(async () => {
    const { LIBRARY_LOCK } = await import('/extension/graph-library.js');
    await new Promise(acquired => {
      globalThis.creationLock = navigator.locks.request(LIBRARY_LOCK, () => new Promise(release => {
        globalThis.releaseCreationLock = release; acquired();
      }));
    });
  });
  await dialog.locator('#graph-confirm-subgraph').click();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => globalThis.releaseCreationLock());
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.graph-node')).toHaveCount(3);
});
