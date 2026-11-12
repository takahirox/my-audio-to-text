import { settleAutoSave } from '../extension/ui-controls.js';
import { expect } from '@playwright/test';

export async function checkStableInspector(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const original = await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'));
  const inspector = page.locator('.graph-inspector'), scroll = page.locator('.graph-scroll');
  await expect(inspector).toContainText('Select a node or connection.');
  await scroll.evaluate(canvas => { canvas.scrollLeft = 10; canvas.scrollTop = 10; });
  const geometry = () => page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const scroll = document.querySelector('.graph-scroll');
    return { viewport: rect(scroll), inspector: rect(document.querySelector('.graph-inspector')),
      canvas: rect(document.querySelector('#graph-canvas')), left: scroll.scrollLeft, top: scroll.scrollTop,
      nodes: [...document.querySelectorAll('.graph-node')].map(rect) };
  });
  const before = await geometry();
  if (width === 1440) expect(before.inspector.width).toBe(280);
  else {
    expect(before.inspector.y).toBeGreaterThanOrEqual(before.viewport.y + before.viewport.height);
    expect(before.inspector.height).toBeLessThan(350);
  }
  const heading = page.getByRole('button', { name: 'Select audio', exact: true });
  await heading.focus(); await heading.press('Enter');
  await expect(heading).toBeFocused();
  await expect(inspector).toContainText('Instance ID: audio');
  expect(await geometry()).toEqual(before);
  await heading.press('Escape'); await expect(heading).toBeFocused();
  expect(await geometry()).toEqual(before);
  const wire = page.getByRole('button', { name: 'Select connection audio.audio to speech.audio', exact: true });
  await wire.evaluate(element => element.focus({ preventScroll: true })); await wire.press('Enter');
  await expect(wire).toBeFocused();
  await expect(inspector).toContainText('audio.audio → speech.audio');
  await expect(inspector.locator('#graph-disconnect')).toBeAttached();
  await expect(page.locator('#graph-canvas #graph-disconnect')).toHaveCount(0);
  expect(await geometry()).toEqual(before);
  await wire.press('Escape'); await expect(scroll).toBeFocused();
  await expect(inspector).toContainText('Select a node or connection.');
  expect(await geometry()).toEqual(before);
  await heading.press('Enter');
  await scroll.click({ position: { x: 4, y: 4 } });
  await expect(inspector).toContainText('Select a node or connection.');
  expect(await geometry()).toEqual(before);
  await expect(page.locator('#graph-state')).toContainText('Saved');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-library-v1'))).toBe(original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

export async function loadInputGraph(page) {
  await settleAutoSave(page);
  await page.evaluate(async () => {
    const { graphNode, edge } = await import(new URL('./graph.js', location.href)); const { saveLiveGraphData } = await import(new URL('./graph-library.js', location.href));
    const nodes = [graphNode('Text', 'source', 20, 20), graphNode('TextFormatter', 'first', 350, 20),
      graphNode('TextFormatter', 'second', 650, 20), graphNode('Text', 'alternate', 20, 400),
      graphNode('KeyedPairedTextAccumulator', 'dom', 650, 400)];
    nodes[0].settings.value = 'Keep settings';
    await saveLiveGraphData(localStorage, { version: 15, nodes, edges: [edge('source', 'value', 'first', 'input1'),
      edge('source', 'value', 'second', 'input1'), edge('alternate', 'value', 'first', 'input2')] });
  });
  await page.reload();
}

export async function inputDragPoints(page) {
  const input = page.getByRole('button', { name: 'first input input1', exact: true });
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox(), viewport = await page.locator('.graph-scroll').boundingBox();
  return { input, start: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    end: { x: viewport.x + viewport.width - 20, y: viewport.y + viewport.height - 20 } };
}

export async function checkInputDetach(page, width) {
  await page.setViewportSize({ width, height: 900 }); await loadInputGraph(page);
  await page.locator('#graph-zoom').selectOption('0.5');
  const before = await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
  const { input, start, end } = await inputDragPoints(page);
  // A tap on an occupied input has no effect, and a cancelled drag keeps it.
  await input.click(); await expect(page.locator('#graph-state')).toContainText('Saved');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await expect(page.locator('.graph-canvas')).toHaveClass(/detaching/);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length);
  await expect(page.locator('#graph-state')).toContainText('Saved');
  // Dropping on a node heading is not empty canvas and must preserve the wire.
  const heading = await page.getByRole('button', { name: 'Select source', exact: true }).boundingBox();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length);
  await expect(page.locator('#graph-state')).toContainText('Saved');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length - 1);
  await expect(page.locator('.graph-scroll')).toBeFocused();
  await expect(page.locator('#graph-state')).toHaveText(/Saving…|Saved/);
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(before);
  await settleAutoSave(page);
  const expected = { ...before, edges: before.edges.slice(1) };
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(expected);
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(expected.edges.length);
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(expected);
}

export async function checkInputReconnect(page) {
  await page.setViewportSize({ width: 1440, height: 900 }); await loadInputGraph(page);
  const before = await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
  const input = name => page.getByRole('button', { name, exact: true });
  // A cancelled pointer leaves the saved draft intact, including the old input.
  const { start, end } = await inputDragPoints(page);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 });
  await input('first input input1').dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  await expect(page.locator('#graph-state')).toContainText('Saved');
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length);
  // Invalid inputs and identical fan-out targets preserve both wires.
  await input('first input input1').dragTo(input('dom input pair'));
  await expect(page.locator('#graph-state')).toContainText('Saved');
  await input('first input input1').dragTo(input('second input input1'));
  await expect(page.locator('#graph-state')).toContainText('Saved'); // identical fan-out target
  await input('first input input1').dragTo(input('first input input2'));
  await expect(page.locator('#graph-state')).toHaveText(/Saving…|Saved/);
  await expect(page.locator('.graph-wire')).toHaveCount(2);
  await expect(input('first input input2')).toBeFocused();
  await settleAutoSave(page);
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual({ ...before,
    edges: [before.edges[1], { from: ['source', 'value'], to: ['first', 'input2'] }] });
}

export async function checkRecovery(page, kind) {
  const { corruptSavedGraph, recoverAsNew } = await import('../extension/ui-controls.js');
  const raw = await page.evaluate(async kind => {
    const { defaultGraph } = await import(new URL('./graph.js', location.href));
    const graph = defaultGraph(); if (kind === 'paired') graph.version = 11;
    if (kind === 'unsupported') graph.nodes.push({ id: 'retired', type: 'RetiredProcessor', settings: {}, position: { x: 0, y: 0 } });
    return kind === 'invalid' ? '{ invalid JSON' : JSON.stringify(graph, null, 2);
  }, kind);
  await corruptSavedGraph(page, raw); await page.reload();
  if (kind === 'current') { await expect(page.locator('#errors')).toBeEmpty(); return; }
  await expect(page.locator('#errors')).toContainText('Saved graph unavailable');
  await page.locator('.graph-actions > summary').click();
  await page.getByText('Saved JSON', { exact: true }).click();
  await expect(page.getByLabel('Original saved graph JSON')).toHaveValue(raw);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#graph-reset').click();
  await settleAutoSave(page); await expect(page.locator('#graph-save-error')).toContainText('original has been kept');
  await recoverAsNew(page);
  await expect(page.locator('#errors')).toBeEmpty();
}
