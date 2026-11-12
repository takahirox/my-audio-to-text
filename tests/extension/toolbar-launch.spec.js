import { test, expect, create, library } from './library-fixture.js';
import { graphNode, edge } from '../../extension/graph.js';

const simple = text => {
  const node = graphNode('Text', 'source'); node.settings.value = text;
  return { version: 15, nodes: [node, graphNode('Display', 'display')], edges: [edge('source', 'value', 'display', 'input1')] };
};
const summary = text => {
  const graph = simple(text); graph.nodes.push(graphNode('TextSummaryLfm2', 'summary'));
  graph.edges = [edge('source', 'value', 'summary', 'text'), edge('summary', 'summary', 'display', 'input1')];
  return graph;
};
const menu = async (f, menuItemId, tabId = 123) => f.worker.evaluate(({ menuItemId, tabId }) => toolbarEvents.menu({ menuItemId }, { id: tabId }), { menuItemId, tabId });
const choices = f => f.worker.evaluate(() => Object.values(toolbarMenus));
async function waitMenu(f, id, title) {
  await expect.poll(async () => (await choices(f)).find(item => item.id === id)?.title).toBe(title);
}
async function open(f, id, tab = 123) {
  const opened = f.context.waitForEvent('page', { predicate: page => page.url().includes('recorder.html') });
  await menu(f, 'live-run:' + id, tab);
  const live = await opened; await live.waitForLoadState(); return live;
}
async function clickAction(f, tabId) {
  const opened = f.context.waitForEvent('page', { predicate: page => page.url().includes('recorder.html') });
  await f.worker.evaluate(tabId => toolbarEvents.action({ id: tabId }), tabId);
  const live = await opened; await live.waitForLoadState(); return live;
}
async function save(page, id, graph) {
  await page.evaluate(async ({ id, graph }) => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).save(id, entry.revision, graph);
  }, { id, graph });
}

test('native Graphs → Open remembers selections, refreshes names and preserves independent invoking tabs', async ({ libraryExtension: f }) => {
  const a = await create(f.page, 'A', simple('A')), b = await create(f.page, 'B', simple('B'));
  const draft = await create(f.page, 'Unconnected', { version: 15, nodes: [graphNode('Text', 'parked')], edges: [] });
  await waitMenu(f, 'live-run:' + a, 'A');
  await expect.poll(async () => (await choices(f)).map(({ id, parentId, title, type }) => ({ id, parentId, title, type }))).toEqual([
    { id: 'live-graphs', title: 'Graphs' },
    { id: 'live-open', parentId: 'live-graphs', title: 'Open' },
    { id: 'live-run:' + a, parentId: 'live-open', title: 'A', type: 'radio' },
    { id: 'live-run:' + b, parentId: 'live-open', title: 'B', type: 'radio' },
    { id: 'live-run:default-live', parentId: 'live-open', title: 'Live transcription', type: 'radio' },
    { id: 'live-library', parentId: 'live-graphs', title: 'Graph Library' },
  ]);
  expect((await choices(f)).some(item => item.id === 'live-run:' + draft)).toBe(false);
  expect((await choices(f)).every(item => item.contexts.join() === 'action')).toBe(true);
  // Building/reading menus never changes a valid selection or opens a window.
  expect((await library(f.page)).assignments.live).toBe('default-live');
  expect(f.context.pages().filter(page => page.url().includes('recorder.html'))).toHaveLength(0);
  const first = await open(f, a, 41), second = await open(f, b, 42), third = await clickAction(f, 43);
  await expect.poll(async () => (await choices(f)).filter(item => item.checked).map(item => item.id)).toEqual(['live-run:' + b]);
  expect((await library(f.page)).assignments.live).toBe(b);
  for (const [page, name] of [[first, 'A'], [second, 'B'], [third, 'B']]) {
    await expect(page.locator('#live-graph-name')).toHaveText(name);
    await expect(page).toHaveTitle(name);
  }
  const states = await Promise.all([first, second, third].map(page => page.evaluate(async () => ({
    url: location.href, windowId: (await chrome.windows.getCurrent()).id,
    state: document.querySelector('#session-state').textContent,
  }))));
  expect(new Set(states.map(state => state.windowId)).size).toBe(3);
  expect(new Set(states.map(state => new URL(state.url).searchParams.get('session'))).size).toBe(3);
  expect(states.map(state => new URL(state.url).searchParams.get('tab'))).toEqual(['41', '42', '43']);
  expect(states.every(state => state.state === 'Idle')).toBe(true);
  await f.page.evaluate(async id => {
    const { GraphLibrary, readLibrary } = await import('./graph-library.js');
    const entry = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    await new GraphLibrary(localStorage).rename(id, '0 Renamed B', '', entry.revision);
  }, b);
  await waitMenu(f, 'live-run:' + b, '0 Renamed B');
  expect((await library(f.page)).assignments.live).toBe(b);
  await expect(second).toHaveTitle('0 Renamed B');
  await first.reload(); await expect(first.locator('#live-graph-name')).toHaveText('A');
  const editor = await f.context.newPage(); await editor.goto(f.url + `graph-editor.html?id=${b}`);
  const badge = editor.locator('.graph-toolbar .graph-activity');
  await second.locator('#start').click(); await third.locator('#start').click();
  await expect(badge).toBeVisible();
  await open(f, a, 44);
  expect((await library(f.page)).assignments.live).toBe(a);
  for (const [page, name] of [[first, 'A'], [second, '0 Renamed B'], [third, '0 Renamed B']]) {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page).toHaveTitle(name);
  }
  await second.locator('#stop').click(); await expect(badge).toBeVisible();
  await editor.reload(); await expect(badge).toBeVisible();
  await third.close(); await expect(badge).toBeHidden();
  const fourth = await clickAction(f, 45); await expect(fourth.locator('#live-graph-name')).toHaveText('A');
});

