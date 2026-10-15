// Follow the same disclosure controls a keyboard or pointer user sees.
export async function openPalette(page) {
  if (!await page.locator('#graph-palette').isVisible()) await page.locator('#graph-palette-toggle').click();
  await page.getByLabel('Search nodes', { exact: true }).fill('');
  await page.getByLabel('Node category', { exact: true }).selectOption('All categories');
}
export async function openTranslation(page) {
  if ((await page.locator('.graph-actions').getAttribute('open')) === null) await page.locator('.graph-actions > summary').click();
  if ((await page.locator('#graph-translation').getAttribute('open')) === null) await page.locator('#graph-translation > summary').click();
}
export async function clickGraphAction(page, id, { discard = true } = {}) {
  if ((await page.locator('.graph-actions').getAttribute('open')) === null) await page.locator('.graph-actions > summary').click();
  const confirm = dialog => discard ? dialog.accept() : dialog.dismiss();
  page.on('dialog', confirm);
  try { await page.locator(`#${id}`).click(); } finally { page.off('dialog', confirm); }
}
