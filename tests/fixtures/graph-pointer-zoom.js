import { expect } from '@playwright/test';
import { loadZoomGraph } from './graph-zoom.js';

export async function wheelAtCanvas(page, deltaY, extra = {}) {
  return page.locator('.graph-scroll').evaluate((scroll, { deltaY, extra }) => {
    const box = scroll.getBoundingClientRect();
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true,
      clientX: box.left + box.width * .6, clientY: box.top + box.height * .3, deltaY, ...extra });
    const target = document.elementFromPoint(event.clientX, event.clientY);
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, zoom: Number(document.querySelector('#graph-zoom').value) };
  }, { deltaY, extra });
}

export async function checkPointerZoom(page, width = 1440, scale = 1) {
  await page.setViewportSize({ width, height: 900 }); await loadZoomGraph(page);
  await page.locator('.graph-workspace').evaluate((el, scale) => {
    el.style.transformOrigin = 'top left'; el.style.transform = `scale(${scale})`;
  }, scale);
  const port = page.getByRole('button', { name: 'literal-29 output value', exact: true });
  await port.evaluate(el => el.focus({ preventScroll: true }));
  await page.locator('.graph-scroll').evaluate(scroll => { scroll.scrollLeft = 800; scroll.scrollTop = 450; });
  const before = await page.evaluate(() => {
    window.zoomFocus = document.activeElement;
    const scroll = document.querySelector('.graph-scroll'), canvas = document.querySelector('.graph-canvas');
    const view = scroll.getBoundingClientRect(), box = canvas.getBoundingClientRect();
    const pointer = { x: view.left + view.width * .6, y: view.top + view.height * .3 };
    return { pointer, world: { x: (pointer.x - box.left) / (box.width / parseFloat(canvas.style.width)),
      y: (pointer.y - box.top) / (box.height / parseFloat(canvas.style.height)) },
    saved: localStorage.getItem('processing-graph-library-v1'), paths: [...document.querySelectorAll('.wire-line')].map(p => p.getAttribute('d')) };
  });
  // High-resolution fractions in both directions, while already scrolled.
  for (const delta of [-8.325, 8.325, -2.5, 2.5]) {
    const result = await wheelAtCanvas(page, delta);
    expect(result.prevented).toBe(true);
    expect(result.zoom).toBeCloseTo(Math.exp(delta < 0 ? -delta * .01 : 0), 10);
    const after = await page.locator('.graph-canvas').evaluate((canvas, before) => {
      const box = canvas.getBoundingClientRect();
      return { x: box.left + before.world.x * box.width / parseFloat(canvas.style.width),
        y: box.top + before.world.y * box.height / parseFloat(canvas.style.height),
        sameFocus: document.activeElement === window.zoomFocus,
        paths: [...document.querySelectorAll('.wire-line')].map(p => p.getAttribute('d')) };
    }, before);
    // Native scroll offsets round to device pixels; allow one CSS pixel.
    expect(Math.abs(after.x - before.pointer.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.pointer.y)).toBeLessThanOrEqual(1);
    expect(after.sameFocus).toBe(true); expect(after.paths).toEqual(before.paths);
  }
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(before.saved);
  await expect(page.locator('#graph-state')).toHaveText('Saved');
}

export async function checkZoomInputModes(page) {
  await loadZoomGraph(page);
  const pixels = await wheelAtCanvas(page, -16);
  await wheelAtCanvas(page, 16);
  const lines = await wheelAtCanvas(page, -1, { deltaMode: 1 });
  expect(lines.zoom).toBe(pixels.zoom); await wheelAtCanvas(page, 1, { deltaMode: 1 });
  const height = await page.locator('.graph-scroll').evaluate(el => el.clientHeight);
  const pages = await wheelAtCanvas(page, -16 / height, { deltaMode: 2 });
  expect(pages.zoom).toBe(pixels.zoom); await wheelAtCanvas(page, 16 / height, { deltaMode: 2 });
  const ordinary = await wheelAtCanvas(page, -100, { ctrlKey: false });
  expect(ordinary.prevented).toBe(false); expect(ordinary.zoom).toBe(1);
  // Even while menus are open, their events never enter the scrollport listener.
  await page.locator('#graph-palette-toggle').click();
  for (const selector of ['.graph-toolbar', '.graph-inspector', '#graph-palette', '#graph-zoom']) {
    expect(await page.locator(selector).evaluate(el => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100 });
      el.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(false);
  }
  await expect(page.locator('#graph-zoom')).toHaveValue('1'); await page.keyboard.press('Escape');
}

export async function checkZoomControls(page) {
  await page.setViewportSize({ width: 390, height: 900 }); await loadZoomGraph(page);
  const zoom = page.getByRole('combobox', { name: 'Canvas zoom', exact: true });
  const out = page.getByRole('button', { name: 'Zoom out', exact: true });
  const into = page.getByRole('button', { name: 'Zoom in', exact: true });
  await out.press('Enter'); await expect(zoom).toHaveValue('0.9'); await expect(out).toBeFocused();
  await into.press('Space'); await expect(zoom).toHaveValue('1');
  const fractional = (await wheelAtCanvas(page, -3.25)).zoom;
  await expect(zoom.locator('option:checked')).toHaveText(`${Number((fractional * 100).toFixed(2))}%`);
  expect(await zoom.locator('[data-custom]').count()).toBe(1);
  await page.locator('#graph-fit').press('Enter');
  const fit = Number(await zoom.inputValue()); expect(fit).toBeLessThan(.25);
  await expect(zoom.locator('option:checked')).toContainText('(fit)');
  await into.press('Enter'); expect(Number(await zoom.inputValue())).toBeCloseTo(fit + .1, 9);
  await wheelAtCanvas(page, 100000); // Per-event spikes are bounded.
  expect(Number(await zoom.inputValue())).toBeCloseTo((fit + .1) * Math.exp(-.1), 9);
  for (let i = 0; i < 60; i++) await wheelAtCanvas(page, 240);
  await expect(zoom).toHaveValue('0.01'); await expect(out).toBeDisabled(); await expect(into).toBeEnabled();
  expect((await wheelAtCanvas(page, 240)).prevented).toBe(true);
  for (let i = 0; i < 60; i++) await wheelAtCanvas(page, -240);
  await expect(zoom).toHaveValue('1.5'); await expect(into).toBeDisabled(); await expect(out).toBeEnabled();
  expect((await wheelAtCanvas(page, -240)).prevented).toBe(true);
  // Explicit 100% still restores the editing target after a pointer overview.
  const target = page.getByRole('button', { name: 'literal-29 output value', exact: true });
  await target.evaluate(el => el.focus({ preventScroll: true }));
  await zoom.selectOption('1'); await expect(target).toBeFocused();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(await zoom.locator('option').allTextContents()).toEqual(['25%', '50%', '75%', '100%', '125%', '150%']);
  await expect(page.locator('#graph-state')).toHaveText('Saved');
}