test('Edit graph targets its own idle or running window independently of the toolbar default and other sessions', async ({ libraryExtension: f }) => {
  const a = await create(f.page, 'A', simple('A')), b = await create(f.page, 'B', simple('B'));
  const first = await open(f, a, 41), second = await open(f, b, 42);
  // Opening B also selects it for the toolbar. Set A after both windows exist
  // so this navigation regression keeps B distinct from the current selection.
  await f.page.evaluate(async id => {
    const { GraphLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).assign('live', id);
  }, a);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(a);
  await expect(first.locator('#start')).toBeEnabled();
  await first.locator('#start').click();
  await expect(first.locator('#session-state')).toHaveText('Running');
  const originalURL = second.url();
  const edit = second.getByRole('link', { name: 'Edit graph', exact: true });
  await expect(second.locator('nav a')).toHaveText(['Library', 'Edit graph', 'Models']);
  const target = `graph-editor.html?id=${encodeURIComponent(b)}`;
  async function assertTargets() {
    // Includes error recovery and Edit outputs, even when those links are hidden.
    for (const link of await second.locator('[data-graph-editor]').all()) {
      await expect(link).toHaveAttribute('href', target);
      await expect(link).toHaveAttribute('data-page', target);
    }
    await expect(edit).toHaveAttribute('href', target);
  }
  async function openEditor(keyboard = false) {
    await assertTargets();
    const opened = f.context.waitForEvent('page');
    if (keyboard) { await edit.focus(); await edit.press('Enter'); }
    else await edit.click();
    const editor = await opened;
    await expect(editor).toHaveURL(f.url + target);
    await expect(editor.locator('#graph-name')).toHaveText('B');
    await expect(editor.locator('nav a')).toHaveText(['Library', 'Models']);
    await expect(editor.locator('nav button, nav [aria-current], #navigation-status')).toHaveCount(0);
    expect(second.url()).toBe(originalURL);
    await expect(first.locator('#session-state')).toHaveText('Running');
    expect((await library(f.page)).assignments.live).toBe(a);
    return editor;
  }
  // Idle B must not open A, even though A is both the default and first recorder.
  const idleEditor = await openEditor(true);
  await expect(second.locator('#session-state')).toHaveText('Idle');
  await idleEditor.close();
  await second.locator('#start').click();
  await expect(second.locator('#session-state')).toHaveText('Running');
  await expect(second.locator('#live-displays')).toContainText('B');
  await save(f.page, b, simple('B edited'));
  await expect(second.locator('#saved-state')).toContainText('Next session: B');
  const editor = await openEditor();
  await expect(second.locator('#session-state')).toHaveText('Running');
  await expect(second.locator('#live-displays')).not.toContainText('B edited');
  // The remaining editor destinations work through the existing navigation paths.
  const modelsOpened = f.context.waitForEvent('page');
  await editor.getByRole('link', { name: 'Models', exact: true }).press('Enter');
  const models = await modelsOpened;
  await expect(models).toHaveURL(f.url + 'model-cache.html');
  await models.close();
  await editor.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(editor).toHaveURL(f.url + 'graph-library.html');
  await expect(first.locator('#session-state')).toHaveText('Running');
  await expect(second.locator('#session-state')).toHaveText('Running');
  await second.locator('#stop').click();
  await expect(second.locator('#start')).toBeEnabled();
  await assertTargets();
  const stoppedEditor = await openEditor();
  await expect(second.locator('#session-state')).toHaveText('Completed');
  await stoppedEditor.close();
  await first.locator('#stop').click();
});

