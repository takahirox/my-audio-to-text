import { expect } from '@playwright/test';

export async function loadZoomGraph(page, size = 'large') {
  await page.evaluate(async size => {
    const { defaultGraph, graphNode, saveGraph } = await import(new URL('./graph.js', location.href));
    const graph = defaultGraph();
    if (size === 'large') for (let i = 0; i < 35; i++) {
      graph.nodes.push(graphNode('Text', `literal-${i}`, 20 + i % 10 * 400, 600 + Math.floor(i / 10) * 350));
    }
    saveGraph(localStorage, graph);
  }, size);
  await page.reload();
}

export async function expectInsideCanvas(control) {
  const geometry = await control.evaluate(control => {
    const box = control.getBoundingClientRect(), viewport = control.closest('.graph-scroll').getBoundingClientRect();
    return { left: box.left - viewport.left, top: box.top - viewport.top, right: viewport.right - box.right, bottom: viewport.bottom - box.bottom };
  });
  for (const margin of Object.values(geometry)) expect(margin).toBeGreaterThanOrEqual(0);
  await expect(control).toBeInViewport({ ratio: 1 });
}

export async function zoomGeometry(page) {
  return page.getByRole('button', { name: 'speech output final', exact: true }).evaluate(port => {
    const zoom = Number(document.querySelector('#graph-zoom').value), hint = port.querySelector('small');
    const box = port.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(hint);
    return { zoom, width: box.width, height: box.height, labelPixels: parseFloat(getComputedStyle(port).fontSize) * zoom,
      hintPixels: parseFloat(getComputedStyle(hint).fontSize) * zoom, hintLineHeight: range.getBoundingClientRect().height,
      pageOverflow: document.documentElement.scrollWidth > innerWidth };
  });
}

export async function checkZoomRecovery(page, size, info) {
  await loadZoomGraph(page, size);
  const target = page.getByRole('button', { name: size === 'large' ? 'literal-29 output value' : 'speech output final', exact: true });
  const before = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  const samples = [];
  for (const zoom of ['0.25', '0.5', '0.75', 'fit']) {
    // Keep a far-away port as the editing anchor through a redraw and Fit.
    await target.press('Space');
    const pressed = await target.getAttribute('aria-pressed');
    if (zoom === 'fit') await page.locator('#graph-fit').press('Enter');
    else await page.locator('#graph-zoom').selectOption(zoom);
    samples.push({ requested: zoom, ...await zoomGeometry(page) });
    expect(samples.at(-1).pageOverflow).toBe(false);
    const edit = page.getByRole('button', { name: 'Edit at 100%', exact: true });
    await expect(edit).toBeVisible();
    const box = await edit.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44);
    await edit.press('Enter');
    await expect(target).toBeFocused();
    await expectInsideCanvas(target);
    await expect(target).toHaveAttribute('aria-pressed', pressed);
    await expect(page.locator('#graph-zoom')).toHaveValue('1');
    await expect(edit).toBeHidden();
    expect((await target.boundingBox()).height).toBeGreaterThanOrEqual(44);
    // The existing selector also retains the editing location when zooming in.
    await page.locator('#graph-zoom').focus();
    await page.locator('#graph-zoom').selectOption('0.25');
    await page.locator('#graph-zoom').selectOption('1.5');
    await expectInsideCanvas(target);
    await expect(page.locator('#graph-zoom')).toBeFocused();
  }
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(before);
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  await info.attach('zoom-geometry', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
}

export async function exposedWirePoint(wire) {
  await wire.scrollIntoViewIfNeeded();
  return wire.locator('.wire-hit').evaluate(path => {
    const m = path.getScreenCTM(), viewport = path.closest('.graph-scroll').getBoundingClientRect();
    for (const fraction of [.5, .4, .6, .3, .7, .2, .8, .1, .9]) {
      const p = path.getPointAtLength(path.getTotalLength() * fraction);
      const x = m.a * p.x + m.c * p.y + m.e, y = m.b * p.x + m.d * p.y + m.f;
      if (x > viewport.left && x < viewport.right && y > viewport.top && y < viewport.bottom
        && document.elementFromPoint(x, y)?.closest('.graph-wire') === path.parentElement) return { x, y };
    }
    throw Error('No exposed wire point');
  });
}
