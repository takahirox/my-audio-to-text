import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// Real editor, Web Locks, storage and navigation. No model or audio needed.
async function serve(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.fulfill({ status: 404, body: '' });
  await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
}
const graph = page => page.evaluate(async () => { const { readLibrary } = await import('/extension/graph-library.js'); const lib = readLibrary(localStorage); return lib.graphs.find(entry => entry.id === new URLSearchParams(location.search).get('id')).graph; });
async function open(page) { await page.route('**/*', serve); await page.goto('http://localhost:8765/extension/graph-editor.html'); await expect(page.locator('#graph-state')).toHaveText('Saved'); }
async function saved(page) { await page.locator('#graph-state').click(); await expect(page.locator('#graph-state')).toHaveText('Saved'); }
async function add(page, type) {
  await page.locator('#graph-palette-toggle').click(); await page.getByLabel('Search nodes', { exact: true }).fill(type);
  await page.locator(`[role=option][data-type="${type}"]`).click();
}
test.beforeEach(async ({ page }) => { await open(page); });
test('Auto Save, grouped typing, Undo/Redo, no-op revisions, native input shortcuts, IME and empty history after reopen', async ({ page }) => {
  await expect(page.locator('#graph-save, #graph-load')).toHaveCount(0);
  await expect(page.locator('#graph-undo')).toBeDisabled(); await add(page, 'Text');
  const text = page.getByLabel('text value', { exact: true });
  await text.pressSequentially('a continuous edit'); await saved(page);
  expect((await graph(page)).nodes.at(-1).settings.value).toBe('a continuous edit');
  await page.locator('#graph-undo').click(); await saved(page); expect((await graph(page)).nodes.at(-1).settings.value).toBe('');
  await page.locator('#graph-redo').click(); await saved(page); expect((await graph(page)).nodes.at(-1).settings.value).toBe('a continuous edit');
  const field = page.getByLabel('text value', { exact: true }); await field.focus();
  const before = await page.locator('#graph-undo').isEnabled();
  expect(await field.evaluate(control => { const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }); control.dispatchEvent(event); return event.defaultPrevented; })).toBe(false);
  expect(await page.locator('#graph-undo').isEnabled()).toBe(before);
  await field.dispatchEvent('compositionstart'); await field.fill('日本語');
  await field.dispatchEvent('keydown', { key: 'z', ctrlKey: true, isComposing: true }); await field.dispatchEvent('compositionend');
  await saved(page); expect((await graph(page)).nodes.at(-1).settings.value).toBe('日本語');
  await page.locator('#graph-undo').click(); await saved(page); expect((await graph(page)).nodes.at(-1).settings.value).toBe('a continuous edit');
  await page.locator('.graph-scroll').focus(); await page.keyboard.press('Control+z'); await saved(page);
  expect((await graph(page)).nodes.at(-1).settings.value).toBe('');
  await page.keyboard.press('Control+Shift+z'); await saved(page);
  expect((await graph(page)).nodes.at(-1).settings.value).toBe('a continuous edit');
  const revision = () => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')).graphs[0].revision);
  const previous = await revision(); await page.getByLabel('text value', { exact: true }).fill('a continuous edit'); await saved(page);
  expect(await revision()).toBe(previous);
  await page.reload(); await expect(page.locator('#graph-state')).toHaveText('Saved'); await expect(page.locator('#graph-undo')).toBeDisabled();
});
test('one pointer drag and keyboard burst are single steps and Undo itself persists', async ({ page }) => {
  const before = await graph(page), heading = page.getByRole('button', { name: 'Select audio', exact: true });
  const box = await heading.boundingBox(); await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 95, box.y + 55, { steps: 20 }); await page.mouse.up(); await saved(page);
  await page.locator('#graph-undo').click(); await saved(page); expect(await graph(page)).toEqual(before);
  await expect(page.locator('#graph-undo')).toBeDisabled();
  await heading.press('ArrowRight'); await heading.press('ArrowRight'); await heading.press('ArrowDown'); await saved(page);
  await page.locator('#graph-undo').click(); await saved(page); expect(await graph(page)).toEqual(before);
});
test('same graph has one writer, viewer guards all mutations, explicit acquisition reloads newest; different graph remains editable', async ({ page }) => {
  const viewer = await page.context().newPage(); await viewer.route('**/*', serve); await viewer.goto(page.url());
  await expect(viewer.locator('#graph-state')).toHaveText('Read-only'); await expect(viewer.locator('#graph-palette-toggle')).toBeDisabled();
  const original = await graph(page); await viewer.getByRole('button', { name: 'Select audio', exact: true }).click(); await viewer.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight');
  await expect(viewer.getByRole('button', { name: 'Remove audio', exact: true })).toBeDisabled();
  await expect(viewer.locator('#graph-undo')).toBeDisabled(); expect(await graph(viewer)).toEqual(original);
  await page.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight'); await saved(page);
  await page.close(); await viewer.getByRole('button', { name: 'Start editing', exact: true }).click();
  await expect(viewer.locator('#graph-state')).toHaveText('Saved'); await expect(viewer.locator('#graph-palette-toggle')).toBeEnabled();
  expect((await graph(viewer)).nodes[0].position.x).toBe(original.nodes[0].position.x + 10); await expect(viewer.locator('#graph-undo')).toBeDisabled();
  const id = await viewer.evaluate(async () => (await new (await import('/extension/graph-library.js')).GraphLibrary(localStorage).create({ name: 'Other' })).graphs.at(-1).id);
  const other = await viewer.context().newPage(); await other.route('**/*', serve); await other.goto(`http://localhost:8765/extension/graph-editor.html?id=${id}`);
  await expect(other.locator('#graph-palette-toggle')).toBeEnabled(); await expect(viewer.locator('#graph-palette-toggle')).toBeEnabled();
});
test('close during pending typing checkpoints recovery; navigation flushes the last edit', async ({ page }) => {
  await add(page, 'Text'); await saved(page); const url = page.url();
  await page.getByLabel('text value', { exact: true }).fill('recover after close'); await page.close();
  const next = await page.context().newPage(); await next.route('**/*', serve); await next.goto(url);
  await expect(next.locator('#graph-state')).toHaveText('Saved');
  // pagehide may have persisted already; otherwise explicit recovery is offered.
  if ((await graph(next)).nodes.at(-1).settings.value !== 'recover after close') {
    await next.getByText('Recoverable draft available', { exact: true }).click(); await next.getByRole('button', { name: 'Restore draft', exact: true }).click(); await saved(next);
  }
  expect((await graph(next)).nodes.at(-1).settings.value).toBe('recover after close');
  await next.getByRole('button', { name: 'Select text', exact: true }).click(); await next.getByLabel('text value', { exact: true }).fill('navigation flush');
  await next.getByRole('link', { name: 'Library', exact: true }).click(); await expect(next).toHaveURL(/graph-library.html/);
  await next.goto(url); expect((await graph(next)).nodes.at(-1).settings.value).toBe('navigation flush');
});
test('invalid number retains good saved graph, checkpoints invalid draft, exposes failure and retries when repaired', async ({ page }) => {
  await add(page, 'Number'); await saved(page); const before = await graph(page);
  await page.getByLabel('number value', { exact: true }).fill(''); await page.locator('#graph-state').click();
  await expect(page.locator('#graph-state')).toHaveText('Save failed'); await expect(page.locator('#graph-save-error')).toContainText('finite number');
  expect(await graph(page)).toEqual(before); await expect(page.locator('#graph-retry')).toBeVisible();
  await page.getByLabel('number value', { exact: true }).fill('42'); await saved(page); expect((await graph(page)).nodes.at(-1).settings.value).toBe(42);
});

