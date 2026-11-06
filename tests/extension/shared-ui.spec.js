import { test, expect, openGraph } from './graph-fixture.js';
import { installLiveUIGraph } from '../fixtures/live-ui.js';
import { loadTraceabilityGraph, assertTraceability } from '../fixtures/graph-traceability.js';
import { assertRoutingGeometry } from '../fixtures/graph-routing.js';

async function capture(page, info, name, fullPage = false) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage });
  if (process.env.UPDATE_SHARED_UI_SCREENSHOTS) await page.screenshot({ path: `docs/evidence/ui-229-${name}.png`, fullPage });
}

// Actual computed foreground/background pairs, including wire colors.
async function checkContrast(page, selectors, background, minimum) {
  const pairs = await page.locator(selectors).evaluateAll((elements, background) => {
    const backdrop = getComputedStyle(document.querySelector(background)).backgroundColor;
    return elements.map(element => {
      const style = getComputedStyle(element);
      return { foreground: element.matches('.wire-line') ? style.stroke : style.color,
        background: style.backgroundColor === 'rgba(0, 0, 0, 0)' ? backdrop : style.backgroundColor };
    });
  }, background);
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
    const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
  for (const pair of pairs) {
    const a = luminance(pair.foreground), b = luminance(pair.background);
    expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), JSON.stringify(pair)).toBeGreaterThanOrEqual(minimum);
  }
}

