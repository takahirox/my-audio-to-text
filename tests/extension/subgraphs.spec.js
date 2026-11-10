import { test, expect, library } from './library-fixture.js';

test('shared saved definition updates two unchanged parents on next execution while an active Live snapshot stays intact', async ({ libraryExtension: f }) => {
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
  const live = await context.newPage(); await live.goto(url + 'recorder.html');
  await live.locator('#start').click(); await expect(live.locator('#session-state')).toHaveText('Running');
  await expect(live.locator('#live-displays')).toContainText('Before: A');
  await expect(parentEditor.locator('.graph-state-notice')).toBeHidden();
  const shared = await context.newPage(); await shared.goto(url + 'graph-editor.html?id=shared');
  await shared.getByRole('button', { name: 'Select format', exact: true }).click();
  await shared.getByLabel('format template', { exact: true }).fill('After: {1}');
  await shared.locator('#graph-save').click(); await expect(shared.locator('#graph-state')).toHaveText('Saved');
  await expect(live.locator('#live-displays')).toContainText('Before: A');
  await expect(parentEditor.locator('#graph-state')).toHaveText('Saved');
  await expect(parentEditor.locator('.graph-state-notice')).toContainText('earlier graph');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await live.locator('#start').click(); await expect(live.locator('#live-displays')).toContainText('After: A');
  await expect(parentEditor.locator('.graph-state-notice')).toBeHidden();
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await page.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign('live', id, readLibrary(localStorage).revision);
  }, ids.second);
  await live.locator('#start').click(); await expect(live.locator('#live-displays')).toContainText('After: B');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  expect((await library(page)).graphs.filter(entry => [ids.first, ids.second].includes(entry.id))).toEqual(parents);
  expect(await live.evaluate(() => window.modelWorkers.length)).toBe(0);
});
