import { test, expect, library } from './library-fixture.js';

async function openParent(f, id, tabId) {
  const opened = f.context.waitForEvent('page', { predicate: page => page.url().includes('recorder.html') });
  await f.worker.evaluate(({ id, tabId }) => toolbarEvents.menu({ menuItemId: 'live-run:' + id }, { id: tabId }), { id, tabId });
  const live = await opened; await live.waitForLoadState(); return live;
}

test('toolbar parent windows resolve shared edits on next Start while independent active snapshots stay intact', async ({ libraryExtension: f }) => {
  const { page, context, url } = f;
  const ids = await page.evaluate(async () => {
    const { graphNode, edge } = await import('./graph.js');
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const source = graphNode('Text', 'source'); source.settings.value = 'A';
    const format = graphNode('TextFormatter', 'format', 340, 30); format.settings.template = 'Before: {1}';
    const extracted = extractSubgraph({ version: 15, nodes: [source, format, graphNode('Display', 'display', 700, 30)],
      edges: [edge('source', 'value', 'format', 'input1'), edge('format', 'text', 'display', 'input1')] }, ['format'], 'shared');
    const store = new GraphLibrary(localStorage);
    await store.create({ name: 'Shared formatter', kind: 'subgraph', id: 'shared', graph: extracted.shared });
    let saved = await store.create({ name: 'Parent A', graph: extracted.parent }); const first = saved.graphs.at(-1).id;
    extracted.parent.nodes.find(node => node.type === 'Text').settings.value = 'B';
    saved = await store.create({ name: 'Parent B', graph: extracted.parent }); const second = saved.graphs.at(-1).id;
    await store.assign('live', first, readLibrary(localStorage).revision);
    return { first, second };
  });
  const parents = (await library(page)).graphs.filter(entry => [ids.first, ids.second].includes(entry.id));
  const parentEditor = await context.newPage(); await parentEditor.goto(url + `graph-editor.html?id=${ids.first}`);
  await expect.poll(() => f.worker.evaluate(() => Object.values(toolbarMenus).filter(item => item.id.startsWith('live-run:')).map(item => item.id))).toContain('live-run:' + ids.first);
  expect(await f.worker.evaluate(() => Object.keys(toolbarMenus))).not.toContain('live-run:shared');
  const live = await openParent(f, ids.first, 41), other = await openParent(f, ids.second, 42);
  expect((await library(page)).assignments.live).toBe(ids.first);
  await other.locator('#start').click(); await expect(other.locator('#live-displays')).toContainText('Before: B');
  await live.locator('#start').click(); await expect(live.locator('#session-state')).toHaveText('Running');
  await expect(live.locator('#live-displays')).toContainText('Before: A');
  await expect(parentEditor.locator('.graph-state-notice')).toBeHidden();
  const shared = await context.newPage(); await shared.goto(url + 'graph-editor.html?id=shared');
  await shared.getByRole('button', { name: 'Select format', exact: true }).click();
  await shared.getByLabel('format template', { exact: true }).fill('After: {1}');
  await shared.locator('#graph-save').click(); await expect(shared.locator('#graph-state')).toHaveText('Saved');
  await expect(live.locator('#live-displays')).toContainText('Before: A');
  await expect(other.locator('#live-displays')).toContainText('Before: B');
  await expect(live.locator('#saved-state')).toContainText('Next session: Parent A');
  await expect(other.locator('#saved-state')).toContainText('Next session: Parent B');
  await expect(parentEditor.locator('#graph-state')).toHaveText('Saved');
  await expect(parentEditor.locator('.graph-state-notice')).toContainText('earlier graph');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await live.locator('#start').click(); await expect(live.locator('#live-displays')).toContainText('After: A');
  await expect(parentEditor.locator('.graph-state-notice')).toBeHidden();
  await expect(other.locator('#live-displays')).toContainText('Before: B');
  await other.locator('#stop').click(); await expect(other.locator('#start')).toBeEnabled();
  await other.locator('#start').click(); await expect(other.locator('#live-displays')).toContainText('After: B');
  await page.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign('live', id, readLibrary(localStorage).revision);
  }, ids.second);
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await live.reload();
  await live.locator('#start').click(); await expect(live.locator('#live-displays')).toContainText('After: A');
  await live.close();
  await expect(other.locator('#session-state')).toHaveText('Running');
  await expect(other.locator('#live-displays')).toContainText('After: B');
  await other.locator('#stop').click(); await expect(other.locator('#start')).toBeEnabled();
  expect((await library(page)).graphs.filter(entry => [ids.first, ids.second].includes(entry.id))).toEqual(parents);
  expect(await other.evaluate(() => window.modelWorkers.length)).toBe(0);
});

test('stale definition and incomplete parent selections show recoverable errors without starting a session', async ({ libraryExtension: f }) => {
  const id = await f.page.evaluate(async () => {
    const { graphNode, edge } = await import('./graph.js');
    const { GraphLibrary } = await import('./graph-library.js');
    const { extractSubgraph } = await import('./subgraphs.js');
    const extracted = extractSubgraph({ version: 15,
      nodes: [graphNode('Text', 'text'), graphNode('TextFormatter', 'format'), graphNode('Display', 'display')],
      edges: [edge('text', 'value', 'format', 'input1'), edge('format', 'text', 'display', 'input1')] }, ['format'], 'shared');
    const store = new GraphLibrary(localStorage);
    await store.create({ id: 'shared', name: 'Shared', kind: 'subgraph', graph: extracted.shared });
    extracted.parent.edges = [];
    return (await store.create({ name: 'Incomplete parent', graph: extracted.parent })).graphs.at(-1).id;
  });
  const incomplete = await openParent(f, id, 71);
  await expect(incomplete.locator('#errors')).toContainText('No executable path');
  await expect(incomplete.locator('#live-graph-name')).toHaveText('Incomplete parent');
  await expect(incomplete.locator('#start')).toBeDisabled();
  const definition = await openParent(f, 'shared', 72);
  await expect(definition.locator('#errors')).toContainText('Choose a parent graph');
  await expect(definition.locator('#start')).toBeDisabled();
  await f.page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    // Simulate externally corrupted storage to exercise a stale menu selection.
    await new GraphLibrary(localStorage).change(current => { current.graphs = current.graphs.filter(entry => entry.id !== 'shared'); });
  });
  const missing = await openParent(f, id, 73);
  await expect(missing.locator('#errors')).toContainText('Missing or invalid subgraph');
  await expect(missing.locator('#start')).toBeDisabled();
  for (const live of [incomplete, definition, missing]) {
    expect(await live.evaluate(() => modelWorkers.length)).toBe(0);
  }
});