test('three simultaneous sessions keep graph snapshots, independent workers, Stop, failure, and close cleanup', async ({ libraryExtension: f }) => {
  const ids = [];
  for (const text of ['A', 'B', 'C']) ids.push(await create(f.page, text, summary(text)));
  const pages = [];
  for (const [index, id] of ids.entries()) pages.push(await open(f, id, index + 20));
  for (const page of pages) { await expect(page.locator('#start')).toBeEnabled(); await page.locator('#start').click(); await expect(page.locator('#session-state')).toHaveText('Running'); }
  for (const page of pages) await expect(page.locator('#live-displays')).toContainText('Summary from selected graph');
  await save(f.page, ids[1], simple('B edited'));
  await expect(pages[1].locator('#saved-state')).toContainText('Next session: B');
  await expect(pages[1].locator('#live-displays')).not.toContainText('B edited');
  await pages[0].locator('#stop').click();
  await expect(pages[0].locator('#start')).toBeEnabled();
  await expect(pages[1].locator('#session-state')).toHaveText('Running');
  await pages[0].close();
  await expect(pages[2].locator('#session-state')).toHaveText('Running');
  await pages[1].evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'Controlled window failure' })));
  await expect(pages[1].locator('#errors')).toContainText('Controlled window failure');
  await expect(pages[2].locator('#session-state')).toHaveText('Running');
  // Delete C while running: snapshot continues, but next Start is rejected.
  await f.page.evaluate(async id => {
    const { GraphLibrary } = await import('./graph-library.js'); await new GraphLibrary(localStorage).delete(id);
  }, ids[2]);
  await expect(pages[2].locator('#errors')).toContainText('no longer exists');
  await expect(pages[2].locator('#session-state')).toHaveText('Running');
  await pages[2].locator('#stop').click();
  await expect(pages[2].locator('#start')).toBeDisabled();
  await expect.poll(() => pages[2].evaluate(() => modelWorkers.every(worker => worker.released))).toBe(true);
});

test('missing/deleted/invalid selections fall back by name; stale Open IDs never substitute', async ({ libraryExtension: f }) => {
  const a = await create(f.page, 'A', simple('A'));
  const b = await create(f.page, 'B', simple('B'));
  await f.page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).change(library => { library.assignments.live = 'deleted'; });
  });
  const missing = await clickAction(f, 51);
  await expect(missing.locator('#live-graph-name')).toHaveText('A');
  expect((await library(f.page)).assignments.live).toBe(a);
  const stale = await open(f, 'deleted', 52);
  await expect(stale.locator('#errors')).toContainText('Graph selection could not be confirmed');
  await expect(stale.locator('#errors')).toContainText('Graph Library');
  await expect(stale.locator('#start')).toBeDisabled();
  expect((await library(f.page)).assignments.live).toBe(a);
  await save(f.page, a, { version: 15, nodes: [graphNode('Text', 'parked')], edges: [] });
  await expect.poll(async () => (await choices(f)).some(item => item.id === 'live-run:' + a)).toBe(false);
  const invalid = await open(f, a, 53);
  await expect(invalid.locator('#errors')).toContainText('cannot run');
  await expect(invalid.locator('#start')).toBeDisabled();
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(b);
  await expect.poll(async () => (await choices(f)).filter(item => item.checked).map(item => item.id)).toEqual(['live-run:' + b]);
  await f.page.evaluate(async id => {
    const { GraphLibrary } = await import('./graph-library.js'); await new GraphLibrary(localStorage).delete(id);
  }, b);
  const remaining = await clickAction(f, 54);
  await expect(remaining.locator('#live-graph-name')).toHaveText('Live transcription');
  expect((await library(f.page)).assignments.live).toBe('default-live');
});

