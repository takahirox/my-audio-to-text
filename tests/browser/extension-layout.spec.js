import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Exercise the real extension HTML/modules in both browser engines without
// Chrome capture APIs or model inference. Packaged MV3 tests cover those paths.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType });
  });
  await page.goto('/extension/graph-editor.html');
});

test('canvas-first editor: search, categories, keyboard add/settings/help, fit and safe draft commands', async ({ page }) => {
  await expect(page.locator('.graph-inspector')).toBeHidden();
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.locator('#translation-enabled')).toBeHidden();
  await expect(page.locator('footer')).toHaveCount(0);
  await expect(page.locator('#graph-state')).toHaveText('Saved graph · No active recording');
  const canvas = await page.locator('.graph-scroll').boundingBox();
  expect(canvas.width).toBeGreaterThan(1000);
  await page.locator('#graph-palette-toggle').press('Enter');
  await expect(page.getByLabel('Search nodes', { exact: true })).toBeFocused();
  await page.getByLabel('Node category', { exact: true }).selectOption('Processors');
  await page.getByLabel('Search nodes', { exact: true }).fill('OPUS');
  await expect(page.locator('#graph-node-type option')).toHaveCount(2);
  await page.getByLabel('Search nodes', { exact: true }).fill('no matching type');
  await expect(page.locator('#graph-add')).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'No matching nodes' })).toBeVisible();
  await page.getByLabel('Node category', { exact: true }).selectOption('Constants / utilities');
  await page.getByLabel('Search nodes', { exact: true }).fill('Number');
  await page.locator('#graph-node-type').press('Enter');
  await expect(page.getByLabel('number value', { exact: true })).toBeFocused();
  await expect(page.getByLabel('number value', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.graph-inspector')).toBeVisible();
  await expect(page.locator('.graph-inspector details')).not.toHaveAttribute('open', '');
  await page.getByLabel('number value', { exact: true }).fill('2.5');
  await page.keyboard.press('Escape');
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.locator('#graph-palette-toggle')).toBeFocused();
  await page.locator('#graph-fit').click();
  expect(await page.locator('#graph-zoom').inputValue().then(Number)).toBeLessThanOrEqual(1.5);
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page.locator('.graph-inspector')).toBeHidden();
  await expect(page.locator('.graph-scroll')).toBeFocused();
  await page.locator('#graph-help').click(); await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Reconnecting replaces');
  await page.keyboard.press('Escape'); await expect(page.locator('#graph-help')).toBeFocused();
  await page.getByText('Graph actions', { exact: true }).click();
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#graph-load').click();
  await expect(page.locator('[data-node="number"]')).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept()); await page.locator('#graph-load').click();
  await expect(page.locator('[data-node="number"]')).toHaveCount(0);
  await page.getByText('Graph actions', { exact: true }).click(); await page.locator('#graph-validate').click();
  await expect(page.locator('#graph-errors')).toHaveText('Draft valid. Save to use next session.');
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.graph-actions > summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const commands = await page.locator('.graph-command-list').boundingBox();
    expect(commands.x).toBeGreaterThanOrEqual(0); expect(commands.x + commands.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab'); await page.locator('#graph-save').focus();
    expect(await page.locator('#graph-save').evaluate(button => getComputedStyle(button).outlineStyle)).toBe('solid');
  }
});

