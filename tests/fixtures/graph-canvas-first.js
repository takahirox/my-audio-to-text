import { expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { clickGraphAction } from '../extension/ui-controls.js';

export async function checkCanvasFirst(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await expect(page.locator('#graph-state')).toHaveText('Saved');
  await expect(page.locator('.graph-viewport-actions')).toHaveCount(0);
  const toolbar = page.locator('.graph-toolbar');
  const bounds = await toolbar.boundingBox();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  for (const [selector, name, text] of [
    ['#graph-palette-toggle', 'Add Node', 'Add Node'], ['#graph-undo', 'Undo', 'Undo'], ['#graph-redo', 'Redo', 'Redo'],
    ['.graph-actions > summary', 'Graph actions', '…'], ['#graph-help', 'Help', '?'],
  ]) {
    const control = page.locator(selector), box = await control.boundingBox();
    await expect(control).toHaveAccessibleName(name); await expect(control).toHaveText(text);
    expect(box.y).toBeGreaterThanOrEqual(bounds.y); expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scroll = page.locator('.graph-scroll'), navigation = page.getByRole('group', { name: 'Canvas navigation' });
  const canvas = await scroll.boundingBox(), controls = await navigation.boundingBox();
  expect(canvas.y - bounds.y - bounds.height).toBeLessThan(20);
  expect(controls.y + controls.height).toBeLessThan(canvas.y + canvas.height);
  expect(controls.x).toBeGreaterThan(canvas.x);
  await scroll.evaluate(el => { el.scrollLeft = 350; el.scrollTop = 150; });
  expect(await navigation.boundingBox()).toEqual(controls);
  await page.locator('#graph-zoom').selectOption('1.5');
  expect(await navigation.boundingBox()).toEqual(controls);
  await expect(page.getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Zoom out', exact: true }).press('Enter');
  await expect(page.locator('#graph-zoom')).toHaveValue('1.4');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('#graph-zoom')).toHaveValue('1.5');
  await page.locator('#graph-zoom').selectOption('1');
  await expect(page.locator('#graph-state')).toHaveText('Saved');
  await page.locator('.graph-actions > summary').press('Enter');
  await expect(page.locator('#graph-validate')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.graph-actions > summary')).toBeFocused();
  await page.locator('#graph-help').press('Enter');
  await expect(page.getByRole('dialog', { name: 'Graph Editor help' })).toContainText('Choose 100%');
  await expect(page.getByRole('dialog', { name: 'Graph Editor help' })).toContainText('Active in the toolbar means this graph is running in Live');
  await page.keyboard.press('Escape'); await expect(page.locator('#graph-help')).toBeFocused();
  return { width, toolbar: bounds, canvas, controls };
}

// Use the production cross-page Live state channel, including session and graph IDs.
export async function publishGraphActivity(page, { sessionId = 'live-window-1', state = 'recording', matching = true, tabId = 1476958582 } = {}) {
  await page.evaluate(async ({ sessionId, state, matching, tabId }) => {
    const { readLibrary, entryGraph } = await import(new URL('./graph-library.js', location.href));
    const id = new URLSearchParams(location.search).get('id');
    const graph = entryGraph(readLibrary(localStorage).graphs.find(entry => entry.id === id));
    const channel = new BroadcastChannel('live-graph-state');
    channel.postMessage({ sessionId, graphId: matching ? id : 'unrelated-graph', graph, state, tabId }); channel.close();
  }, { sessionId, state, matching, tabId });
}

export async function checkGraphActivity(page, width, info) {
  await page.setViewportSize({ width, height: 900 });
  const badge = page.locator('.graph-toolbar .graph-activity'), warning = page.locator('.graph-state-notice');
  const canvas = page.locator('.graph-scroll'), toolbar = page.locator('.graph-toolbar');
  await expect(badge).toBeHidden(); await expect(warning).toBeHidden();
  expect(await warning.boundingBox()).toBeNull();
  const idle = await canvas.boundingBox();
  await publishGraphActivity(page);
  await expect(badge).toBeVisible(); await expect(badge).toHaveText('Active');
  await expect(badge).toHaveAttribute('title', 'Running in Live · tab 1476958582');
  await expect(warning).toBeHidden();
  expect(await warning.boundingBox()).toBeNull();
  const active = await canvas.boundingBox();
  expect(active).toEqual(idle);
  expect(active.height).toBeGreaterThan(width > 800 ? 744 : 558); // Previous canvas sizes at 900px height.
  const bounds = await toolbar.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(active.y - bounds.y - bounds.height).toBeLessThan(20);
  await expect(page.locator('.graph-status')).toHaveAttribute('role', 'status');
  await expect(page.locator('.graph-status [role=status]')).toHaveCount(0);
  expect(await page.locator('#graph-editor').innerText()).not.toContain('1476958582');
  await page.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight');
  await expect(page.locator('#graph-state')).toHaveText(/Saving…|Saved/);
  await expect(badge).toBeVisible();
  // Auto Save may already have published the next-session warning.
  await expect(page.locator('#graph-state')).toHaveText(/Saving…|Saved/);
  // All controls and both independent statuses fit, without clipping or overlap.
  const status = await page.locator('.graph-status').boundingBox();
  for (const selector of ['#graph-state', '.graph-activity']) {
    const box = await page.locator(selector).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(status.x);
    expect(box.x + box.width).toBeLessThanOrEqual(status.x + status.width + .5);
    expect(box.y).toBeGreaterThanOrEqual(bounds.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  }
  for (const selector of ['#graph-palette-toggle', '#graph-undo', '.graph-actions > summary', '#graph-help']) {
    const box = await page.locator(selector).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(bounds.y); expect(box.height).toBeGreaterThanOrEqual(44);
    if (box.y < status.y + status.height) expect(box.x).toBeGreaterThanOrEqual(status.x + status.width);
    else expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (info) {
    await page.screenshot({ path: info.outputPath(`active-toolbar-${width}.png`), fullPage: true });
    if (process.env.UPDATE_GRAPH_STATUS_SCREENSHOTS && info.project.name === 'chromium') {
      await page.screenshot({ path: `docs/evidence/graph-245-${width}.png`, fullPage: true });
    }
  }
  await page.locator('#graph-undo').click();
  await expect(page.locator('#graph-state')).toHaveText('Saved');
  // Another window's activity and cleanup cannot clear this graph's status.
  await publishGraphActivity(page, { sessionId: 'unrelated-window', matching: false });
  await expect(badge).toBeVisible(); await expect(warning).toBeHidden();
  await publishGraphActivity(page, { sessionId: 'unrelated-window', matching: false, state: 'idle' });
  await expect(badge).toBeVisible();
  // Two windows can run the same graph; stopping one leaves the other active.
  await publishGraphActivity(page, { sessionId: 'live-window-2', tabId: 84 });
  await expect(badge).toHaveAttribute('title', 'Running in Live · tab 1476958582');
  await publishGraphActivity(page, { state: 'idle' });
  await expect(badge).toBeVisible(); await expect(badge).toHaveAttribute('title', 'Running in Live · tab 84');
  await publishGraphActivity(page, { sessionId: 'live-window-2', state: 'idle' });
  await expect(badge).toBeHidden(); await expect(warning).toBeHidden();
  expect(await canvas.boundingBox()).toEqual(idle);
  await publishGraphActivity(page, { tabId: null });
  await expect(badge).toBeVisible(); await expect(badge).toHaveAttribute('title', 'Running in Live');
  await publishGraphActivity(page, { state: 'idle' });
  await expect(badge).toBeHidden(); await expect(warning).toBeHidden();
  expect(await canvas.boundingBox()).toEqual(idle);
  return { width, toolbar: bounds, idleCanvas: idle, activeCanvas: active };
}

export async function checkLeanInspector(page) {
  await page.evaluate(async () => {
    const { defaultGraph, graphNode } = await import(new URL('./graph.js', location.href)); const { saveLiveGraphData } = await import(new URL('./graph-library.js', location.href));
    const graph = defaultGraph(); graph.nodes.push(graphNode('Hold', 'hold-1', 20, 20));
    await saveLiveGraphData(localStorage, graph);
  });
  await page.reload();
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  const heading = page.getByRole('button', { name: 'Select hold-1', exact: true });
  const inspector = page.locator('.graph-inspector');
  await heading.click();
  await expect(inspector).toContainText('Instance ID: hold-1');
  await expect(inspector.getByRole('heading', { name: 'Hold', exact: true })).toBeVisible();
  await expect(inspector).not.toContainText('no configurable settings');
  await expect(inspector.locator('label')).toHaveCount(0);
  await expect(inspector.locator('.graph-inspector-header').getByRole('button', { name: 'Remove hold-1' })).toBeVisible();
  await inspector.getByText('Node help and ports', { exact: true }).click();
  await expect(inspector).toContainText('Output value:');
  await expect(page.getByRole('button', { name: 'Clear selection' })).toHaveCount(0);
  await heading.click(); await expect(heading).toHaveAttribute('aria-pressed', 'false');
  await expect(heading).toBeFocused();
  await heading.press('Enter'); await expect(heading).toHaveAttribute('aria-pressed', 'true');
  await heading.press('Space'); await expect(heading).toHaveAttribute('aria-pressed', 'false');
  await heading.press('Enter'); await heading.press('Escape');
  await expect(heading).toHaveAttribute('aria-pressed', 'false');
  await heading.press('Enter'); await page.locator('#graph-canvas').click({ position: { x: 3, y: 3 } });
  await expect(inspector).toContainText('Select a node or connection.');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before);
  await expect(page.locator('#graph-state')).toHaveText('Saved');
  await heading.click();
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 15, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + 45, { steps: 5 }); await page.mouse.up();
  await expect(heading).toHaveAttribute('aria-pressed', 'true');
  await expect(heading).toBeFocused();
  await expect(page.locator('[data-node="hold-1"]')).toHaveCSS('left', '70px');
  await expect(page.locator('#graph-state')).toHaveText(/Saving…|Saved/);
  await heading.press('ArrowRight'); await expect(heading).toBeFocused();
  await expect(page.locator('[data-node="hold-1"]')).toHaveCSS('left', '80px');
  const wire = page.getByRole('button', { name: 'Select connection audio.audio to speech.audio', exact: true });
  await wire.press('Enter');
  await expect(inspector).toContainText('audio.audio → speech.audio');
  await expect(inspector.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear selection' })).toHaveCount(0);
  await wire.press('Tab'); await expect(page.locator('#graph-disconnect')).toBeFocused();
  await page.locator('#graph-disconnect').press('Enter'); await expect(wire).toHaveCount(0);
  await expect(page.locator('.graph-scroll')).toBeFocused();
}

export async function checkGraphCommands(page) {
  const actions = page.locator('.graph-actions > summary');
  await actions.press('Enter'); await page.locator('#graph-import').click();
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await expect(page.locator('#graph-errors')).toContainText('Cannot import graph');
  const graph = await page.evaluate(async () => {
    const { defaultGraph, graphNode } = await import(new URL('./graph.js', location.href));
    const graph = defaultGraph(); graph.nodes.push(graphNode('Text', 'literal', 20, 20)); return graph;
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await expect(page.locator('#graph-state')).toHaveText(/Saving…|Saved/);
  await expect(actions).toBeFocused();
  await actions.press('Enter');
  const download = page.waitForEvent('download'); await page.locator('#graph-export').click();
  expect(JSON.parse(await readFile(await (await download).path(), 'utf8'))).toEqual(graph);
  await expect(page.locator('#graph-undo')).toBeEnabled();
  await expect(page.locator('[data-node="literal"]')).toHaveCount(1);
  await page.locator('#graph-undo').click();
  await expect(page.locator('[data-node="literal"]')).toHaveCount(0);
  await actions.press('Enter');
  await page.locator('#graph-optional-warnings').check();
  await expect(page.locator('#graph-optional-warnings')).toBeChecked();
  await page.keyboard.press('Escape');
  await clickGraphAction(page, 'graph-validate'); await expect(page.locator('#graph-errors')).toContainText('Draft valid');
  await actions.press('Enter'); await page.locator('#graph-optional-warnings').uncheck(); await page.keyboard.press('Escape');
}
