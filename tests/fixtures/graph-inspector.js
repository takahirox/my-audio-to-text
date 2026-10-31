import { expect } from '@playwright/test';

export async function checkStableInspector(page, width) {
  await page.setViewportSize({ width, height: 900 });
  const original = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
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
  await expect(inspector).toContainText('Node: audio');
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
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

export async function loadInputGraph(page) {
  await page.evaluate(async () => {
    const { graphNode, edge, saveGraph } = await import(new URL('./graph.js', location.href));
    const nodes = [graphNode('Text', 'source', 20, 20), graphNode('TextFormatter', 'first', 350, 20),
      graphNode('TextFormatter', 'second', 650, 20), graphNode('Text', 'alternate', 20, 400),
      graphNode('DOMCombiner', 'dom', 650, 400)];
    nodes[0].settings.value = 'Keep settings';
    saveGraph(localStorage, { version: 15, nodes, edges: [edge('source', 'value', 'first', 'input1'),
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
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  const { input, start, end } = await inputDragPoints(page);
  // A tap on an occupied input has no effect, and a cancelled drag keeps it.
  await input.click(); await expect(page.locator('#graph-state')).toContainText('Saved graph');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await expect(page.locator('.graph-canvas')).toHaveClass(/detaching/);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length);
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  // Dropping on a node heading is not empty canvas and must preserve the wire.
  const heading = await page.getByRole('button', { name: 'Select source', exact: true }).boundingBox();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length);
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length - 1);
  await expect(page.locator('.graph-scroll')).toBeFocused();
  await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(before);
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  const expected = { ...before, edges: before.edges.slice(1) };
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(expected);
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(expected.edges.length);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(expected);
}

export async function checkInputReconnect(page) {
  await page.setViewportSize({ width: 1440, height: 900 }); await loadInputGraph(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  const input = name => page.getByRole('button', { name, exact: true });
  // A cancelled pointer leaves the saved draft intact, including the old input.
  const { start, end } = await inputDragPoints(page);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 4 });
  await input('first input input1').dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  await expect(page.locator('.graph-wire')).toHaveCount(before.edges.length);
  // Invalid inputs and identical fan-out targets preserve both wires.
  await input('first input input1').dragTo(input('dom input first'));
  await expect(page.locator('#graph-state')).toContainText('Saved graph');
  await input('first input input1').dragTo(input('second input input1'));
  await expect(page.locator('#graph-state')).toContainText('Saved graph'); // identical fan-out target
  await input('first input input1').dragTo(input('first input input2'));
  await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
  await expect(page.locator('.graph-wire')).toHaveCount(2);
  await expect(input('first input input2')).toBeFocused();
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual({ ...before,
    edges: [before.edges[1], { from: ['source', 'value'], to: ['first', 'input2'] }] });
}

export async function checkRecovery(page, kind) {
  await page.setViewportSize({ width: 390, height: 900 });
  const { raw, backups } = await page.evaluate(async kind => {
    const { defaultGraph, GRAPH_KEY } = await import(new URL('./graph.js', location.href));
    const graph = defaultGraph({ enabled: true });
    const backups = { 'processing-graph-before-v9': 'older original\r\n',
      'processing-graph-before-v13': 'v13 original', 'processing-graph-before-v14': 'previous original', 'processing-graph-before-v14-2': 'numbered original\n' };
    for (const [key, value] of Object.entries(backups)) localStorage.setItem(key, value);
    if (kind === 'paired') {
      graph.version = 11;
      for (const route of graph.edges) if (route.to[0] === 'translated-format') route.to[1] = route.to[1] === 'input1' ? 'source' : 'text';
      graph.edges.push({ from: ['translation', 'error'], to: ['translated-format', 'error'] });
    }
    const raw = kind === 'invalid' ? '{ invalid JSON\r\n  original content' : JSON.stringify(graph, null, 2).replaceAll('\n', '\r\n');
    localStorage.setItem(GRAPH_KEY, raw); return { raw, backups };
  }, kind);
  await page.reload();
  const blocking = kind !== 'current';
  if (blocking) {
    await expect(page.locator('#errors')).toBeInViewport();
    await expect(page.locator('#errors')).toContainText('Graph actions → Recovery');
    await expect(page.locator('#errors')).toContainText(kind === 'paired' ? 'Review the unsaved repair draft' : 'Reset draft and Save');
  } else await expect(page.locator('#errors')).toBeEmpty();
  const recovery = page.locator('.graph-actions .graph-recovery');
  await expect(recovery).toBeHidden();
  await expect(page.getByText('Original saved graph (migration recovery copy)', { exact: true })).toHaveCount(0);
  await page.locator('.graph-actions > summary').click(); await recovery.locator('summary').click();
  const copies = blocking ? { 'Unsaved original': raw, ...backups } : backups;
  // Stub only the clipboard transport; Copy and Download use the real UI.
  await page.evaluate(() => { navigator.clipboard.writeText = async text => { window.recoveryCopied = text; }; });
  for (const [label, original] of Object.entries(copies)) {
    await page.getByLabel('Graph recovery version').selectOption({ label });
    await expect(page.getByLabel('Original saved graph JSON')).toHaveValue(original.replaceAll('\r\n', '\n'));
    await recovery.getByRole('button', { name: 'Copy JSON', exact: true }).click();
    expect(await page.evaluate(() => window.recoveryCopied)).toBe(original);
  }
  await page.getByLabel('Graph recovery version').selectOption({ label: Object.keys(copies)[0] });
  const [download] = await Promise.all([page.waitForEvent('download'), recovery.getByRole('button', { name: 'Download JSON', exact: true }).click()]);
  const stream = await download.createReadStream(); const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString('utf8')).toBe(Object.values(copies)[0]);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.graph-actions > summary').click();
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  await expect(page.locator('#errors')).toBeEmpty();
  await page.reload();
  await page.locator('.graph-actions > summary').click(); await recovery.locator('summary').click();
  if (blocking) {
    await page.getByLabel('Graph recovery version').selectOption({ label: 'processing-graph-before-v14-3' });
    await expect(page.getByLabel('Original saved graph JSON')).toHaveValue(raw.replaceAll('\r\n', '\n'));
  }
  for (const [key, value] of Object.entries(backups)) {
    expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(value);
    await page.getByLabel('Graph recovery version').selectOption({ label: key });
    await expect(page.getByLabel('Original saved graph JSON')).toHaveValue(value.replaceAll('\r\n', '\n'));
  }
  const saved = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  await page.locator('.graph-actions > summary').click(); await page.locator('#graph-save').click();
  await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(saved);
  if (blocking) expect(await page.evaluate(() => localStorage.getItem('processing-graph-before-v14-3'))).toBe(raw);
}
