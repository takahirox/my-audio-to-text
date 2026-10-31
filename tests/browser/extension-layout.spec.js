import { checkRecovery, checkInputReconnect, checkStableInspector, checkInputDetach } from '../fixtures/graph-inspector.js';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkZoomRecovery, expectInsideCanvas, exposedWirePoint, loadZoomGraph } from '../fixtures/graph-zoom.js';
import { openPalette, clickGraphAction } from '../extension/ui-controls.js';

// Exercise the real extension HTML/modules in both browser engines without
// Chrome capture APIs or model inference. Packaged MV3 tests cover those paths.
async function serveExtension(route) {
  const pathname = new URL(route.request().url()).pathname;
  if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
  const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
  await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType });
}
test.beforeEach(async ({ page }) => {
  await page.route('**/*', serveExtension);
  await page.goto('/extension/graph-editor.html');
});

for (const width of [390, 1440]) {
  test(`model requirements live in Help with keyboard access and focus recovery at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.context().route('**/*', serveExtension);
    // WebKit on macOS uses Option+Tab to include links in keyboard navigation.
    const optionTab = browserName === 'webkit' && process.platform === 'darwin';
    const tab = optionTab ? 'Alt+Tab' : 'Tab';
    const backTab = optionTab ? 'Alt+Shift+Tab' : 'Shift+Tab';
    const stored = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
    await openPalette(page);
    await page.locator('#graph-node-type').selectOption('TranslateGemmaEnJa');
    await page.locator('#graph-add').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#graph-editor > #graph-asset-notice')).toHaveCount(0);
    await expect(page.locator('#graph-asset-notice')).toBeHidden();
    await page.locator('#graph-help').press('Enter');
    const help = page.getByRole('dialog', { name: 'Graph Editor help' });
    const notice = help.locator('#graph-asset-notice'), summary = notice.locator('summary');
    await expect(summary).toBeVisible(); await expect(summary).toBeInViewport({ ratio: 1 });
    await expect(summary).toBeFocused();
    await expect(notice).not.toHaveAttribute('open');
    await expect(notice.locator('p')).toBeHidden();
    await summary.press('Enter');
    await expect(notice.locator('p')).toBeVisible();
    await expect(notice).toContainText('3.112 GB shared by both directions');
    await expect(notice).toContainText('7 GB free storage');
    await expect(notice).toContainText('Google Gemma Terms of Use and Prohibited Use Policy');
    await summary.press(tab);
    const models = notice.getByRole('link', { name: 'Models for preparation, recovery and model license/terms' });
    await expect(models).toBeFocused();
    await expect(models).toHaveAttribute('href', 'model-cache.html');
    await expect(models).toHaveAttribute('target', '_blank');
    const popup = page.waitForEvent('popup'); await models.press('Enter');
    const modelsPage = await popup;
    await expect(modelsPage.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
    await modelsPage.waitForLoadState('load'); await modelsPage.close();
    await models.press(backTab); await expect(summary).toBeFocused();
    await summary.press('Space'); await expect(notice).not.toHaveAttribute('open');
    await summary.press('Enter');
    await models.press(tab);
    const terms = help.getByRole('link', { name: 'TranslateGemma terms, prohibited-use policy and attribution' });
    await expect(terms).toBeFocused();
    await expect(terms).toHaveAttribute('href', '../web/licenses/gemma-notices.txt');
    expect(await help.evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    await terms.press(tab);
    await expect(help.getByRole('button', { name: 'Close help' })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(help).toBeHidden();
    await expect(page.locator('#graph-help')).toBeFocused();
    await page.locator('#graph-help').press('Space'); await expect(help).toBeVisible();
    await page.keyboard.press('Escape'); await expect(help).toBeHidden();
    await expect(page.locator('#graph-help')).toBeFocused();
    await expect(page.locator('[data-node="translategemmaenja"]')).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(stored);
  });
}

test('Help notices follow draft additions/removals, saved loading and reset without preparing models', async ({ page }) => {
  const { types, notices } = await page.evaluate(async () => {
    const { NODE_TYPES, defaultGraph, graphNode, saveGraph } = await import('/extension/graph.js');
    const types = Object.keys(NODE_TYPES).filter(type => NODE_TYPES[type].preparationNotice);
    const graph = defaultGraph();
    graph.nodes.push(...types.map(type => graphNode(type, type.toLowerCase())));
    saveGraph(localStorage, graph);
    return { types, notices: [...new Set(types.map(type => NODE_TYPES[type].preparationNotice))].join(' ') };
  });
  await page.reload();
  const stored = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  const preparationRequests = [];
  page.on('request', request => { if (new URL(request.url()).origin !== new URL(page.url()).origin) preparationRequests.push(request.url()); });
  const notice = page.locator('#graph-asset-notice');
  const showNotices = async expected => {
    await page.locator('#graph-help').click();
    if (await notice.getAttribute('open') === null) await notice.locator('summary').click();
    await expect(notice.locator('p')).toHaveText(expected);
    await page.keyboard.press('Escape');
  };
  await showNotices(notices);
  // Remove every notice-bearing Node via the inspector, including both Gemma directions.
  for (const type of types) {
    await page.getByRole('button', { name: `Select ${type.toLowerCase()}`, exact: true }).press('Enter');
    await page.getByRole('button', { name: `Remove ${type.toLowerCase()}`, exact: true }).click();
  }
  await showNotices('No model preparation notices for Nodes in the current draft.');
  await openPalette(page); await page.locator('#graph-node-type').selectOption('SpeechToTextParakeetV3');
  await page.locator('#graph-add').click(); await page.keyboard.press('Escape');
  await page.locator('#graph-help').click();
  await expect(notice.locator('p')).toContainText('Parakeet v3: Save prepares 1.26 GB.');
  await expect(notice.locator('p')).not.toContainText('TranslateGemma');
  await page.keyboard.press('Escape');
  await clickGraphAction(page, 'graph-load'); await showNotices(notices);
  await clickGraphAction(page, 'graph-reset');
  await showNotices('No model preparation notices for Nodes in the current draft.');
  await clickGraphAction(page, 'graph-load'); await showNotices(notices);
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(stored);
  expect(preparationRequests).toEqual([]);
});

for (const width of [390, 1440]) {
  test(`canvas headings hide IDs while duplicate nodes remain identifiable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const labels = await page.evaluate(async () => {
      const { defaultGraph, graphNode, nodeDefinition, saveGraph } = await import('/extension/graph.js');
      const graph = defaultGraph();
      graph.nodes.push(graphNode('SpeechToTextReazonSpeech', 'speech-second', 270, 330));
      saveGraph(localStorage, graph);
      return graph.nodes.map(node => nodeDefinition(node).label);
    });
    await page.reload();
    const original = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
    await expect(page.locator('.graph-heading')).toHaveText(labels);
    const first = page.getByRole('button', { name: 'Select speech', exact: true });
    const second = page.getByRole('button', { name: 'Select speech-second', exact: true });
    await expect(second).toHaveText(await first.textContent());
    await expect(first).toHaveAccessibleName('Select speech');
    await expect(second).toHaveAccessibleName('Select speech-second');
    await first.click();
    const inspector = page.getByRole('complementary', { name: 'Graph details inspector' });
    await expect(inspector.getByText('Node: speech', { exact: true })).toBeVisible();
    await second.press('Enter');
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute('aria-pressed', 'true');
    await expect(first).toHaveAttribute('aria-pressed', 'false');
    await expect(inspector.getByText('Node: speech-second', { exact: true })).toBeVisible();
    await first.press('Space');
    await expect(inspector.getByText('Node: speech', { exact: true })).toBeVisible();
    await second.press('Space');
    await page.locator('#graph-zoom').selectOption('0.25');
    await page.getByRole('button', { name: 'Edit at 100%', exact: true }).press('Enter');
    await expect(second).toBeFocused();
    await expectInsideCanvas(second);
    await expect(inspector.getByText('Node: speech-second', { exact: true })).toBeVisible();
    await expect(page.locator('#graph-errors')).toBeEmpty();
    await expect(page.locator('#graph-state')).toContainText('Saved graph');
    await page.locator('#graph-save').click();
    await expect(page.locator('#graph-save')).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(original);
    await page.reload();
    await expect(page.locator('.graph-heading')).toHaveText(labels);
    await second.click();
    await expect(inspector.getByText('Node: speech-second', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(original);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const width of [390, 1440]) for (const size of ['default', 'large']) {
  test(`zoom overview returns to the editing port: ${size} graph at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await checkZoomRecovery(page, size, info);
  });
}

test('returning from Fit retains the selected wire and its keyboard Disconnect action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await loadZoomGraph(page);
  await page.getByRole('button', { name: 'literal-29 output value', exact: true }).press('Space');
  await page.locator('#graph-fit').press('Enter');
  const wire = page.getByRole('button', { name: 'Select connection speech.final to transcript-accumulator.append', exact: true });
  await wire.press('Enter');
  await page.locator('#graph-edit-scale').press('Enter');
  await expect(wire).toBeFocused(); await expect(wire).toHaveAttribute('aria-pressed', 'true');
  await wire.press('Tab');
  await expect(page.locator('#graph-disconnect')).toBeFocused();
  await expect(page.locator('.graph-inspector #graph-disconnect')).toBeInViewport({ ratio: 1 });
  await page.locator('#graph-disconnect').press('Enter'); await expect(wire).toHaveCount(0);
});

for (const zoom of ['0.25', '0.5', '0.75', 'fit']) {
  test(`keyboard connections, movement and disconnect preserve semantics at ${zoom}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await loadZoomGraph(page);
    if (zoom === 'fit') await page.locator('#graph-fit').press('Enter');
    else await page.locator('#graph-zoom').selectOption(zoom);
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
    const wire = page.getByRole('button', { name: 'Select connection audio.audio to speech.audio', exact: true });
    await wire.press('Enter'); await wire.press('Tab');
    const disconnect = page.locator('#graph-disconnect');
    await expect(disconnect).toBeFocused(); await expect(disconnect).toBeInViewport({ ratio: .99 });
    expect((await disconnect.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await disconnect.press('Shift+Tab'); await expect(wire).toBeFocused();
    await wire.press('Tab'); await disconnect.press('Space'); await expect(wire).toHaveCount(0);
    await expect(page.locator('.graph-scroll')).toBeFocused();
    await page.getByRole('button', { name: 'speech output final', exact: true }).press('Space');
    await expect(page.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'audio output audio', exact: true }).press('Enter');
    await page.getByRole('button', { name: 'speech input audio', exact: true }).press('Space');
    await expect(wire).toHaveCount(1);
    const heading = page.getByRole('button', { name: 'Select speech', exact: true });
    await heading.press('ArrowRight'); await expect(heading).toBeFocused();
    await expect(page.locator('[data-node="speech"]')).toHaveCSS('left', '280px');
    await page.locator('#graph-edit-scale').press('Enter');
    await expect(heading).toBeFocused(); await expectInsideCanvas(heading);
    await heading.press('Enter');
    await expect(page.locator('.graph-inspector')).toBeVisible();
    await expectInsideCanvas(heading);
    await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await page.locator('#graph-save').click();
    await expect(page.locator('#graph-state')).toContainText('Saved graph');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));
    expect(saved.edges).toEqual([...original.edges.slice(1), original.edges[0]]);
    expect(saved.nodes).toEqual(original.nodes.map(node => node.id === 'speech' ? { ...node, position: { ...node.position, x: 280 } } : node));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const zoom of ['0.25', 'fit', '1.5']) {
  test(`pointer connections, disconnect and scaled movement work at ${zoom}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await loadZoomGraph(page);
    if (zoom === 'fit') await page.locator('#graph-fit').click(); else await page.locator('#graph-zoom').selectOption(zoom);
    await page.getByRole('button', { name: 'speech output final', exact: true }).click();
    await page.getByRole('button', { name: 'transcript-preview input text', exact: true }).click();
    const wire = page.getByRole('button', { name: 'Select connection speech.final to transcript-preview.text', exact: true });
    await expect(wire).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Select connection speech.provisional to transcript-preview.text', exact: true })).toHaveCount(0);
    const point = await exposedWirePoint(wire); await page.mouse.click(point.x, point.y);
    await expect(page.locator('#graph-disconnect')).toBeVisible();
    await page.locator('#graph-disconnect').scrollIntoViewIfNeeded();
    await expect(page.locator('.graph-inspector #graph-disconnect')).toBeInViewport({ ratio: 1 });
    await page.locator('#graph-disconnect').click(); await expect(wire).toHaveCount(0);
    const heading = page.getByRole('button', { name: 'Select speech', exact: true });
    await heading.scrollIntoViewIfNeeded(); const box = await heading.boundingBox();
    const scale = Number(await page.locator('#graph-zoom').inputValue());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80 * scale, box.y + box.height / 2 + 40 * scale, { steps: 5 }); await page.mouse.up();
    const position = await page.locator('[data-node="speech"]').evaluate(card => ({ x: parseFloat(card.style.left), y: parseFloat(card.style.top) }));
    // Native pointer coordinates round to screen pixels, amplified at tiny Fit.
    expect(Math.abs(position.x - 350) * scale).toBeLessThanOrEqual(1);
    expect(Math.abs(position.y - 70) * scale).toBeLessThanOrEqual(1);
    await expect(page.locator('#graph-errors')).toBeEmpty();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('touch returns from an overview to connect typed ports, move a node and disconnect', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 900 } });
  const page = await context.newPage();
  await page.route('**/*', serveExtension);
  await page.goto('/extension/graph-editor.html');
  await loadZoomGraph(page);
  const wire = page.getByRole('button', { name: 'Select connection speech.provisional to transcript-preview.text', exact: true });
  for (const zoom of ['0.25', 'fit']) {
    if (zoom === 'fit') await page.locator('#graph-fit').tap(); else await page.locator('#graph-zoom').selectOption(zoom);
    // Overview targets may be just 4px tall. The full-size action is the touch
    // route back to editing; edge semantics remain covered at low zoom above.
    await page.getByRole('button', { name: 'Edit at 100%', exact: true }).tap();
    await page.getByRole('button', { name: 'audio output audio', exact: true }).tap();
    await expect(page.getByRole('button', { name: 'transcript-preview input text', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'audio output audio', exact: true }).tap();
    const point = await exposedWirePoint(wire);
    await page.touchscreen.tap(point.x, point.y);
    const disconnect = page.locator('#graph-disconnect');
    await expect(disconnect).toBeVisible(); await disconnect.scrollIntoViewIfNeeded(); await expect(disconnect).toBeInViewport({ ratio: .99 });
    expect((await disconnect.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await disconnect.tap(); await expect(wire).toHaveCount(0);
    await page.getByRole('button', { name: 'speech output provisional', exact: true }).tap();
    await page.getByRole('button', { name: 'transcript-preview input text', exact: true }).tap();
    await expect(wire).toHaveCount(1);
    await page.locator('#graph-zoom').selectOption('0.25');
    await page.getByRole('button', { name: 'Edit at 100%', exact: true }).tap();
    const input = page.getByRole('button', { name: 'transcript-preview input text', exact: true });
    await expect(input).toBeFocused(); await expectInsideCanvas(input);
  }
  const heading = page.getByRole('button', { name: 'Select speech', exact: true });
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 5 }); await page.mouse.up();
  await expect(page.locator('[data-node="speech"]')).toHaveCSS('left', '290px');
  await page.locator('#graph-save').tap(); await expect(page.locator('#graph-state')).toContainText('Saved graph');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

test('canvas-first editor: search, categories, keyboard add/settings/help, fit and safe draft commands', async ({ page }) => {
  await expect(page.locator('.graph-inspector')).toContainText('Select a node or connection.');
  await expect(page.locator('#graph-palette')).toBeHidden();
  await expect(page.locator('#translation-enabled')).toBeHidden();
  await expect(page.locator('footer')).toHaveCount(0);
  await expect(page.locator('#graph-state')).toHaveText('Saved graph · No active recording');
  const canvas = await page.locator('.graph-scroll').boundingBox();
  expect(canvas.width).toBeGreaterThan(600);
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
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.locator('.graph-inspector')).toContainText('Select a node or connection.');
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

for (const action of ['Clear selection', 'Remove transcript']) {
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
    await expect(page.locator('.graph-inspector')).toContainText('Select a node or connection.');
    await expect(page.locator('.graph-scroll')).toBeFocused();
    await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
    expect(await page.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(before.stored);
    const expected = structuredClone(before.graph);
    if (action === 'Clear selection') {
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

test('live regions replace safe DOM snapshots and copy verbatim at narrow widths', async ({ page }) => {
  const html = await readFile('extension/recorder.html', 'utf8');
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''));
  await page.evaluate(async () => {
    const { defaultGraph, graphNode } = await import('/extension/graph.js');
    const { renderTextRegions } = await import('/extension/live-text-regions.js');
    const root = document.querySelector('#live-displays'), graph = defaultGraph();
    graph.nodes.push(graphNode('LiveTextDisplay', 'value'));
    const { TextToDOMNode } = await import('/web/dom-nodes.js');
    const toDOM = text => {
      let snapshot;
      new TextToDOMNode().receive('text', text, { signal: new AbortController().signal, emit: (_, dom) => snapshot = dom });
      return snapshot;
    };
    window.renderLayout = text => renderTextRegions(root, graph, { transcript: toDOM(text), value: toDOM('A current value') });
    window.renderLayout('<b>committed</b>'); window.firstText = root.querySelector('.display-content').firstChild;
    navigator.clipboard.writeText = async text => { window.copiedText = text; };
    window.clearRegions = () => renderTextRegions(root, { nodes: [], edges: [] }, {});
  });
  await expect(page.locator('.live-text-region')).toHaveCount(2);
  const transcript = page.locator('[data-display="transcript"]');
  await expect(transcript.getByLabel('Content', { exact: true })).toHaveText('<b>committed</b>');
  await expect(page.locator('[data-display="value"]').getByLabel('Content', { exact: true })).toHaveText('A current value');
  await expect(page.locator('#live-displays b')).toHaveCount(0);
  await page.evaluate(() => window.renderLayout('<b>committed</b>\nsecond\nnew preview'));
  expect(await page.evaluate(() => window.firstText === document.querySelector('#live-displays .display-content').firstChild)).toBe(false);
  await transcript.getByRole('button', { name: 'Copy text' }).click();
  expect(await page.evaluate(() => window.copiedText)).toBe('<b>committed</b>\nsecond\nnew preview');
  const output = await page.locator('#live-displays').boundingBox(), controls = await page.locator('.capture-panel').boundingBox();
  expect(controls.y).toBeLessThan(output.y);
  for (const width of [390, 700]) {
    await page.setViewportSize({ width, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.clearRegions()); await expect(page.locator('.live-text-region')).toHaveCount(0);
});

for (const width of [390, 1440]) {
  test(`selection keeps inspector and canvas geometry stable at ${width}px`, async ({ page }) => {
    await checkStableInspector(page, width);
  });
  test(`connected input drag detaches only its wire at ${width}px`, async ({ page }) => {
    await checkInputDetach(page, width);
  });
}

test('input-end dragging reconnects transactionally and cancellation preserves the wire', async ({ page }) => {
  await checkInputReconnect(page);
});
for (const kind of ['current', 'paired', 'invalid']) test(`Graph actions recovery preserves exact ${kind} originals and numbered backups`, async ({ page }) => {
  await checkRecovery(page, kind);
});