test('failed persistence blocks app navigation, keeps an exportable recovery copy, and retry clears it only after success', async ({ page }) => {
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) { if (key === 'processing-graph-library-v1') throw Error('fixture write denied'); return set.call(this, key, value); };
    window.restoreStorage = () => { Storage.prototype.setItem = set; };
  });
  await add(page, 'Text'); await page.getByLabel('text value', { exact: true }).fill('recoverable failed save');
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await expect(page.locator('#errors')).toContainText('Navigation blocked'); await expect(page).toHaveURL(/graph-editor/);
  await expect(page.locator('#graph-state')).toHaveText('Save failed');
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('processing-graph-draft:')))).toBe(true);
  await page.evaluate(() => window.restoreStorage()); await page.locator('#graph-retry').click(); await saved(page);
  expect((await graph(page)).nodes.at(-1).settings.value).toBe('recoverable failed save');
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('processing-graph-draft:')))).toBe(false);
});
test('older-base recovery cannot overwrite a newer revision and quota failures stay visible', async ({ page }) => {
  const original = await graph(page);
  await page.evaluate(async original => {
    const { readLibrary, GraphLibrary } = await import('/extension/graph-library.js'); const lib = readLibrary(localStorage), entry = lib.graphs[0];
    const graph = structuredClone(original); graph.nodes[0].position.x += 100;
    localStorage.setItem('processing-graph-draft:test', JSON.stringify({ id: entry.id, base: entry.revision, sessionId: 'old', graph, updatedAt: Date.now() }));
    graph.nodes[0].position.x += 10; await new GraphLibrary(localStorage).save(entry.id, entry.revision, graph);
  }, original);
  await page.reload(); await page.getByText('Older-base draft available (export only)', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restore draft', exact: true })).toBeDisabled();
  expect((await graph(page)).nodes[0].position.x).toBe(original.nodes[0].position.x + 110);
  await page.evaluate(() => { Storage.prototype.setItem = function() { throw Error('quota exceeded'); }; });
  await add(page, 'Text'); await page.getByLabel('text value', { exact: true }).fill('cannot checkpoint'); await page.locator('#graph-state').click();
  await expect(page.locator('#graph-state')).toHaveText('Save failed');
  await expect(page.locator('#graph-save-error')).toContainText(/quota|checkpoint/);
});

test('unrelated graph saves preserve a composing input, its caret and its pending text', async ({ page }) => {
  await add(page, 'Text'); await saved(page); const field = page.getByLabel('text value', { exact: true });
  await field.focus(); await field.fill('composing text'); await field.dispatchEvent('compositionstart');
  await field.evaluate(control => { window.composingControl = control; control.setSelectionRange(3, 7); });
  await page.evaluate(() => { window.nextStorage = new Promise(resolve => addEventListener('storage', event => { if (event.key === 'processing-graph-library-v1') resolve(); }, { once: true })); });
  const other = await page.context().newPage(); await other.route('**/*', serve); await other.goto(page.url());
  await other.evaluate(async () => { await new (await import('/extension/graph-library.js')).GraphLibrary(localStorage).create({ name: 'Independent graph' }); });
  await page.evaluate(() => window.nextStorage);
  expect(await field.evaluate(control => ({ same: control === window.composingControl, start: control.selectionStart, end: control.selectionEnd, value: control.value }))).toEqual({ same: true, start: 3, end: 7, value: 'composing text' });
  await field.dispatchEvent('compositionend'); await saved(page);
  expect((await graph(page)).nodes.at(-1).settings.value).toBe('composing text');
});