test('Live, Graph and Models share light controls with reachable narrow layouts and dense routes', async ({ graphExtension: f }, info) => {
  const live = await openGraph(f), graph = live.editor, models = live.models;
  await installLiveUIGraph(live); await live.locator('#start').click();
  await expect(live.locator('#session-state')).toHaveText('Running');
  await loadTraceabilityGraph(graph);
  await models.reload();
  await expect(models.locator('#opus-ja-en .model-status')).toHaveText('Not downloaded');
  const original = await graph.evaluate(() => localStorage.getItem('processing-graph-v1'));
  for (const width of [1440, 390]) {
    for (const [name, page] of [['live', live], ['graph', graph], ['models', models]]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
      await expect(page.locator('nav [aria-current="page"]')).toHaveText(name === 'graph' ? 'Graph' : name === 'models' ? 'Models' : 'Live');
      for (const control of await page.locator('nav > *').all()) {
        await expect(control).toBeInViewport({ ratio: 1 });
        expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
      }
      if (name === 'graph') {
        await page.locator('#graph-fit').click();
        await assertTraceability(page); await assertRoutingGeometry(page);
        await page.getByRole('button', { name: 'Select previous', exact: true }).press('Enter');
        await expect(page.locator('.graph-inspector')).toContainText('Node: previous');
        await capture(page, info, `${name}-${width}`, width === 390);
        await page.locator('#graph-palette-toggle').press('Enter');
        await expect(page.getByRole('combobox', { name: 'Search nodes' })).toBeFocused();
        await capture(page, info, `palette-${width}`);
        await page.keyboard.press('Escape');
        await page.locator('#graph-help').press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await capture(page, info, `help-${width}`);
        await page.keyboard.press('Escape');
        await expect(page.locator('#graph-help')).toBeFocused();
      } else {
        await capture(page, info, `${name}-${width}`, name === 'models');
      }
    }
  }
  await checkContrast(models, '.model-heading h3, .model-status, .model-metadata, .model-license a, .actions button:not(:disabled)', '.model-card', 4.5);
  await checkContrast(graph, '.graph-heading, .graph-ports button:not(:disabled), .graph-ports small', '.graph-node', 4.5);
  await checkContrast(graph, '.wire-line', '.graph-scroll', 3);
  expect(await graph.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(original);
  // Keep a normal-scale dense screenshot to inspect crossings rather than only Fit.
  await graph.setViewportSize({ width: 1600, height: 1500 });
  await graph.locator('#graph-zoom').selectOption('1');
  await graph.locator('.graph-scroll').evaluate(el => { el.style.height = '1250px'; });
  await graph.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await graph.mouse.move(1500, 1400);
  await assertTraceability(graph);
  await capture(graph, info, 'dense-100');
  const wire = graph.locator('.graph-wire').first(), line = wire.locator('.wire-line');
  const normal = await line.evaluate(el => getComputedStyle(el).stroke);
  await wire.press('Enter');
  await expect(wire).toHaveAttribute('aria-pressed', 'true');
  await expect(wire).toHaveCSS('outline-style', 'none');
  await expect(line).toHaveCSS('stroke-width', '5px');
  expect(await line.evaluate(el => getComputedStyle(el).stroke)).not.toBe(normal);
  await checkContrast(graph, '.selected-wire .wire-line', '.graph-scroll', 3);
  await capture(graph, info, 'wire-selected');
  await wire.press('Escape');
  // Hover a real exposed segment, preserving a visible crossing casing.
  const { exposedWirePoint } = await import('../fixtures/graph-zoom.js');
  const point = await exposedWirePoint(wire);
  await graph.mouse.move(point.x, point.y);
  expect(await line.evaluate(el => parseFloat(getComputedStyle(el).strokeWidth))).toBe(4);
  await capture(graph, info, 'wire-hover');
});

test('Models keeps real cache progress, cancellation, retry, error, deletion and persistence usable', async ({ graphExtension: f }, info) => {
  const live = await openGraph(f), page = live.models;
  await page.setViewportSize({ width: 390, height: 844 });
  const card = page.locator('#opus-ja-en'), status = card.locator('.model-status');
  await expect(status).toHaveText('Not downloaded');
  await card.getByText('Verified files and size', { exact: true }).click();
  await expect(card.locator('li').first()).toContainText('Missing');
  f.mode('hold');
  await card.getByRole('button', { name: 'Download / retry' }).click();
  await expect(status).toHaveText('Downloading');
  await expect(card.locator('progress')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check cache' })).toBeDisabled();
  await capture(page, info, 'models-downloading-390', true);
  await card.getByRole('button', { name: 'Cancel download' }).click();
  await expect(status).toHaveText('Error');
  await expect(card.getByRole('button', { name: 'Download / retry' })).toBeFocused();
  await expect(card.getByRole('button', { name: 'Cancel download' })).toBeHidden();
  f.mode('corrupt');
  await card.getByRole('button', { name: 'Download / retry' }).click();
  await expect(status).toHaveText('Error');
  await expect(card.locator('.model-error')).toContainText('Retry preparation');
  await checkContrast(page, '#opus-ja-en .model-error, #opus-ja-en .model-status', '.model-card', 4.5);
  await capture(page, info, 'models-error-390', true);
  f.mode('normal');
  await card.getByRole('button', { name: 'Download / retry' }).click();
  await expect(status).toHaveText('Ready · Cached and verified');
  await expect(card.locator('li').first()).toContainText('Cached');
  await page.reload();
  await expect(status).toHaveText('Ready · Cached and verified');
  await card.getByRole('button', { name: 'Check cache' }).click();
  await expect(status).toHaveText('Ready · Cached and verified');
  await card.getByRole('button', { name: 'Delete cached assets' }).click();
  await expect(status).toHaveText('Not downloaded');
  await page.getByText('Storage and cache management', { exact: true }).click();
  await page.locator('#persist').click();
  const persisted = await page.evaluate(() => navigator.storage.persisted());
  await expect(page.locator('#persistence')).toHaveText(`Persistent storage: ${persisted ? 'granted' : 'denied'}.`);
  await expect(page.locator('footer')).toContainText('Gemma Terms');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  // Returning focuses the existing Live window, keeping its graph and session.
  expect((await f.context.pages()).filter(p => p.url() === f.url)).toHaveLength(1);
});
