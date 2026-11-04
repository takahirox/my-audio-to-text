import { test, expect, openGraph } from './graph-fixture.js';
import { loadRoutingGraph, assertRoutingGeometry, detourPoint, checkRoutingMovement } from '../fixtures/graph-routing.js';
import { clickGraphAction } from './ui-controls.js';

test('packaged MV3 routes track dragging, resized cards, zoom, scroll and Fit', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await checkRoutingMovement(live.editor);
});

test('native touch selects a detour and Disconnect persists only the intended removal', async ({ graphExtension: f }) => {
  const live = await openGraph(f), page = live.editor;
  await page.setViewportSize({ width: 1600, height: 1000 }); await loadRoutingGraph(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  const p = await detourPoint(page), session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.selected-wire')).toHaveCount(1);
  const control = await page.locator('#graph-disconnect').boundingBox();
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: control.x + control.width / 2, y: control.y + control.height / 2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await session.detach();
  await expect(page.locator('.graph-wire')).toHaveCount(0);
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual({ ...before, edges: [] });
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(0);
  // Native drag-to-connect restores the routed connection without changing nodes.
  await page.getByRole('button', { name: 'source output value', exact: true }).dragTo(page.getByRole('button', { name: 'target input input1', exact: true }));
  await expect(page.locator('.graph-wire')).toHaveCount(1); await assertRoutingGeometry(page);
});

test('import, Save, Load saved and reset retain logical graph data independently of routing', async ({ graphExtension: f }) => {
  const live = await openGraph(f), page = live.editor; await loadRoutingGraph(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  const imported = structuredClone(before); imported.nodes[1].position.y += 30;
  await page.locator('input[type="file"]').setInputFiles({ name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await assertRoutingGeometry(page); await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(imported);
  await page.getByRole('button', { name: 'Select obstacle', exact: true }).press('ArrowDown');
  await clickGraphAction(page, 'graph-load');
  await expect(page.locator('[data-node="obstacle"]')).toHaveCSS('top', `${imported.nodes[1].position.y}px`); await assertRoutingGeometry(page);
  await clickGraphAction(page, 'graph-validate'); await expect(page.locator('#graph-errors')).not.toContainText('Error:');
  expect(await page.evaluate(async () => { const { validateGraph } = await import('./graph.js'); return validateGraph(JSON.parse(localStorage.getItem('processing-graph-v1'))); })).toEqual([]);
  await clickGraphAction(page, 'graph-reset');
  await expect(page.locator('[data-node="source"]')).toHaveCount(0);
  await clickGraphAction(page, 'graph-load');
  await expect(page.locator('.graph-wire')).toHaveCount(1); await assertRoutingGeometry(page);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(imported);
});
