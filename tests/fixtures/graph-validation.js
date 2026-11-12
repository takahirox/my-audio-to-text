import { expect } from '@playwright/test';
import { clickGraphAction, settleAutoSave, recoverAsNew } from '../extension/ui-controls.js';

const geometry = page => page.evaluate(() => {
  const box = selector => {
    const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
    return { x, y, width, height };
  };
  const scroll = document.querySelector('.graph-scroll');
  return { workspace: box('.graph-workspace'), inspector: box('.graph-inspector'),
    viewport: box('.graph-scroll'), left: scroll.scrollLeft, top: scroll.scrollTop,
    zoom: document.querySelector('#graph-zoom').value, pageX: scrollX, pageY: scrollY };
});

export async function checkValidationPanel(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await settleAutoSave(page);
  await page.evaluate(async () => {
    const { defaultGraph, graphNode } = await import(new URL('./graph.js', location.href));
    const { saveLiveGraphData } = await import(new URL('./graph-library.js', location.href));
    const graph = defaultGraph();
    graph.nodes.push(graphNode('Number', 'duration', 20, 20));
    for (let i = 0; i < 32; i++) graph.nodes.push(graphNode('MicrophoneAudio', `parked-${i}`, 1500, i * 200));
    await saveLiveGraphData(localStorage, graph);
  });
  await page.reload(); await expect(page.locator('#graph-state')).toHaveText('Saved');
  const panel = page.getByRole('region', { name: 'Validation results', exact: true });
  await page.locator('#graph-zoom').selectOption('0.75');
  await page.locator('.graph-scroll').evaluate(el => { el.scrollLeft = 40; el.scrollTop = 30; });
  await page.evaluate(() => window.scrollTo(0, 0));
  const before = await geometry(page);
  await clickGraphAction(page, 'graph-validate');
  await expect(panel).toBeVisible(); await expect(panel).toBeFocused();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(panel).toContainText('Warning: Unconnected output Node: parked-31');
  expect(await geometry(page)).toEqual(before);
  const output = panel.locator('pre');
  expect(await output.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  const bounds = await panel.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
  expect(bounds.height).toBeLessThan((await page.locator('.graph-scroll').boundingBox()).height / 2);
  await output.focus(); await output.press('End');
  expect(await geometry(page)).toEqual(before);
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  expect(await geometry(page)).toEqual(before);
  await expect(page.locator('.graph-actions > summary')).toBeFocused();
  await clickGraphAction(page, 'graph-validate');
  await expect(panel).toHaveCount(1); expect(await geometry(page)).toEqual(before);

  // Editing remains possible, including before the typing transaction commits.
  await page.locator('#graph-zoom').selectOption('1');
  await page.getByRole('button', { name: 'Select audio', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Select duration', exact: true }).press('Shift+Enter');
  await expect(page.locator('#graph-create-subgraph')).toBeEnabled();
  await expect(page.locator('.graph-inspector')).toContainText('Instance ID: duration');
  const input = page.getByLabel('duration value', { exact: true });
  await input.scrollIntoViewIfNeeded(); await input.focus(); const beforeInvalid = await geometry(page);
  await input.fill('');
  await expect(panel.getByRole('status')).toContainText('Outdated');
  await expect(input).toBeFocused();
  await expect(page.locator('#graph-state')).toHaveText('Save failed');
  await expect(page.locator('#graph-errors')).toContainText('Error:');
  expect(await geometry(page)).toEqual(beforeInvalid);
  await expect(input).toBeFocused();
  await panel.getByRole('button', { name: 'Validate graph', exact: true }).focus();
  await panel.getByRole('button', { name: 'Validate graph', exact: true }).press('Enter');
  await expect(panel.getByRole('status')).toContainText('current graph');
  await expect(output).toContainText('Error: duration: Number.value must be a finite number.');
  await expect(panel.getByRole('button', { name: 'Validate graph', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#graph-save-error')).not.toBeEmpty();
  await expect(page.locator('#graph-errors')).toContainText('Error:');
  await expect(page.locator('.graph-notices')).toBeVisible();

  await input.fill('2'); await settleAutoSave(page);
  await expect(page.locator('#graph-errors')).toBeEmpty();
  await clickGraphAction(page, 'graph-validate');
  await expect(output).not.toContainText('Error:'); await expect(output).toContainText('Warning:');
  // A reset updates selection state and makes the old warnings explicitly stale.
  await clickGraphAction(page, 'graph-reset'); await settleAutoSave(page);
  await expect(page.locator('#graph-create-subgraph')).toBeDisabled();
  await expect(panel.getByRole('status')).toContainText('Outdated');
  await panel.getByRole('button', { name: 'Validate graph', exact: true }).focus();
  await panel.getByRole('button', { name: 'Validate graph', exact: true }).press('Enter');
  await expect(output).toContainText('Graph is valid.');
  await expect(output).not.toContainText('Warning:');
  await page.keyboard.press('Escape'); await expect(panel).toBeHidden();
}

export async function checkStableSelection(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.locator('.graph-scroll').focus(); await page.keyboard.press('Escape');
  const create = page.locator('#graph-create-subgraph');
  const inspector = page.locator('.graph-inspector');
  await expect(create).toBeVisible(); await expect(create).toBeDisabled();
  await expect(page.locator('#graph-palette-toggle + #graph-create-subgraph')).toHaveCount(1);
  await expect(page.locator('#graph-create-subgraph')).toHaveCount(1);
  const bounds = await create.boundingBox(), toolbar = await page.locator('.graph-toolbar').boundingBox();
  const first = page.getByRole('button', { name: 'Select audio', exact: true });
  const second = page.getByRole('button', { name: 'Select speech', exact: true });
  await first.press('Enter'); await expect(create).toBeDisabled();
  await second.press('Shift+Enter'); await expect(create).toBeEnabled();
  await expect(inspector).toContainText('Instance ID: speech');
  await expect(inspector).not.toContainText(/\d+ nodes? selected/);
  await expect(inspector.locator('#graph-create-subgraph, .graph-selection')).toHaveCount(0);
  expect(await create.boundingBox()).toEqual(bounds);
  expect(await page.locator('.graph-toolbar').boundingBox()).toEqual(toolbar);
  await second.press('Shift+Enter'); await expect(create).toBeDisabled();
  await expect(inspector).toContainText('Instance ID: audio');
  await first.press('Escape'); await expect(create).toBeDisabled();
}

export async function checkValidationPointer(page, { width = 390, touch = false } = {}) {
  await page.setViewportSize({ width, height: 844 });
  await settleAutoSave(page);
  // Each case gets its own entry so earlier edits do not add recovery notices.
  await recoverAsNew(page);
  const panel = page.getByRole('region', { name: 'Validation results', exact: true });
  const heading = page.getByRole('button', { name: 'Select audio', exact: true });
  await clickGraphAction(page, 'graph-validate');
  await expect(panel).toBeVisible();
  const before = await geometry(page);
  const results = await panel.locator('pre').textContent();
  const headingBox = await heading.boundingBox(), panelBox = await panel.boundingBox();
  // Reproduce the narrow-screen obstruction instead of selecting by keyboard.
  expect(headingBox.y + headingBox.height / 2).toBeGreaterThan(panelBox.y);
  expect(headingBox.y + headingBox.height / 2).toBeLessThan(panelBox.y + panelBox.height);
  const move = panel.getByRole('button', { name: 'Move results to bottom', exact: true });
  if (touch) await move.tap(); else await move.click();
  expect(await geometry(page)).toEqual(before);
  expect((await panel.boundingBox()).y).toBeGreaterThan(headingBox.y + headingBox.height);
  if (touch) await heading.tap(); else await heading.click();
  await expect(heading).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-inspector')).toContainText('Instance ID: audio');
  await expect(panel).toBeVisible();
  await expect(panel.locator('pre')).toHaveText(results);
  await expect(panel.getByRole('status')).toContainText('current graph');
  if (!touch) {
    const card = page.locator('[data-node="audio"]'), origin = await card.boundingBox();
    const target = await heading.boundingBox();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2 + 30, target.y + target.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    const moved = await card.boundingBox();
    expect(moved.x).toBeCloseTo(origin.x + 30, 0);
    expect(moved.y).toBeCloseTo(origin.y + 20, 0);
    await expect(panel.getByRole('status')).toContainText('Outdated');
  }
  // Save/runtime notices must not cover the actions in the lower placement.
  await clickGraphAction(page, 'graph-import');
  await page.locator('input[type=file]').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await expect(page.locator('#graph-errors')).toContainText('Cannot import graph');
  await page.keyboard.press('Escape'); // Failed import leaves Graph actions open.
  const notices = await page.locator('.graph-notices').boundingBox();
  expect(notices.y + notices.height).toBeLessThan((await panel.boundingBox()).y);
  await panel.getByRole('button', { name: 'Validate graph', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('current graph');
  await expect(panel).toHaveCount(1);
  // Moving back is keyboard accessible and leaves the canvas geometry intact.
  const afterEdit = await geometry(page);
  await panel.getByRole('button', { name: 'Move results to top', exact: true }).press('Enter');
  expect(await geometry(page)).toEqual(afterEdit);
  await expect(panel.getByRole('button', { name: 'Move results to bottom', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#graph-errors')).toContainText('Cannot import graph');
  await expect(page.locator('.graph-notices')).toBeVisible();
}