for (const width of [390, 700]) {
  test(`keyboard addition reveals the focused setting at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Add Node', exact: true }).press('Enter');
    await page.getByLabel('Search nodes', { exact: true }).fill('Number');
    await page.locator('#graph-node-type').press('Enter');
    const value = page.getByLabel('number value', { exact: true });
    // Check before fill/click can automatically scroll an offscreen field.
    await expect(value).toBeFocused();
    await expect(value).toBeInViewport({ ratio: 1 });
    await value.fill('2.5');
  });
}

for (const action of ['Close settings', 'Remove transcript']) {
  test(`inspector text edits commit before a single ${action} click`, async ({ page }) => {
    const before = await page.evaluate(async () => {
      const { readGraph } = await import('/extension/graph.js');
      return { graph: readGraph(localStorage), stored: localStorage.getItem('processing-graph-v1') };
    });
    await page.getByRole('button', { name: 'Select transcript', exact: true }).click();
    await page.getByLabel('transcript label', { exact: true }).fill('Edited output');
    // Keep the field focused: the native click must commit its change on blur
    // without replacing the command between pointerdown and click.
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('.graph-inspector')).toBeHidden();
    await expect(page.locator('.graph-scroll')).toBeFocused();
    await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(before.stored);
    const expected = structuredClone(before.graph);
    if (action === 'Close settings') {
      expected.nodes.find(node => node.id === 'transcript').settings.label = 'Edited output';
      await page.getByRole('button', { name: 'Select transcript', exact: true }).click();
      await expect(page.getByLabel('transcript label', { exact: true })).toHaveValue('Edited output');
      await expect(page.locator('#graph-errors')).toBeEmpty();
    } else {
      expected.nodes = expected.nodes.filter(node => node.id !== 'transcript');
      expected.edges = expected.edges.filter(edge => edge.from[0] !== 'transcript' && edge.to[0] !== 'transcript');
      await expect(page.locator('[data-node="transcript"]')).toHaveCount(0);
      await expect(page.locator('.graph-node')).toHaveCount(expected.nodes.length);
      await expect(page.locator('.graph-wire')).toHaveCount(expected.edges.length);
      // An incomplete draft is saveable; Start selects only executable paths.
      await expect(page.locator('#graph-errors')).toBeEmpty();
    }
    await page.locator('#graph-save').click();
    await expect(page.locator('#graph-state')).toContainText('Saved graph');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(expected);
  });
}

test('live regions preserve committed DOM and plain text; previews are distinct and graph-driven', async ({ page }) => {
  const html = await readFile('extension/recorder.html', 'utf8');
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
  await page.evaluate(async () => {
    const { defaultGraph, graphNode, edge } = await import('/extension/graph.js');
    const { renderTextRegions } = await import('/extension/live-text-regions.js');
    const root = document.querySelector('#live-displays'), graph = defaultGraph();
    graph.nodes.push(graphNode('LiveTextDisplay', 'value')); graph.edges.push(edge('speech', 'final', 'value', 'replace'));
    window.renderLayout = (items, preview) => renderTextRegions(root, graph, { transcript: { items, preview }, value: { items: [], preview: 'A current value' } });
    window.renderLayout(['<b>committed</b>'], 'provisional');
    window.firstCommitted = root.querySelector('li');
    navigator.clipboard.writeText = async text => { window.copiedText = text; };
    window.clearRegions = () => renderTextRegions(root, { nodes: [], edges: [] }, {});
  });
  await expect(page.locator('.live-text-region')).toHaveCount(2);
  const transcript = page.locator('[data-display="transcript"]');
  await expect(transcript.getByLabel('Preview', { exact: true })).toHaveText('provisional');
  await expect(page.locator('[data-display="value"]').getByLabel('Current value', { exact: true })).toHaveText('A current value');
  await expect(page.locator('#live-displays b')).toHaveCount(0);
  expect(await transcript.locator('.display-preview').evaluate(pre => getComputedStyle(pre).borderLeftStyle)).toBe('dashed');
  await page.evaluate(() => window.renderLayout(['<b>committed</b>', 'second'], 'new preview'));
  expect(await page.evaluate(() => window.firstCommitted === document.querySelector('#live-displays li'))).toBe(true);
  await transcript.getByRole('button', { name: 'Copy text' }).click();
  expect(await page.evaluate(() => window.copiedText)).toBe('<b>committed</b>\nsecond\nnew preview');
  const output = await page.locator('#live-displays').boundingBox(), controls = await page.locator('.capture-panel').boundingBox();
  expect(output.y).toBeLessThan(controls.y);
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.clearRegions()); await expect(page.locator('.live-text-region')).toHaveCount(0);
});


test('v8 paired formatter migration is visibly reviewed, then saves a recoverable v9 graph', async ({ page }) => {
  const original = await page.evaluate(async () => {
    const { defaultGraph, edge, GRAPH_KEY } = await import('/extension/graph.js');
    const graph = defaultGraph({ enabled: true, direction: 'en-ja' }); graph.version = 8;
    const formatter = graph.nodes.find(n => n.id === 'translated-format');
    formatter.type = 'PairedTextFormatter'; formatter.settings = { direction: 'en-ja' };
    graph.nodes.find(n => n.id === 'translated').settings.label = 'Saved bilingual label';
    graph.edges = graph.edges.filter(e => e.to[0] !== formatter.id);
    for (const port of ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError']) graph.edges.push(edge('translation', port, formatter.id, port));
    graph.edges.find(e => e.from[0] === formatter.id).to[1] = 'replace';
    const raw = JSON.stringify(graph); localStorage.setItem(GRAPH_KEY, raw); return raw;
  });
  await page.reload(); await expect(page.locator('#errors')).toContainText('migration needs review');
  await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(original);
  await page.getByText('Original saved graph (migration recovery copy)', { exact: true }).click();
  await expect(page.getByLabel('Original saved graph JSON')).toHaveValue(original);
  await expect(page.locator('option[value=PairedTextFormatter]')).toHaveCount(0);
  await expect(page.locator('[data-node=translation] [data-side=output]')).toHaveCount(3);
  await expect(page.locator('[data-node=translated-format] [data-side=input]')).toHaveCount(3);
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-state')).toContainText('Saved graph');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
  expect(saved.version).toBe(9);
  expect(saved.nodes.find(n => n.id === 'translated').settings.label).toBe('Saved bilingual label');
  expect(saved.edges).toContainEqual({ from: ['translated-format', 'text'], to: ['translated', 'append'] });
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-before-v9'))).toBe(original);
  await page.reload(); await expect(page.locator('#errors')).toBeEmpty();
  await expect(page.getByLabel('Original saved graph JSON')).toHaveValue(original);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')))).toEqual(saved);
});
