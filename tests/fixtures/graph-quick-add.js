import { expect } from '@playwright/test';

export async function seedQuickAdd(page, large = false) {
  await page.evaluate(async large => {
    const { graphNode, saveGraph, GRAPH_VERSION } = await import(new URL('./graph.js', location.href));
    // No model preparation is needed to exercise real Save and reload.
    const nodes = large ? [graphNode('Text', 'far', 6000, 4000)] : [];
    saveGraph(localStorage, { version: GRAPH_VERSION, nodes, edges: [] });
  }, large);
  await page.reload();
}
const search = page => page.getByRole('combobox', { name: 'Search nodes' });
export async function openQuickAdd(page, touch = false) {
  await page.locator('#graph-palette-toggle')[touch ? 'tap' : 'click']();
  await expect(search(page)).toBeFocused();
  await expect(page.locator('#graph-palette-toggle')).toHaveAttribute('aria-expanded', 'true');
  const geometry = await page.locator('#graph-palette').evaluate(menu => {
    const box = menu.getBoundingClientRect(), anchor = document.querySelector('#graph-palette-toggle').getBoundingClientRect();
    return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight,
      gap: Math.min(Math.abs(box.top - anchor.bottom), Math.abs(anchor.top - box.bottom)),
      aligned: box.left <= anchor.right && box.right >= anchor.left };
  });
  expect(geometry.x).toBeGreaterThanOrEqual(7);
  expect(geometry.y).toBeGreaterThanOrEqual(7);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width - 7);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height - 7);
  expect(geometry.gap).toBeLessThanOrEqual(7);
  expect(geometry.aligned).toBe(true);
}
export async function checkQuickAddInteraction(page) {
  await seedQuickAdd(page);
  const stored = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  await openQuickAdd(page);
  await expect(page.getByRole('group', { name: 'Sources / inputs' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Constants / utilities' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add selected node' })).toHaveCount(0);
  await search(page).fill('no-such-node');
  await expect(page.getByRole('listbox', { name: 'Node types' }).getByRole('option')).toHaveCount(0);
  await expect(page.locator('#graph-palette')).toContainText('No matching nodes');
  await search(page).press('Enter'); await expect(page.locator('.graph-node')).toHaveCount(0);
  await search(page).fill('text');
  const ids = await page.getByRole('listbox', { name: 'Node types' }).getByRole('option').evaluateAll(options => options.map(option => option.id));
  const first = await search(page).getAttribute('aria-activedescendant');
  await search(page).press('ArrowDown');
  const second = ids[(ids.indexOf(first) + 1) % ids.length];
  await expect(search(page)).toHaveAttribute('aria-activedescendant', second);
  await expect(page.locator(`[id="${second}"]`)).toHaveAttribute('aria-selected', 'true');
  await search(page).press('ArrowUp'); await expect(search(page)).toHaveAttribute('aria-activedescendant', first);
  await search(page).fill('');
  const beforeNavigation = await snapshot(page);
  await search(page).press('ArrowUp'); // Wrap to a result beyond the initial list view.
  const highlighted = await search(page).getAttribute('aria-activedescendant');
  const visible = await page.locator(`[id="${highlighted}"]`).evaluate(option => {
    const box = option.getBoundingClientRect(), list = option.closest('[role="listbox"]').getBoundingClientRect();
    return box.top >= list.top - 1 && box.bottom <= list.bottom + 1;
  });
  expect(visible).toBe(true);
  await expect(search(page)).toBeFocused();
  expect(await snapshot(page)).toEqual(beforeNavigation);
  await search(page).press('Escape');
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.locator('#graph-palette-toggle')).toBeFocused();
  await openQuickAdd(page);
  await page.locator('.page-header h1').click();
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.locator('.graph-node')).toHaveCount(0);
  await openQuickAdd(page);
  await search(page).press('Shift+Tab');
  await expect(page.locator('#graph-palette')).toBeHidden();
  await openQuickAdd(page);
  await page.getByLabel('Node category', { exact: true }).selectOption('Constants / utilities');
  await search(page).fill('Number');
  await expect(page.getByRole('listbox', { name: 'Node types' }).getByRole('option')).toHaveCount(1);
  await search(page).press('Enter');
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Select number', exact: true })).toBeFocused();
  await expect(page.locator('.graph-inspector')).toContainText('Node: number');
  await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(stored);
  await openQuickAdd(page);
  await page.getByRole('listbox', { name: 'Node types' }).getByRole('option', { name: 'Hold', exact: true }).click();
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Select hold', exact: true })).toBeFocused();
  await expect(page.locator('#graph-errors')).toBeEmpty();
  await page.locator('#graph-save').click();
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(saved.nodes.map(node => node.type)).toEqual(['Number', 'Hold']);
  await page.reload();
  await expect(page.locator('.graph-node')).toHaveCount(2);
}
async function snapshot(page) {
  return page.locator('.graph-scroll').evaluate(scroll => ({
    left: scroll.scrollLeft, top: scroll.scrollTop, pageX: scrollX, pageY: scrollY,
    zoom: document.querySelector('#graph-zoom').value,
    nodes: [...document.querySelectorAll('.graph-node')].map(card => ({ id: card.dataset.node, left: card.style.left, top: card.style.top })),
  }));
}
export async function checkQuickAddPlacement(page, width, zoom, transformed = false, type = 'Number') {
  await page.setViewportSize({ width, height: 900 });
  await seedQuickAdd(page, true);
  if (transformed) await page.locator('.graph-extent').evaluate(extent => { extent.style.transform = 'translate(23px, 17px) scale(.85)'; extent.style.transformOrigin = 'top left'; });
  if (zoom === 'fit') await page.locator('#graph-fit').click();
  else await page.locator('#graph-zoom').selectOption(zoom);
  // Pan to blank space, far from the origin and the distant fixture card.
  await page.locator('.graph-scroll').evaluate(scroll => { scroll.scrollLeft = scroll.scrollWidth * .35; scroll.scrollTop = scroll.scrollHeight * .35; });
  const initial = await snapshot(page);
  const stored = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  const positions = [];
  for (let i = 0; i < 3; i++) {
    await openQuickAdd(page);
    await search(page).fill(type); await search(page).press('Enter');
    const id = i ? `${type.toLowerCase()}-${i}` : type.toLowerCase();
    await expect(page.getByRole('button', { name: `Select ${id}`, exact: true })).toBeFocused();
    const after = await snapshot(page);
    expect({ ...after, nodes: undefined }).toEqual({ ...initial, nodes: undefined });
    expect(after.nodes[0]).toEqual(initial.nodes[0]);
    const geometry = await page.locator(`[data-node="${id}"]`).evaluate(card => {
      const box = card.getBoundingClientRect(), scroll = document.querySelector('.graph-scroll'), view = scroll.getBoundingClientRect();
      return { x: parseFloat(card.style.left), y: parseFloat(card.style.top), left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height, view: { left: view.left + scroll.clientLeft, top: Math.max(0, view.top + scroll.clientTop),
          right: view.left + scroll.clientLeft + scroll.clientWidth, bottom: Math.min(innerHeight, view.top + scroll.clientTop + scroll.clientHeight) } };
    });
    expect(geometry.x).toBeGreaterThanOrEqual(0); expect(geometry.y).toBeGreaterThanOrEqual(0);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.view.left - 1);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.view.top - 1);
    if (geometry.width <= geometry.view.right - geometry.view.left) expect(geometry.right).toBeLessThanOrEqual(geometry.view.right + 1);
    if (geometry.height <= geometry.view.bottom - geometry.view.top) expect(geometry.bottom).toBeLessThanOrEqual(geometry.view.bottom + 1);
    if (i === 0) {
      expect(Math.abs(geometry.left - Math.max(geometry.view.left, (geometry.view.left + geometry.view.right - geometry.width) / 2))).toBeLessThanOrEqual(1);
      expect(Math.abs(geometry.top - Math.max(geometry.view.top, (geometry.view.top + geometry.view.bottom - geometry.height) / 2))).toBeLessThanOrEqual(1);
    }
    // When the view has room, successive cards must occupy separate space.
    if (geometry.view.right - geometry.view.left >= geometry.width * 3 && geometry.view.bottom - geometry.view.top >= geometry.height * 2) {
      for (const prior of positions) expect(geometry.right <= prior.left || geometry.left >= prior.right || geometry.bottom <= prior.top || geometry.top >= prior.bottom).toBe(true);
    }
    positions.push(geometry);
  }
  expect(new Set((await snapshot(page)).nodes.map(node => node.id)).size).toBe(4);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(stored);
  await expect(page.locator('#graph-errors')).toBeEmpty();
}
export async function checkQuickAddTouch(page) {
  await page.setViewportSize({ width: 390, height: 844 }); await seedQuickAdd(page);
  await openQuickAdd(page, true);
  const hold = page.getByRole('listbox', { name: 'Node types' }).getByRole('option', { name: 'Hold', exact: true });
  expect((await hold.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await hold.tap();
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Select hold', exact: true })).toBeFocused();
  await openQuickAdd(page, true);
  await page.locator('#graph-fit').tap();
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.locator('.graph-node')).toHaveCount(1);
}
