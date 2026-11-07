import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkCanvasFirst, checkLeanInspector, checkGraphCommands } from '../fixtures/graph-canvas-first.js';
import { clickGraphAction } from '../extension/ui-controls.js';

async function serveExtension(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
  await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
}
test.beforeEach(async ({ page }) => { await page.route('**/*', serveExtension); await page.goto('/extension/graph-editor.html'); });
for (const width of [1440, 390, 320]) {
  test(`compact toolbar and fixed navigation at ${width}px`, async ({ page }, info) => {
    const geometry = await checkCanvasFirst(page, width);
    await info.attach('canvas-geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
  });
}
test('lean inspector toggles heading selection, preserves dragging and edge actions', async ({ page }) => { await checkLeanInspector(page); });
test('overflow preserves import/export, confirmation, warnings and validation', async ({ page }) => { await checkGraphCommands(page); });
test('save conflicts and an earlier active graph stay visible with compact state', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: 'Select audio', exact: true }).press('ArrowRight');
  const second = await page.context().newPage();
  try {
    await second.route('**/*', serveExtension); await second.goto(page.url());
    await second.evaluate(async () => {
      const { defaultGraph } = await import('/extension/graph.js'); const { saveLiveGraphData } = await import('/extension/graph-library.js');
      const graph = defaultGraph(); graph.nodes[0].position.y += 20; await saveLiveGraphData(localStorage, graph);
    });
    await expect(page.locator('#graph-state')).toHaveText('Unsaved');
    await expect(page.locator('.graph-state-notice')).toContainText('draft kept. Load saved before saving.');
    await page.locator('#graph-save').click();
    await expect(page.locator('#graph-errors')).toContainText('Load saved before saving');
    await expect(page.locator('#graph-save')).toBeEnabled();
    await second.evaluate(async () => {
      const { defaultGraph } = await import('/extension/graph.js');
      const channel = new BroadcastChannel('live-graph-state');
      channel.postMessage({ graphId: new URLSearchParams(location.search).get('id'), graph: defaultGraph(), state: 'recording', tabId: 42 }); channel.close();
    });
    await expect(page.locator('.graph-state-notice')).toContainText('Active · tab 42 · earlier graph');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await clickGraphAction(page, 'graph-load');
    await expect(page.locator('#graph-state')).toHaveText('Saved');
    await expect(page.locator('.graph-state-notice')).not.toContainText('draft kept');
    await expect(page.locator('#graph-errors')).toBeEmpty();
  } finally { await second.close(); }
});
test('bottom ports can scroll completely above floating controls and Fit reserves their space', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(async () => {
    const { graphNode } = await import('/extension/graph.js'); const { saveLiveGraphData } = await import('/extension/graph-library.js');
    await saveLiveGraphData(localStorage, { version: 15, nodes: [graphNode('Hold', 'last', 20, 2400)], edges: [] });
  });
  await page.reload();
  const scroll = page.locator('.graph-scroll'), navigation = page.locator('.graph-zoom-controls');
  await scroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const bottom = await page.getByRole('button', { name: 'last output value', exact: true }).boundingBox();
  expect(bottom.y + bottom.height).toBeLessThan((await navigation.boundingBox()).y);
  await page.locator('#graph-fit').click();
  expect(Number(await page.locator('#graph-zoom').inputValue())).toBeLessThan(.25);
  const card = await page.locator('[data-node="last"]').boundingBox();
  expect(card.y + card.height).toBeLessThan((await navigation.boundingBox()).y);
});
for (const width of [1440, 390]) test(`canvas-first appearance at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  await page.evaluate(async () => {
    const { graphNode, edge } = await import('/extension/graph.js'); const { saveLiveGraphData } = await import('/extension/graph-library.js');
    const nodes = [graphNode('Text', 'text-1', 20, 20), graphNode('Hold', 'hold-1', 310, 20), graphNode('Display', 'display-1', 600, 20)];
    nodes[0].settings.value = 'Draft text';
    await saveLiveGraphData(localStorage, { version: 15, nodes, edges: [edge('text-1', 'value', 'hold-1', 'input'), edge('hold-1', 'value', 'display-1', 'input1')] });
  });
  await page.reload(); await page.locator('#graph-fit').click();
  await page.getByRole('button', { name: 'Select hold-1', exact: true }).press('Enter');
  await expect(page.locator('.graph-inspector')).toContainText('Instance ID: hold-1');
  await page.locator('#graph-fit').focus();
  await page.screenshot({ path: info.outputPath(`canvas-first-${width}.png`), fullPage: true });
  if (process.env.UPDATE_CANVAS_FIRST_SCREENSHOTS && info.project.name === 'chromium') {
    await page.screenshot({ path: `docs/evidence/graph-235-${width}.png`, fullPage: true });
  }
});
test('touch toggles selection without deleting and uses full-sized zoom controls', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage(); await page.route('**/*', serveExtension); await page.goto('/extension/graph-editor.html');
    const heading = page.getByRole('button', { name: 'Select audio', exact: true });
    await heading.tap(); await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await heading.tap(); await expect(heading).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Zoom out', exact: true }).tap();
    await expect(page.locator('#graph-zoom')).toHaveValue('0.9');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
    await expect(page.locator('#graph-zoom')).toHaveValue('1');
    await expect(page.locator('#graph-state')).toHaveText('Saved');
  } finally { await context.close(); }
});
