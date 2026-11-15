import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Render the real editor without the application/model-preparation lifecycle.
// Selecting and searching are presentation-only and must never load a model.
test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/ai-presentation.html') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
      <link rel="stylesheet" href="/extension/app.css"><link rel="stylesheet" href="/extension/recorder.css"><link rel="stylesheet" href="/extension/graph.css">
      </head><body class="app-page editor-page"><main id="editor"></main></body></html>` });
    if (/^\/(extension|web)\/[\w.-]+\.(js|css)$/.test(pathname)) return route.fulfill({
      body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : 'text/css',
    });
    return route.continue();
  });
  await page.goto('/ai-presentation.html');
  await page.evaluate(async () => {
    const { GraphEditor } = await import('/extension/graph-editor.js');
    const { NODE_TYPES, GRAPH_VERSION, graphNode } = await import('/extension/graph.js');
    const types = [...Object.keys(NODE_TYPES).filter(type => NODE_TYPES[type].ai), 'Text', 'TextFormatter', 'Display', 'SpeakerOutput'];
    const graph = { version: GRAPH_VERSION, nodes: types.map((type,i)=>graphNode(type, type, i % 4 * 300, Math.floor(i / 4) * 420)), edges: [] };
    window.originalJSON = JSON.stringify(graph);
    window.editor = new GraphEditor(document.querySelector('#editor'), graph, {});
    window.aiFacts = Object.entries(NODE_TYPES).filter(([,definition])=>definition.ai).map(([type,definition])=>({
      type, label: definition.label, ...definition.ai,
      controls: Object.keys(definition.settings || {}).length + Object.keys(definition.textSettings || {}).length,
    }));
  });
});
for (const width of [1440, 320]) test(`all 16 AI cards, palette results and Settings facts at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const facts = await page.evaluate(() => window.aiFacts);
  const inspector = page.locator('.graph-inspector');
  await expect(page.locator('.graph-node .graph-ai-icon')).toHaveCount(16);
  for (const fact of facts) {
    const heading = page.locator(`[data-node="${fact.type}"] .graph-heading`);
    await expect(heading).toHaveAccessibleName(`Select ${fact.type}: ${fact.label} · ${fact.model} · AI`);
    await expect(heading.locator('.graph-ai-icon')).toHaveAttribute('aria-label', 'AI');
    await expect(heading.locator('.graph-node-model')).toHaveText(fact.model);
    const geometry = await heading.evaluate(element => ({
      width: element.clientWidth, content: element.scrollWidth,
      primary: parseFloat(getComputedStyle(element.querySelector('.graph-node-title')).fontSize),
      secondary: parseFloat(getComputedStyle(element.querySelector('.graph-node-model')).fontSize),
      cardWidth: element.closest('.graph-node').getBoundingClientRect().width,
    }));
    expect(geometry.content).toBeLessThanOrEqual(geometry.width);
    expect(geometry.secondary).toBeLessThan(geometry.primary);
    expect(geometry.cardWidth).toBeLessThan(260);
    await heading.focus(); await heading.press('Enter');
    await expect(heading).toBeFocused();
    await expect(heading).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector.locator('h3')).toHaveText(fact.label);
    await expect(inspector.locator('dt')).toHaveText(['Model', 'Languages', 'Runtime']);
    await expect(inspector.locator('dd')).toHaveText([fact.model, fact.languages, fact.runtime]);
    await expect(inspector.locator('.graph-model-facts input, .graph-model-facts select')).toHaveCount(0);
    await expect(inspector.locator('input, select, textarea')).toHaveCount(fact.controls);
    await heading.press('Escape');
    await expect(heading).toBeFocused();
  }
  for (const type of ['Text', 'TextFormatter', 'Display', 'SpeakerOutput']) {
    const heading = page.locator(`[data-node="${type}"] .graph-heading`);
    await expect(heading.locator('.graph-ai-icon, .graph-node-model')).toHaveCount(0);
    await heading.focus(); await heading.press('Enter');
    await expect(inspector.locator('.graph-model-facts')).toHaveCount(0);
  }
  await page.locator('#graph-palette-toggle').click();
  const search = page.getByRole('combobox', { name: 'Search nodes' });
  await expect(search).toBeFocused();
  await expect(page.locator('.graph-node-option .graph-ai-icon')).toHaveCount(16);
  for (const fact of facts) {
    await search.fill(fact.model);
    const option = page.locator(`[id="graph-option-${fact.type}"]`);
    await expect(option).toHaveAccessibleName(`${fact.label} · ${fact.model} · AI`);
    await expect(option.locator('.graph-node-title > span:last-child')).toHaveText(fact.label);
    await expect(option.locator('.graph-node-model')).toHaveText(fact.model);
    expect(await option.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  }
  await search.fill('Text Summarization');
  await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2);
  await expect(page.locator('.graph-node-option .graph-node-model')).toHaveText(['LFM2.5 1.2B JP', 'Qwen3.5 2B']);
  await search.press('ArrowDown');
  await expect(search).toHaveAttribute('aria-activedescendant', 'graph-option-TextSummaryQwen35');
  await expect(page.locator('#graph-option-TextSummaryQwen35')).toHaveAttribute('aria-selected', 'true');
  await search.press('Escape'); await expect(page.locator('#graph-palette-toggle')).toBeFocused();
  expect(await page.evaluate(() => JSON.stringify(window.editor.draft) === window.originalJSON)).toBe(true);
  await page.locator('#graph-fit').click();
  await page.locator('#graph-palette-toggle').click();
  await search.fill('Speech Synthesis');
  await page.screenshot({ path: info.outputPath(`ai-node-labels-${width}.png`) });
});
