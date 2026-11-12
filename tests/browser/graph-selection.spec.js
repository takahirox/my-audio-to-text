import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkSelectionAppearance, expectSelected, loadSelectionGraph } from '../fixtures/graph-selection.js';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))),
      contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
});

for (const identity of [
  { platform: 'macOS', legacy: 'MacIntel', modifier: 'Meta' },
  { platform: null, legacy: 'MacIntel', modifier: 'Meta' },
  { platform: '', legacy: 'macOS', modifier: 'Meta' },
  { platform: 'Windows', legacy: 'Win32', modifier: 'Control' },
  { platform: null, legacy: 'Linux x86_64', modifier: 'Control' },
]) test(`heading modifiers with platform ${identity.platform ?? 'unavailable'} / ${identity.legacy}`, async ({ page }) => {
  await page.addInitScript(({ platform, legacy }) => {
    Object.defineProperty(navigator, 'userAgentData', { value: platform === null ? undefined : { platform } });
    Object.defineProperty(navigator, 'platform', { value: legacy });
  }, identity);
  await page.goto('/extension/graph-editor.html'); await loadSelectionGraph(page);
  const source = page.getByRole('button', { name: 'Select source', exact: true });
  const hold = page.getByRole('button', { name: 'Select hold', exact: true });
  const output = page.getByRole('button', { name: 'Select output', exact: true });
  await expect(source).toHaveAttribute('title', new RegExp(identity.modifier === 'Meta' ? 'Command' : 'Ctrl'));
  const positions = await page.locator('.graph-node').evaluateAll(cards => cards.map(card => [card.style.left, card.style.top]));
  // macOS turns real Ctrl+click into a secondary click even with a Windows
  // navigator identity. Supply Windows/Linux primary-button events explicitly
  // on that host; Shift and macOS Command paths still use trusted input.
  const emulateControl = process.platform === 'darwin' && identity.modifier === 'Control';
  const modifierClick = async heading => {
    if (!emulateControl) return heading.click({ modifiers: [identity.modifier] });
    await heading.dispatchEvent('pointerdown', { button: 0, pointerId: 1, ctrlKey: true, pointerType: 'mouse' });
    await heading.dispatchEvent('pointerup', { button: 0, pointerId: 1, ctrlKey: true, pointerType: 'mouse' });
    await heading.dispatchEvent('click', { button: 0, ctrlKey: true });
  };
  await source.click(); await expectSelected(page, ['source']);
  await modifierClick(output); await expectSelected(page, ['source', 'output']);
  await source.press('Shift'); // Retain keyboard modality before modifier click.
  await modifierClick(source); await expectSelected(page, ['output']);
  await expect(source).toHaveCSS('outline-style', 'none');
  await hold.click({ modifiers: ['Shift'] });
  // DOM order differs from last-selected order here; the Inspector follows the
  // most recent selection, then falls back to the last remaining selection.
  await expect(page.locator('.selected-node')).toHaveCount(2);
  await expect(page.locator('.graph-inspector')).toContainText('Instance ID: hold');
  await hold.click({ modifiers: ['Shift'] }); await expectSelected(page, ['output']);
  await output.click(); await expectSelected(page, []);
  await output.click(); await expectSelected(page, ['output']);
  // Releasing the modifier between press and click must preserve the toggle,
  // and moving while holding the modifier must never start a node drag.
  const box = await source.boundingBox();
  if (emulateControl) {
    await source.dispatchEvent('pointerdown', { button: 0, pointerId: 1, ctrlKey: true, clientX: box.x + 15, clientY: box.y + 15 });
    await source.dispatchEvent('pointermove', { pointerId: 1, clientX: box.x + 35, clientY: box.y + 20 });
    await source.dispatchEvent('pointerup', { button: 0, pointerId: 1 });
    await source.dispatchEvent('click', { button: 0 });
  } else {
    await page.keyboard.down(identity.modifier); await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
    await page.mouse.move(box.x + 35, box.y + 20, { steps: 3 });
    await page.keyboard.up(identity.modifier); await page.mouse.up();
  }
  await expectSelected(page, ['source', 'output'], 'source');
  expect(await page.locator('.graph-node').evaluateAll(cards => cards.map(card => [card.style.left, card.style.top]))).toEqual(positions);
  if (identity.modifier === 'Meta') {
    // Native macOS Ctrl+click may surface as a secondary click; neither path
    // may toggle selection or prevent the native context-menu default.
    await page.evaluate(() => {
      globalThis.contextClick = null;
      document.addEventListener('contextmenu', event => { globalThis.contextClick = { prevented: event.defaultPrevented }; });
    });
    await hold.click({ modifiers: ['Control'] });
    await hold.click({ button: 'right', modifiers: ['Control'] });
    await expect(page.locator('.selected-node')).toHaveCount(2);
    await expect(hold).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate(() => globalThis.contextClick)).toEqual({ prevented: false });
    await page.keyboard.press('Escape');
  }
  await source.click(); await expectSelected(page, ['source']);
});

test('selection has stable heading geometry and separate keyboard focus', async ({ page }, info) => {
  await page.goto('/extension/graph-editor.html'); await checkSelectionAppearance(page, info);
});

test('macOS Command selection can create a subgraph with its connections intact', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' } }));
  await page.goto('/extension/graph-editor.html'); await loadSelectionGraph(page);
  await page.getByRole('button', { name: 'Select source', exact: true }).click();
  await page.getByRole('button', { name: 'Select hold', exact: true }).click({ modifiers: ['Meta'] });
  await expectSelected(page, ['source', 'hold']);
  await page.locator('#graph-create-subgraph').click();
  const dialog = page.getByRole('dialog', { name: 'Create Subgraph', exact: true });
  await dialog.getByLabel('Subgraph name', { exact: true }).fill('Command selection');
  await dialog.locator('#graph-confirm-subgraph').click(); await expect(dialog).toHaveCount(0);
  await expect(page.locator('.graph-node')).toHaveCount(2);
  await expect(page.locator('.selected-node .graph-heading')).toHaveText('Command selection');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-library-v1')));
  const shared = stored.graphs.find(entry => entry.kind === 'subgraph');
  expect(shared.graph.nodes.map(node => node.id)).toEqual(['source', 'hold']);
  expect(shared.graph.edges).toEqual([{ from: ['source', 'value'], to: ['hold', 'input'] }]);
  const parent = stored.graphs.find(entry => entry.id === stored.assignments.live);
  expect(parent.graph.edges).toEqual([{ from: ['subgraph', 'out1'], to: ['output', 'input1'] }]);
});
