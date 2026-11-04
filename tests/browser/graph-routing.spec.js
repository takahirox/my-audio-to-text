import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadRoutingGraph, assertRoutingGeometry, detourPoint, checkRoutingMovement } from '../fixtures/graph-routing.js';

const evidencePath = name => process.env.GRAPH_ROUTING_EVIDENCE ? `docs/evidence/${name}` : test.info().outputPath(name);

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/extension/graph-editor.html');
});
test('routing follows node drag, keyboard movement, resize, zoom, scroll and Fit', async ({ page }) => {
  await checkRoutingMovement(page);
});
test('backward, upward and downward port routes avoid intermediate cards', async ({ page }) => {
  await loadRoutingGraph(page);
  for (const [source, target, obstacle] of [
    [[800, 200], [30, 200], [400, 120]], [[30, 30], [30, 800], [180, 350]], [[30, 800], [30, 30], [180, 350]],
  ]) {
    await page.evaluate(({ source, target, obstacle }) => {
      const key = 'processing-graph-v1', graph = JSON.parse(localStorage.getItem(key));
      for (const [i, position] of [source, obstacle, target].entries()) graph.nodes[i].position = { x: position[0], y: position[1] };
      localStorage.setItem(key, JSON.stringify(graph));
    }, { source, target, obstacle });
    await page.reload(); await assertRoutingGeometry(page);
  }
});
test('detour hit target supports selection, keyboard deletion and persistence', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 }); await loadRoutingGraph(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  const p = await detourPoint(page); await page.mouse.click(p.x, p.y);
  await expect(page.locator('.selected-wire')).toHaveCount(1); await expect(page.locator('#graph-disconnect')).toBeVisible();
  const initial = await page.locator('.wire-line').getAttribute('d');
  await page.locator('[data-node="obstacle"]').evaluate(card => { card.style.height = '450px'; });
  await expect(page.locator('.wire-line')).not.toHaveAttribute('d', initial);
  await expect(page.locator('.selected-wire')).toBeFocused(); await assertRoutingGeometry(page);
  await page.keyboard.press('Tab'); await expect(page.locator('#graph-disconnect')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Delete');
  await expect(page.locator('.graph-wire')).toHaveCount(0);
  await page.getByRole('button', { name: 'source output value', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'target input input1', exact: true }).press('Enter');
  await assertRoutingGeometry(page);
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(before);
  await page.reload(); await assertRoutingGeometry(page);
});
test('adding and removing formatter ports updates attachment geometry and only its last wire', async ({ page }) => {
  await loadRoutingGraph(page);
  await page.getByRole('button', { name: 'Select target', exact: true }).click();
  await page.getByRole('button', { name: 'target Add input', exact: true }).click();
  await page.getByRole('button', { name: 'source output value', exact: true }).click();
  await page.getByRole('button', { name: 'target input input5', exact: true }).click();
  await expect(page.locator('.graph-wire')).toHaveCount(2); await assertRoutingGeometry(page);
  await page.getByRole('button', { name: 'Select target', exact: true }).click();
  await page.getByRole('button', { name: 'target Remove last input', exact: true }).click();
  await expect(page.locator('.graph-wire')).toHaveCount(1); await assertRoutingGeometry(page);
});
test('dense routes remain clear and update interactively', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 }); await loadRoutingGraph(page, true);
  await assertRoutingGeometry(page); await page.locator('#graph-fit').click();
  await page.evaluate(async () => {
    const { GraphEditor } = await import('/extension/graph-editor.js'), draw = GraphEditor.prototype.drawWires;
    window.routingTimes = [];
    GraphEditor.prototype.drawWires = function(...args) {
      const start = performance.now(); const result = draw.apply(this, args); window.routingTimes.push(performance.now() - start); return result;
    };
  });
  const heading = page.getByRole('button', { name: 'Select n12', exact: true }), box = await heading.boundingBox();
  const start = Date.now(); await page.mouse.move(box.x + 30, box.y + 5); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 20, { steps: 20 }); await page.mouse.up();
  expect(Date.now() - start).toBeLessThan(4000); await assertRoutingGeometry(page);
  const timings = await page.evaluate(() => window.routingTimes);
  console.log(`dense routing: ${timings.length} redraws, max ${Math.max(...timings).toFixed(1)} ms`);
  expect(timings.length).toBeGreaterThan(1);
  expect(Math.max(...timings)).toBeLessThan(250);
  if (test.info().project.name === 'chromium') await page.screenshot({ path: evidencePath('graph-204-dense.png') });
});
test('blocked ports show a dashed selectable fallback and recover when cards move', async ({ page }) => {
  await loadRoutingGraph(page);
  await page.evaluate(() => { const key = 'processing-graph-v1', graph = JSON.parse(localStorage.getItem(key)); graph.nodes[1].position = { x: 260, y: 200 }; localStorage.setItem(key, JSON.stringify(graph)); });
  await page.reload();
  await expect(page.locator('.routing-fallback')).toHaveCount(1);
  await expect(page.locator('.graph-routing-notice')).toBeVisible();
  await page.locator('.graph-wire').press('Enter'); await expect(page.locator('#graph-disconnect')).toBeVisible();
  for (let i = 0; i < 35; i++) await page.getByRole('button', { name: 'Select obstacle', exact: true }).press('ArrowDown');
  await expect(page.locator('.routing-fallback')).toHaveCount(0); await assertRoutingGeometry(page);
});
test('before/after obstacle screenshots', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'one evidence image per state');
  await page.setViewportSize({ width: 1600, height: 1000 }); await loadRoutingGraph(page);
  await mkdir('docs/evidence', { recursive: true });
  const current = await page.locator('.wire-line').getAttribute('d');
  // Reproduce the previous endpoint-only cubic on the identical fixture.
  await page.locator('.graph-wire').evaluate(wire => {
    const path = wire.querySelector('.wire-line'), a = path.getPointAtLength(0), b = path.getPointAtLength(path.getTotalLength());
    for (const path of wire.querySelectorAll('path')) path.setAttribute('d', `M${a.x},${a.y} C${a.x+60},${a.y} ${b.x-60},${b.y} ${b.x},${b.y}`);
  });
  await page.screenshot({ path: evidencePath('graph-204-before.png') });
  await page.locator('.graph-wire path').evaluateAll((paths, d) => paths.forEach(path => path.setAttribute('d', d)), current);
  await assertRoutingGeometry(page); await page.screenshot({ path: evidencePath('graph-204-after.png') });
});
