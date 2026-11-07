import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPointerZoom, checkZoomInputModes, checkZoomControls, wheelAtCanvas } from '../fixtures/graph-pointer-zoom.js';
import { loadRoutingGraph, assertRoutingGeometry, detourPoint } from '../fixtures/graph-routing.js';
import { loadZoomGraph } from '../fixtures/graph-zoom.js';

test.use({ deviceScaleFactor: 2 });
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/extension/graph-editor.html');
});
for (const width of [1440, 390]) for (const scale of [1, .8]) {
  test(`pointer zoom keeps scrolled world point and focus at ${width}px / ${scale} ancestor scale`, async ({ page }) => {
    await checkPointerZoom(page, width, scale);
  });
}
test('wheel delta modes normalize and unrelated scrolling stays native', async ({ page }) => { await checkZoomInputModes(page); });
test('fine keyboard controls, fractional display, Fit, limits and 100% focus recovery', async ({ page }) => { await checkZoomControls(page); });
test('zoom at scroll edges clamps offsets without moving nodes, and very large Fit stops at 1%', async ({ page }) => {
  await loadZoomGraph(page);
  await page.locator('#graph-zoom').selectOption('1.5');
  const scroll = page.locator('.graph-scroll');
  const before = await scroll.evaluate(el => {
    el.scrollLeft = el.scrollWidth; el.scrollTop = el.scrollHeight;
    const box = el.getBoundingClientRect();
    return { left: el.scrollLeft, top: el.scrollTop, x: box.width * .6 - el.clientLeft, y: box.height * .3 - el.clientTop };
  });
  const result = await wheelAtCanvas(page, 240);
  const after = await scroll.evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop,
    maxX: el.scrollWidth - el.clientWidth, maxY: el.scrollHeight - el.clientHeight }));
  const ratio = result.zoom / 1.5;
  expect(after.left).toBeCloseTo(Math.min(after.maxX, Math.max(0, (before.left + before.x) * ratio - before.x)), 0);
  expect(after.top).toBeCloseTo(Math.min(after.maxY, Math.max(0, (before.top + before.y) * ratio - before.y)), 0);
  await page.evaluate(async () => {
    const { graphNode, saveGraph, GRAPH_VERSION } = await import('/extension/graph.js');
    saveGraph(localStorage, { version: GRAPH_VERSION, nodes: [graphNode('Hold', 'distant', 200000, 200000)], edges: [] });
  });
  await page.reload();
  const saved = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  await page.locator('#graph-fit').click(); await expect(page.locator('#graph-zoom')).toHaveValue('0.01');
  await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  await expect(page.locator('[data-node="distant"]')).toHaveCSS('left', '200000px');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(saved);
});
test('native Ctrl+wheel prevents browser zoom; ordinary wheel scrolls', async ({ page }) => {
  await loadRoutingGraph(page); const scroll = page.locator('.graph-scroll'), box = await scroll.boundingBox();
  await scroll.evaluate(el => {
    window.nativeZoomWheels = [];
    el.addEventListener('wheel', event => {
      if (event.ctrlKey) window.nativeZoomWheels.push({ delta: event.deltaY, prevented: event.defaultPrevented, trusted: event.isTrusted });
    });
  });
  await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.wheel(0, 120);
  await expect.poll(() => scroll.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('#graph-zoom')).toHaveValue('1');
  await page.keyboard.down('Control');
  try { await page.mouse.wheel(0, -60); } finally { await page.keyboard.up('Control'); }
  await expect.poll(() => page.evaluate(() => window.nativeZoomWheels.length)).toBe(1);
  const [event] = await page.evaluate(() => window.nativeZoomWheels);
  expect(event.prevented).toBe(true); expect(event.trusted).toBe(true); expect(event.delta).toBeLessThan(0);
  expect(Number(await page.locator('#graph-zoom').inputValue())).toBeCloseTo(Math.exp(-Math.max(-10, Math.min(10, event.delta)) * .01), 10);
  expect(await page.evaluate(() => visualViewport.scale)).toBe(1);
  expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
});
test('Chromium desktop pinch uses one Ctrl+wheel path', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium gesture protocol');
  await loadRoutingGraph(page);
  await page.evaluate(() => {
    window.pinchDeltas = [];
    document.querySelector('.graph-scroll').addEventListener('wheel', event => {
      if (event.ctrlKey) window.pinchDeltas.push({ delta: event.deltaY, prevented: event.defaultPrevented });
    });
  });
  const box = await page.locator('.graph-scroll').boundingBox();
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.synthesizePinchGesture', { x: box.x + 200, y: box.y + 200,
      scaleFactor: 1.1, relativeSpeed: 800, gestureSourceType: 'mouse' });
  } finally { await session.detach(); }
  await expect.poll(() => page.evaluate(() => window.pinchDeltas.length)).toBeGreaterThan(0);
  const deltas = await page.evaluate(() => window.pinchDeltas);
  expect(deltas.every(event => event.prevented)).toBe(true);
  const expected = deltas.reduce((zoom, event) => zoom * Math.exp(-Math.max(-10, Math.min(10, event.delta)) * .01), 1);
  expect(Number(await page.locator('#graph-zoom').inputValue())).toBeCloseTo(expected, 9);
  expect(expected).toBeGreaterThan(1.04); expect(await page.evaluate(() => visualViewport.scale)).toBe(1);
});
test('fractional zoom preserves wire attachments, hit testing and keyboard disconnect', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await loadRoutingGraph(page);
  await wheelAtCanvas(page, -33.5); await assertRoutingGeometry(page);
  const point = await detourPoint(page); await page.mouse.click(point.x, point.y);
  const wire = page.locator('.selected-wire'); await expect(wire).toBeFocused();
  await wheelAtCanvas(page, 7.25); await expect(wire).toBeFocused(); await assertRoutingGeometry(page);
  await wire.press('Tab'); await expect(page.locator('#graph-disconnect')).toBeFocused();
  await page.locator('#graph-disconnect').press('Enter'); await expect(page.locator('.graph-wire')).toHaveCount(0);
});
test('modified wheel during node drag preserves capture, zoom and movement', async ({ page }) => {
  await loadRoutingGraph(page);
  const heading = page.getByRole('button', { name: 'Select source', exact: true });
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 50, box.y + 25);
  expect((await wheelAtCanvas(page, -100)).prevented).toBe(true);
  await expect(page.locator('#graph-zoom')).toHaveValue('1');
  await page.mouse.move(box.x + 70, box.y + 35); await page.mouse.up();
  await expect(page.locator('[data-node="source"]')).toHaveCSS('left', '70px');
  await expect(page.locator('[data-node="source"]')).toHaveCSS('top', '220px');
  await assertRoutingGeometry(page);
});
test('output drag and input reconnect still work at fractional zoom and leave zoom available', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await loadRoutingGraph(page);
  await wheelAtCanvas(page, -33.5);
  const port = (node, side, name) => page.getByRole('button', { name: `${node} ${side} ${name}`, exact: true });
  await port('source', 'output', 'value').dragTo(port('target', 'input', 'input2'));
  await expect(page.locator('.graph-wire')).toHaveCount(2); await assertRoutingGeometry(page);
  const before = Number(await page.locator('#graph-zoom').inputValue());
  expect((await wheelAtCanvas(page, -5)).zoom).toBeGreaterThan(before);
  await port('target', 'input', 'input2').dragTo(port('target', 'input', 'input3'));
  await expect(page.getByRole('button', { name: 'Select connection source.value to target.input2', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select connection source.value to target.input3', exact: true })).toHaveCount(1);
  await assertRoutingGeometry(page);
  const next = Number(await page.locator('#graph-zoom').inputValue());
  expect((await wheelAtCanvas(page, 5)).zoom).toBeLessThan(next);
});
