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

test('native action menu separates launch/default, filters drafts, refreshes names and preserves invoking tabs', async ({ libraryExtension: f }) => {
  const a = await create(f.page, 'A', simple('A')), b = await create(f.page, 'B', simple('B'));
  const draft = await create(f.page, 'Unconnected', { version: 15, nodes: [graphNode('Text', 'parked')], edges: [] });
  await waitMenu(f, 'live-run:' + a, 'Open A');
  expect((await choices(f)).some(item => item.id === 'live-run:' + draft)).toBe(false);
  expect((await choices(f)).filter(item => !item.parentId)).toHaveLength(1);
  expect((await choices(f)).every(item => item.contexts.join() === 'action')).toBe(true);
  await menu(f, 'live-default:' + a);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(a);
  expect(f.context.pages().filter(page => page.url().includes('recorder.html'))).toHaveLength(0);
  const first = await clickAction(f, 41), second = await open(f, b, 42), third = await open(f, a, 43);
  await expect(first.locator('#live-graph-name')).toHaveText('A');
  await expect(second.locator('#live-graph-name')).toHaveText('B');
  for (const [page, name] of [[first, 'A'], [second, 'B'], [third, 'A']]) await expect(page).toHaveTitle(name);
  expect((await library(f.page)).assignments.live).toBe(a);
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
    await new GraphLibrary(localStorage).rename(id, 'Renamed B', '', entry.revision);
  }, b);
  await waitMenu(f, 'live-run:' + b, 'Open Renamed B');
  await expect(second.getByRole('heading', { level: 1 })).toHaveText('Renamed B');
  await expect(second).toHaveTitle('Renamed B');
  await menu(f, 'live-default:' + b);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(b);
  await first.reload(); await expect(first.locator('#live-graph-name')).toHaveText('A');
  const editor = await f.context.newPage(); await editor.goto(f.url + `graph-editor.html?id=${a}`);
  const badge = editor.locator('.graph-toolbar .graph-activity');
  await first.locator('#start').click(); await third.locator('#start').click();
  await expect(badge).toBeVisible();
  // Changing the launch default must not relabel any existing window.
  await menu(f, 'live-default:' + a);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(a);
  for (const [page, name] of [[first, 'A'], [second, 'Renamed B'], [third, 'A']]) {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page).toHaveTitle(name);
  }
  await menu(f, 'live-default:' + b);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(b);
  await first.locator('#stop').click(); await expect(badge).toBeVisible();
  await editor.reload(); await expect(badge).toBeVisible();
  await third.close(); await expect(badge).toBeHidden();
  const fourth = await clickAction(f, 44); await expect(fourth.locator('#live-graph-name')).toHaveText('Renamed B');
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

test('missing or invalid default has an actionable path; stale menu IDs never substitute another graph', async ({ libraryExtension: f }) => {
  const a = await create(f.page, 'A', simple('A'));
  await create(f.page, 'B', simple('B'));
  await f.page.evaluate(async () => {
    const { GraphLibrary } = await import('./graph-library.js');
    await new GraphLibrary(localStorage).change(library => { library.assignments.live = 'deleted'; });
  });
  const missing = await clickAction(f, 51);
  await expect(missing.locator('#errors')).toContainText('Default for left-click');
  await expect(missing.locator('#start')).toBeDisabled();
  const stale = await open(f, 'deleted', 52);
  await expect(stale.locator('#errors')).toContainText('toolbar context menu');
  await expect(stale.locator('#start')).toBeDisabled();
  await save(f.page, a, { version: 15, nodes: [graphNode('Text', 'parked')], edges: [] });
  await expect.poll(async () => (await choices(f)).some(item => item.id === 'live-run:' + a)).toBe(false);
  const invalid = await open(f, a, 53);
  await expect(invalid.locator('#errors')).toContainText('No executable path');
  await expect(invalid.locator('#start')).toBeDisabled();
});

test('default survives a browser/worker restart and the native menus are reconstructed', async ({ libraryExtension: f }) => {
  const id = await create(f.page, 'Persisted', simple('saved'));
  await menu(f, 'live-default:' + id);
  await expect.poll(async () => (await library(f.page)).assignments.live).toBe(id);
  await f.restart();
  await waitMenu(f, 'live-run:' + id, 'Open Persisted');
  await expect.poll(async () => (await choices(f)).find(item => item.id === 'live-default:' + id)?.checked).toBe(true);
  const live = await clickAction(f, 61); await expect(live.locator('#live-graph-name')).toHaveText('Persisted');
});

test('real toolbar action retains activeTab for the invoking field despite later focus changes', async ({ libraryExtension: f }) => {
  f.allowedRemote.push('https://toolbar.test/');
  await f.context.route('https://toolbar.test/**', route => route.fulfill({ contentType: 'text/html', body: '<textarea id="target"></textarea>' }));
  const graph = simple('Chosen target'); graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'));
  graph.edges.push(edge('source', 'value', 'field', 'text'));
  const id = await create(f.page, 'Field output', graph);
  await menu(f, 'live-default:' + id);
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
