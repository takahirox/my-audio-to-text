// Shared browser/MV3 checks against the production formatter and Live CSS.
export const livePreviewText = '  The next service <img src=x onerror=alert(1)>\n\tcontinues to the central station.  ';

export async function checkLivePreviewLayout(page, content, expect) {
  const rows = content.locator('tr'), tail = content.locator('.paired-text-tail');
  await expect(rows).toHaveCount(2);
  await expect(tail).toHaveText(livePreviewText, { useInnerText: false });
  expect(await tail.textContent()).toBe(livePreviewText);
  await expect(content.locator('img, script')).toHaveCount(0);
  await expect(tail).toHaveCSS('font-style', 'italic');
  await expect(content).toHaveAttribute('aria-label', 'Content');
  await expect(content.locator('table').first()).toHaveAttribute('aria-label', 'Paired texts');
  const geometry = await content.evaluate(root => {
    const box = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, padding: parseFloat(getComputedStyle(element).paddingLeft) };
    };
    return { viewport: innerWidth, rows: [...root.querySelectorAll('tr')].map(row => [...row.children].map(box)), tail: box(root.querySelector('.paired-text-tail')), scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  for (const [original, translation] of geometry.rows) {
    expect(original.y).toBeCloseTo(translation.y, 1);
    expect(original.height).toBeCloseTo(translation.height, 1);
    expect(original.width).toBeCloseTo(translation.width, 1);
    expect(geometry.tail.x).toBeCloseTo(original.x, 1);
    expect(geometry.tail.width).toBeCloseTo(original.width, 1);
    expect(geometry.tail.x + geometry.tail.width).toBeCloseTo(translation.x, 1);
    expect(geometry.tail.padding).toBeCloseTo(original.padding, 1);
  }
  expect(geometry.tail.y).toBeGreaterThanOrEqual(geometry.rows[1][0].y + geometry.rows[1][0].height);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  const cells = rows.first().locator('td');
  for (const side of [0, 1]) {
    await cells.nth(side).hover();
    const colors = await cells.evaluateAll(cells => cells.map(cell => getComputedStyle(cell).backgroundColor));
    expect(colors[0]).toBe(colors[1]); expect(colors[0]).not.toBe('rgba(0, 0, 0, 0)');
    const other = await rows.nth(1).locator('td').evaluateAll(cells => cells.map(cell => getComputedStyle(cell).backgroundColor));
    expect(other).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  }
  await page.mouse.move(0, 0);
  await cells.first().focus(); await cells.first().press('Tab'); await expect(cells.last()).toBeFocused();
  const focusedColors = await cells.evaluateAll(cells => cells.map(cell => getComputedStyle(cell).backgroundColor));
  expect(focusedColors[0]).toBe(focusedColors[1]); expect(focusedColors[0]).not.toBe('rgba(0, 0, 0, 0)');
  await content.focus();
  return geometry;
}

export async function checkLivePreviewCopy(page, content, expect) {
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedLiveText = text; } } }));
  const text = await content.innerText();
  await content.locator('..').getByRole('button', { name: 'Copy text', exact: true }).click();
  expect(await page.evaluate(() => window.copiedLiveText)).toBe(text);
  expect(text).toContain(livePreviewText);
  expect(text).not.toContain('paired-text-dom');
}
