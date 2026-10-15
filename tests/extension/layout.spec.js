import { test, expect, openGraph, startGraph, emitFinal } from './graph-fixture.js';
import { clickGraphAction } from './ui-controls.js';

test('MV3 palette search/categories, contextual settings, keyboard help and draft discard work in a narrow window', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 390, height: 844 });
  await expect(editor.locator('.graph-inspector')).toBeHidden();
  await expect(editor.locator('#graph-translation')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Add Node', exact: true }).press('Enter');
  await expect(editor.getByLabel('Search nodes', { exact: true })).toBeFocused();
  await editor.getByLabel('Node category', { exact: true }).selectOption('Constants / utilities');
  await editor.getByLabel('Search nodes', { exact: true }).fill('Number');
  await expect(editor.locator('#graph-node-type option')).toHaveCount(1);
  if (process.env.UPDATE_UI_SCREENSHOTS) await editor.screenshot({ path: 'docs/evidence/ui-109-palette.png', fullPage: true });
  await editor.locator('#graph-node-type').press('Enter');
  await expect(editor.getByLabel('number value', { exact: true })).toBeFocused();
  // Check before fill can automatically scroll an offscreen field.
  await expect(editor.getByLabel('number value', { exact: true })).toBeInViewport({ ratio: 1 });
  await editor.getByLabel('number value', { exact: true }).fill('3.5');
  await editor.keyboard.press('Escape'); await expect(editor.locator('#graph-palette-toggle')).toBeFocused();
  await editor.locator('#graph-fit').click();
  const fit = await editor.locator('#graph-zoom').inputValue().then(Number); expect(fit).toBeLessThan(.5);
  await expect(editor.locator('[data-node="number"]')).toBeInViewport();
  await editor.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(editor.locator('.graph-inspector')).toBeHidden();
  await editor.locator('#graph-help').click(); await expect(editor.getByRole('dialog')).toBeVisible();
  await editor.keyboard.press('Escape'); await expect(editor.locator('#graph-help')).toBeFocused();
  await clickGraphAction(editor, 'graph-reset', { discard: false });
  expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const commands = await editor.locator('.graph-command-list').boundingBox();
  expect(commands.x).toBeGreaterThanOrEqual(0); expect(commands.x + commands.width).toBeLessThanOrEqual(390);
  await expect(editor.locator('[data-node="number"]')).toHaveCount(1);
  await clickGraphAction(editor, 'graph-reset'); await expect(editor.locator('[data-node="number"]')).toHaveCount(0);
  expect(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await clickGraphAction(editor, 'graph-validate'); await expect(editor.locator('#graph-errors')).toContainText('Draft valid');
});

test('MV3 live outputs precede compact controls; preview, current value and independent translation Nodes reflect the graph', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await live.evaluate(async () => {
    const { defaultGraph, graphNode, edge, saveGraph } = await import('./graph.js');
    const graph = defaultGraph();
    graph.nodes.push(graphNode('LiveTextDisplay', 'value'), graphNode('OpusMtJaEn', 'forward'), graphNode('OpusMtEnJa', 'reverse'), graphNode('LiveTextDisplay', 'forward-output'), graphNode('LiveTextDisplay', 'reverse-output'));
    graph.edges.push(edge('speech', 'final', 'value', 'replace'), edge('speech', 'final', 'forward', 'text'), edge('speech', 'final', 'reverse', 'text'), edge('forward', 'text', 'forward-output', 'append'), edge('reverse', 'text', 'reverse-output', 'append'));
    saveGraph(localStorage, graph);
  });
  await editor.reload();
  await expect(editor.locator('[data-node=forward]')).toContainText('OPUS-MT Japanese → English');
  await expect(editor.locator('[data-node=reverse]')).toContainText('OPUS-MT English → Japanese');
  await expect(editor.locator('#graph-translation')).toHaveCount(0);
  await startGraph(live); await emitFinal(live, '<em>committed</em>');
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'pending' }));
  await expect(live.locator('[data-display="transcript"]').getByLabel('Preview', { exact: true })).toHaveText('pending');
  await expect(live.locator('[data-display="value"]').getByLabel('Current value', { exact: true })).toHaveText('<em>committed</em>');
  await expect(live.locator('#live-displays em')).toHaveCount(0);
  expect(await live.locator('#live-displays').evaluate(root => !!(root.compareDocumentPosition(document.querySelector('.capture-panel')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(live.locator('#targets')).not.toHaveAttribute('open', '');
  await expect(live.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await live.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(live.locator('[data-display="transcript"] li pre')).toHaveText(['<em>committed</em>']);
});