test('unset selection uses the same numeric, kana and stable tie order as Open without writes on reads', async ({ libraryExtension: f }) => {
  await f.page.evaluate(async graph => {
    const { GraphLibrary } = await import('./graph-library.js');
    const store = new GraphLibrary(localStorage);
    for (const [id, name] of [['kana-i', 'い'], ['kana-a', 'あ'], ['z-tie', 'Same'], ['a-tie', 'Same'], ['n10', 'Graph 10'], ['n2', 'Graph 2']]) {
      await store.create({ id, name, graph });
    }
    await store.change(library => { library.assignments.live = null; });
  }, simple('Ordered'));
  await expect.poll(async () => (await choices(f)).filter(item => item.type === 'radio').map(item => item.id)).toEqual([
    'live-run:n2', 'live-run:n10', 'live-run:default-live', 'live-run:a-tie', 'live-run:z-tie', 'live-run:kana-a', 'live-run:kana-i',
  ]);
  await expect.poll(async () => (await choices(f)).filter(item => item.checked).map(item => item.id)).toEqual(['live-run:n2']);
  expect((await library(f.page)).assignments.live).toBe('n2');
  const revision = (await library(f.page)).revision;
  const first = await clickAction(f, 56);
  await expect(first.locator('#live-graph-name')).toHaveText('Graph 2');
  const second = await clickAction(f, 57);
  await expect(second.locator('#live-graph-name')).toHaveText('Graph 2');
  const repeated = await open(f, 'n2', 58);
  await expect(repeated.locator('#live-graph-name')).toHaveText('Graph 2');
  expect((await library(f.page)).revision).toBe(revision);
  await f.page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).change(library => {
      library.graphs = library.graphs.filter(entry => entry.id.startsWith('kana-'));
      library.assignments.live = null;
    });
  });
  await expect.poll(async () => (await choices(f)).filter(item => item.checked).map(item => item.id)).toEqual(['live-run:kana-a']);
  const kana = await clickAction(f, 59); await expect(kana.locator('#live-graph-name')).toHaveText('あ');
  await f.restart();
  await expect.poll(async () => (await choices(f)).filter(item => item.checked).map(item => item.id)).toEqual(['live-run:kana-a']);
  expect((await library(f.page)).assignments.live).toBe('kana-a');
});

test('no runnable graphs keep Open empty, left-click errors visible and Graph Library reachable', async ({ libraryExtension: f }) => {
  await f.page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).change(library => { library.graphs[0].graph = null; library.assignments.live = null; });
  });
  await expect.poll(async () => (await choices(f)).find(item => item.id === 'live-empty')?.enabled).toBe(false);
  expect((await choices(f)).find(item => item.id === 'live-empty').parentId).toBe('live-open');
  const empty = await clickAction(f, 55);
  await expect(empty.locator('#errors')).toContainText('No runnable graphs');
  await expect(empty.locator('#errors')).toContainText('Graphs → Graph Library');
  await expect(empty.locator('#start')).toBeDisabled();
  expect((await library(f.page)).assignments.live).toBeNull();
  const opened = f.context.waitForEvent('page', { predicate: page => page.url().includes('graph-library.html') });
  await menu(f, 'live-library'); const page = await opened;
  await expect(page.locator('#graph-list button[data-id]')).toHaveCount(1);
});

test('last Open selection survives a browser/worker restart and the native menus are reconstructed', async ({ libraryExtension: f }) => {
  const id = await create(f.page, 'Persisted', simple('saved'));
  await open(f, id);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(id);
  await f.restart();
  await waitMenu(f, 'live-run:' + id, 'Persisted');
  await expect.poll(async () => (await choices(f)).find(item => item.id === 'live-run:' + id)?.checked).toBe(true);
  const live = await clickAction(f, 61); await expect(live.locator('#live-graph-name')).toHaveText('Persisted');
});

test('real toolbar action retains activeTab for the invoking field despite later focus changes', async ({ libraryExtension: f }) => {
  f.allowedRemote.push('https://toolbar.test/');
  await f.context.route('https://toolbar.test/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="target"></textarea>' }));
  const graph = simple('Chosen target'); graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'));
  graph.edges.push(edge('source', 'value', 'field', 'text'));
  const id = await create(f.page, 'Field output', graph);
  await open(f, id);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(id);
  const target = await f.context.newPage(); await target.goto('https://toolbar.test/invoked'); await target.locator('#target').focus();
  const other = await f.context.newPage(); await other.goto('https://toolbar.test/other');
  const cdp = await f.context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const invoking = targetInfos.find(info => info.url === target.url());
  await target.bringToFront();
  const opened = f.context.waitForEvent('page', { predicate: page => page.url().includes('recorder.html') });
  await cdp.send('Extensions.triggerAction', { id: new URL(f.url).host, targetId: invoking.targetId });
  const live = await opened;
  await expect(live.locator('#live-graph-name')).toHaveText('Field output');
  await expect(live.locator('#start')).toBeEnabled();
  await expect(target.locator('#target')).toHaveValue('');
  await other.bringToFront(); await other.locator('#target').focus();
  await live.locator('#start').click();
  await expect(target.locator('#target')).toHaveValue('Chosen target');
  await expect(other.locator('#target')).toHaveValue('');
  await live.locator('#stop').click();
});
