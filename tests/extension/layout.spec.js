import { test, expect, openGraph, startGraph, emitFinal } from './graph-fixture.js';
import { clickGraphAction } from './ui-controls.js';
import { checkZoomRecovery } from '../fixtures/graph-zoom.js';

test('MV3 Fit and low zoom retain a reachable editing port in a narrow window', async ({ graphExtension: f }, info) => {
  const live = await openGraph(f);
  await live.editor.setViewportSize({ width: 390, height: 900 });
  await checkZoomRecovery(live.editor, 'large', info);
});

test('MV3 palette search/categories, contextual settings, keyboard controls and draft discard work in a narrow window', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 390, height: 844 });
  await expect(editor.locator('.graph-inspector')).toContainText('Select a node or connection.');
  await expect(editor.locator('#graph-translation')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Add Node', exact: true }).press('Enter');
  await expect(editor.getByLabel('Search nodes', { exact: true })).toBeFocused();
  await editor.getByLabel('Node category', { exact: true }).selectOption('Constants / utilities');
  await editor.getByLabel('Search nodes', { exact: true }).fill('Number');
  await expect(editor.locator('#graph-node-type [role="option"]')).toHaveCount(1);
  if (process.env.UPDATE_UI_SCREENSHOTS) await editor.screenshot({ path: 'docs/evidence/ui-109-palette.png', fullPage: true });
  await editor.getByLabel('Search nodes', { exact: true }).press('Enter');
  await expect(editor.getByRole('button', { name: 'Select number', exact: true })).toBeFocused();
  await expect(editor.locator('#graph-palette')).toBeHidden();
  await editor.getByLabel('number value', { exact: true }).fill('3.5');
  await editor.keyboard.press('Escape'); await expect(editor.locator('.graph-scroll')).toBeFocused();
  await editor.locator('#graph-fit').click();
  const fit = await editor.locator('#graph-zoom').inputValue().then(Number); expect(fit).toBeLessThan(.5);
  await expect(editor.locator('[data-node="number"]')).toBeInViewport();
  await editor.getByRole('button', { name: 'Select number', exact: true }).press('Enter');
  await editor.keyboard.press('Escape');
  await expect(editor.locator('.graph-inspector')).toContainText('Select a node or connection.');
  await editor.locator('#graph-palette-toggle').focus();
  await editor.keyboard.press('Tab'); await expect(editor.locator('#graph-save')).toBeFocused();
  await editor.keyboard.press('Tab'); await expect(editor.locator('.graph-actions > summary')).toBeFocused();
  await editor.keyboard.press('Enter'); await expect(editor.locator('#graph-validate')).toBeVisible();
  await editor.keyboard.press('Escape'); await expect(editor.locator('.graph-actions > summary')).toBeFocused();
  await clickGraphAction(editor, 'graph-reset', { discard: false });
  expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const commands = await editor.locator('.graph-command-list').boundingBox();
  expect(commands.x).toBeGreaterThanOrEqual(0); expect(commands.x + commands.width).toBeLessThanOrEqual(390);
  await expect(editor.locator('[data-node="number"]')).toHaveCount(1);
  await clickGraphAction(editor, 'graph-reset'); await expect(editor.locator('[data-node="number"]')).toHaveCount(0);
  expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await clickGraphAction(editor, 'graph-validate'); await expect(editor.locator('#graph-errors')).toContainText('Draft valid');
});

test('MV3 compact controls precede live outputs; preview, current value and independent translation Nodes reflect the graph', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await live.evaluate(async () => {
    const { defaultGraph, graphNode, edge } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    const graph = defaultGraph();
    graph.nodes.push(graphNode('Display', 'value'), graphNode('OpusMtJaEn', 'forward'), graphNode('OpusMtEnJa', 'reverse'), graphNode('Display', 'forward-output'), graphNode('Display', 'reverse-output'));
    graph.edges.push(edge('speech', 'final', 'value', 'input1'), edge('speech', 'final', 'forward', 'text'), edge('speech', 'final', 'reverse', 'text'), edge('forward', 'text', 'forward-output', 'input1'), edge('reverse', 'text', 'reverse-output', 'input1'));
    await saveLiveGraphData(localStorage, (graph));
  });
  await editor.reload();
  await expect(editor.locator('[data-node=forward]')).toContainText('OPUS-MT Japanese → English');
  await expect(editor.locator('[data-node=reverse]')).toContainText('OPUS-MT English → Japanese');
  await expect(editor.locator('#graph-translation')).toHaveCount(0);
  await startGraph(live); await emitFinal(live, '<em>committed</em>');
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'pending' }));
  await expect(live.locator('[data-display="transcript"] tr td:first-child')).toHaveText(['<em>committed</em>', 'pending']);
  await expect(live.locator('[data-display="value"]').getByLabel('Content', { exact: true })).toHaveText('<em>committed</em>');
  await expect(live.locator('#live-displays em')).toHaveCount(0);
  expect(await live.locator('#live-displays').evaluate(root => !!(document.querySelector('.capture-panel').compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(live.locator('#targets, #target-controls, #target-status, .target-row')).toHaveCount(0);
  await expect(live.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  // Cancellation is internal since #223; Live exposes Start/Stop only.
  await live.evaluate(() => window.graphSession.cancel());
  // Cancel retains the latest complete keyed history, including its last preview row.
  await expect(live.locator('[data-display="transcript"] tr td:first-child')).toHaveText(['<em>committed</em>', 'pending']);
});
