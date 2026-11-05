import { test, expect, openGraph } from './graph-fixture.js';
import { checkDisplayTabs } from '../fixtures/display-tabs.js';
test('MV3 Display tabs show only content and keep independent panes through switching, layout and restart', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await checkDisplayTabs(live, expect, true);
});

test('MV3 legacy Display graph Load/Import/Export/Reset and numbered Settings preserve unrelated wires', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  const old = await editor.evaluate(async () => {
    const { graphNode, edge, GRAPH_VERSION } = await import('./graph.js');
    const a = graphNode('Text', 'a'), b = graphNode('Text', 'b', 20, 300); a.settings.value = 'left'; b.settings.value = 'right';
    const main = graphNode('Display', 'main', 400, 20), summary = graphNode('Display', 'summary', 400, 400);
    main.settings = {}; summary.settings = {};
    return { version: GRAPH_VERSION, nodes: [a, b, main, summary, graphNode('Hold', 'held', 800, 20)], edges: [
      edge('a', 'value', 'main', 'input'), edge('b', 'value', 'summary', 'input'), edge('b', 'value', 'held', 'input'),
    ] };
  });
  const raw = JSON.stringify(old);
  await editor.evaluate(raw => localStorage.setItem('processing-graph-v1', raw), raw); await editor.reload();
  await expect(editor.getByRole('button', { name: 'main input input1', exact: true })).toBeVisible();
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  await expect(editor.getByLabel('main Remove last input', { exact: true })).toBeDisabled();
  await editor.getByLabel('main title', { exact: true }).fill('Main'); await editor.getByLabel('main title', { exact: true }).press('Tab');
  await editor.getByLabel('main Add input', { exact: true }).click();
  await editor.getByRole('button', { name: 'b output value', exact: true }).click();
  await editor.getByRole('button', { name: 'main input input2', exact: true }).click();
  for (const [port, label] of [['input1', 'Transcript'], ['input2', 'Translation']]) {
    await editor.getByLabel(`main ${port} tab label`, { exact: true }).fill(label);
    await editor.getByLabel(`main ${port} tab label`, { exact: true }).press('Tab');
  }
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  const saved = await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(saved.nodes.find(n => n.id === 'main').settings).toEqual({ title: 'Main', inputCount: 2, inputLabels: { input1: 'Transcript', input2: 'Translation' } });
  expect(saved.edges).toContainEqual({ from: ['b', 'value'], to: ['held', 'input'] });
  await editor.reload(); await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  await expect(editor.getByLabel('main title', { exact: true })).toHaveValue('Main');
  await expect(editor.getByLabel('main input2 tab label', { exact: true })).toHaveValue('Translation');
  await editor.getByLabel('main Remove last input', { exact: true }).click();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  const reduced = await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(reduced.edges).toEqual(saved.edges.filter(e => !(e.to[0] === 'main' && e.to[1] === 'input2')));
  // Import legacy JSON uses the same conversion without overwriting storage.
  await editor.locator('input[type="file"]').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(raw) });
  await expect(editor.getByRole('button', { name: 'main input input1', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  await expect(editor.getByLabel('main title', { exact: true })).toHaveValue('');
  const { clickGraphAction } = await import('./ui-controls.js');
  await clickGraphAction(editor, 'graph-load');
  await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  await expect(editor.getByLabel('main title', { exact: true })).toHaveValue('Main');
  const downloadPromise = editor.waitForEvent('download'); await clickGraphAction(editor, 'graph-export');
  const download = await downloadPromise;
  const { readFile } = await import('node:fs/promises');
  expect(JSON.parse(await readFile(await download.path(), 'utf8'))).toEqual(reduced);
  await live.reload(); await live.locator('#start').click();
  await expect(live.getByRole('tab')).toHaveCount(0);
  await expect(live.locator('.live-text-region:visible')).toHaveCount(2);
  await expect(live.locator('[data-display="summary"] .display-content')).toHaveText('right');
  await expect(live.locator('[data-display="main"] .display-content')).toHaveText('left');
  await live.locator('#stop').click();
  await clickGraphAction(editor, 'graph-reset');
  await expect(editor.getByRole('button', { name: 'transcript input input1', exact: true })).toBeVisible();
  expect(await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(reduced);
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  const reset = await editor.evaluate(async () => {
    const { defaultGraph, readGraph } = await import('./graph.js'); return { actual: readGraph(localStorage), expected: defaultGraph() };
  });
  expect(reset.actual).toEqual(reset.expected);
});

test('MV3 model-free example renders three input tabs in one Display with touch switching', async ({ graphExtension: f }) => {
  const { readFile } = await import('node:fs/promises');
  const graph = JSON.parse(await readFile('docs/examples/display-tabs.json', 'utf8'));
  const live = await openGraph(f);
  await live.editor.locator('input[type="file"]').setInputFiles({ name: 'display-tabs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await live.editor.locator('#graph-save').click(); await expect(live.editor.locator('#graph-save')).toBeEnabled();
  await live.reload(); await live.locator('#start').click();
  await expect(live.locator('#status')).toHaveText('Processing active');
  await expect(live.getByRole('tab')).toHaveText(['Transcript', 'Translation', 'Summary']);
  const mainTab = live.getByRole('tab', { name: 'Transcript', exact: true });
  const selectedBackground = await mainTab.evaluate(el => getComputedStyle(el).backgroundColor);
  await mainTab.hover();
  expect(await mainTab.evaluate(el => getComputedStyle(el).backgroundColor)).toBe(selectedBackground);
  await expect(live.locator('.live-display')).toHaveCount(1);
  await expect(live.locator('[data-display="main"] [data-port="input1"] .display-content')).toHaveText(graph.nodes[0].settings.value);
  const touch = await f.context.newCDPSession(live);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  for (const width of [1440, 390]) {
    await live.setViewportSize({ width, height: 900 });
    await live.getByRole('tab', { name: 'Transcript', exact: true }).click();
    expect(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.UPDATE_DISPLAY_SCREENSHOTS) await live.screenshot({ path: `docs/evidence/display-216-transcript-${width}.png`, fullPage: true });
    const summaryTab = live.getByRole('tab', { name: 'Summary', exact: true });
    await summaryTab.scrollIntoViewIfNeeded(); const box = await summaryTab.boundingBox();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
    await expect(live.locator('[data-port="input1"]')).toBeHidden();
    await expect(live.locator('[data-port="input2"]')).toBeHidden();
    await expect(live.locator('.live-text-region:visible')).toHaveCount(1);
    await expect(live.locator('[data-port="input3"] .display-content')).toHaveText(graph.nodes[2].settings.value);
    if (process.env.UPDATE_DISPLAY_SCREENSHOTS) await live.screenshot({ path: `docs/evidence/display-216-summary-${width}.png`, fullPage: true });
  }
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(live.locator('[data-port="input3"] .display-content')).toHaveText(graph.nodes[2].settings.value);
});


test('MV3 label/count edits apply next session; duplicate/blank labels and disconnected inputs survive Save/Load/Import/Export', async ({ graphExtension: f }) => {
  const { readFile } = await import('node:fs/promises');
  const graph = JSON.parse(await readFile('docs/examples/display-tabs.json', 'utf8'));
  const live = await openGraph(f), editor = live.editor;
  await editor.locator('input[type="file"]').setInputFiles({ name: 'display-tabs.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await live.reload(); await live.locator('#start').click();
  await expect(live.getByRole('tab')).toHaveText(['Transcript', 'Translation', 'Summary']);
  await live.getByRole('tab', { name: 'Summary', exact: true }).click();
  await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  for (const [port, label] of [['input1', 'Same'], ['input2', 'Same'], ['input3', ' ']]) {
    const field = editor.getByLabel(`main ${port} tab label`, { exact: true });
    await field.fill(label); await field.press('Tab');
  }
  await editor.getByLabel('main Add input', { exact: true }).click();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect(live.locator('#saved-state')).toBeVisible();
  await expect(live.getByRole('tab')).toHaveText(['Transcript', 'Translation', 'Summary']);
  await expect(live.getByRole('tab', { name: 'Summary', exact: true })).toHaveAttribute('aria-selected', 'true');
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); await live.locator('#start').click();
  await expect(live.getByRole('tab')).toHaveText(['Same', 'Same', 'Input 3', 'Input 4']);
  // Duplicate labels select different ports, with independent complete snapshots.
  for (const i of [1, 0]) {
    await live.getByRole('tab', { name: 'Same', exact: true }).nth(i).click();
    await expect(live.locator('.live-text-region:visible .display-content')).toHaveText(graph.nodes[i].settings.value);
  }
  await live.getByRole('tab', { name: 'Input 4', exact: true }).click();
  await expect(live.locator('.live-text-region:visible .display-content')).toBeEmpty();
  await expect(live.locator('.live-text-region button, .live-text-region [role="status"]')).toHaveCount(0);
  const saved = await editor.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(saved.edges).toEqual(graph.edges);
  const { clickGraphAction } = await import('./ui-controls.js');
  const downloadPromise = editor.waitForEvent('download'); await clickGraphAction(editor, 'graph-export');
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
  expect(exported).toEqual(saved);
  await editor.locator('input[type="file"]').setInputFiles({ name: 'round-trip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
  await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  await expect(editor.getByLabel('main input1 tab label', { exact: true })).toHaveValue('Same');
  await expect(editor.getByLabel('main input3 tab label', { exact: true })).toHaveValue(' ');
  await editor.getByLabel('main Remove last input', { exact: true }).click();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect(live.getByRole('tab')).toHaveCount(4);
  await live.locator('#cancel-session').click(); await expect(live.locator('#start')).toBeEnabled(); await live.locator('#start').click();
  await expect(live.getByRole('tab')).toHaveText(['Same', 'Same', 'Input 3']);
  await expect(live.locator('.live-text-region:visible')).toHaveCount(1);
  await clickGraphAction(editor, 'graph-load');
  await editor.getByRole('button', { name: 'Select main', exact: true }).click();
  await expect(editor.getByLabel('main input2 tab label', { exact: true })).toHaveValue('Same');
  await live.locator('#stop').click();
});
