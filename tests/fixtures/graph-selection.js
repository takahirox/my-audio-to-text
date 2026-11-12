import { expect } from '@playwright/test';

export async function loadSelectionGraph(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    const { graphNode, edge } = await import(new URL('./graph.js', location.href));
    const { saveLiveGraphData } = await import(new URL('./graph-library.js', location.href));
    await saveLiveGraphData(localStorage, { version: 15,
      nodes: [graphNode('Text', 'source', 20, 30), graphNode('Hold', 'hold', 340, 30), graphNode('Display', 'output', 680, 30)],
      edges: [edge('source', 'value', 'hold', 'input'), edge('hold', 'value', 'output', 'input1')] });
  });
  await page.reload();
}

export async function expectSelected(page, ids, inspected = ids.at(-1)) {
  expect(await page.locator('.selected-node').evaluateAll(cards => cards.map(card => card.dataset.node))).toEqual(ids);
  expect(await page.locator('.graph-heading[aria-pressed="true"]').evaluateAll(headings => headings.map(heading => heading.closest('.graph-node').dataset.node))).toEqual(ids);
  if (ids.length) await expect(page.locator('.graph-inspector')).toContainText(`Instance ID: ${inspected}`);
  else await expect(page.locator('.graph-inspector')).toContainText('Select a node or connection.');
}

export async function checkSelectionAppearance(page, info) {
  await loadSelectionGraph(page);
  const heading = page.getByRole('button', { name: 'Select source', exact: true });
  const hold = page.getByRole('button', { name: 'Select hold', exact: true });
  const card = page.locator('[data-node="source"]');
  // macOS WebKit includes buttons in keyboard traversal with Option+Tab.
  const tab = process.platform === 'darwin' && page.context().browser()?.browserType().name() === 'webkit' ? 'Alt+Tab' : 'Tab';
  const geometry = () => heading.evaluate(heading => {
    const rect = element => {
      const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height };
    };
    const range = document.createRange(); range.selectNodeContents(heading);
    const style = getComputedStyle(heading);
    return { heading: rect(heading), text: rect(range), card: rect(heading.closest('.graph-node')),
      padding: style.padding, before: getComputedStyle(heading, '::before').content, after: getComputedStyle(heading, '::after').content };
  });
  const before = await geometry(), unselectedShadow = await card.evaluate(el => getComputedStyle(el).boxShadow);
  expect(before.before).toBe('none'); expect(before.after).toBe('none');
  await heading.click(); await expectSelected(page, ['source']);
  expect(await geometry()).toEqual(before);
  expect(await card.evaluate(el => getComputedStyle(el).boxShadow)).not.toBe(unselectedShadow);
  await expect(heading).toHaveCSS('outline-style', 'none');
  if (info) await page.screenshot({ path: info.outputPath('pointer-selection.png') });
  await hold.click({ modifiers: ['Shift'] }); await expectSelected(page, ['source', 'hold']);
  // Establish keyboard modality before a modified pointer deselection. Browsers
  // can retain :focus-visible for Shift/Meta clicks and programmatic focus.
  await heading.focus(); await heading.press(tab); await page.keyboard.press(`Shift+${tab}`);
  await expect(heading).toHaveCSS('outline-style', 'dashed');
  await heading.click({ modifiers: ['Shift'] }); await expectSelected(page, ['hold']);
  await expect(heading).toBeFocused(); await expect(heading).toHaveCSS('outline-style', 'none');
  expect(await card.evaluate(el => getComputedStyle(el).boxShadow)).toBe(unselectedShadow);
  expect(await geometry()).toEqual(before);
  // Tab restores a distinct keyboard ring on an unselected heading without
  // changing selection, then Shift+Enter and Space keep their selection roles.
  await heading.press(tab); await page.keyboard.press(`Shift+${tab}`);
  await expect(heading).toBeFocused(); await expect(heading).toHaveCSS('outline-style', 'dashed');
  await expect(heading).toHaveCSS('outline-offset', '-3px');
  await expectSelected(page, ['hold']);
  if (info) await page.screenshot({ path: info.outputPath('keyboard-focus.png') });
  await heading.press('Shift+Enter');
  await expect(heading).toHaveAttribute('aria-pressed', 'true');
  await heading.press('Shift+Enter'); await expectSelected(page, ['hold']);
  await heading.press('Space'); await expectSelected(page, ['source']);
  await heading.press('Space'); await expectSelected(page, []);
  expect(await geometry()).toEqual(before);
}
