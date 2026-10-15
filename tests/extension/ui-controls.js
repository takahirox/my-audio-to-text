// Follow the same disclosure controls a keyboard or pointer user sees.
export async function openPalette(page) {
  if (!await page.locator('#graph-palette').isVisible()) await page.locator('#graph-palette-toggle').click();
  await page.getByLabel('Search nodes', { exact: true }).fill('');
  await page.getByLabel('Node category', { exact: true }).selectOption('All categories');
}
// Seed an existing saved graph for runtime tests. UI composition and automatic
// Save preparation are covered separately in graph-models.spec.js.
export async function loadTranslationFixture(page, direction = 'ja-en', enabled = true) {
  await page.evaluate(async ({ direction, enabled }) => {
    const { defaultGraph, saveGraph } = await import('./graph.js');
    saveGraph(localStorage, defaultGraph({ direction, enabled }));
  }, { direction, enabled });
  await page.reload();
}
export async function clickGraphAction(page, id, { discard = true } = {}) {
  if ((await page.locator('.graph-actions').getAttribute('open')) === null) await page.locator('.graph-actions > summary').click();
  const confirm = dialog => discard ? dialog.accept() : dialog.dismiss();
  page.on('dialog', confirm);
  try { await page.locator(`#${id}`).click(); } finally { page.off('dialog', confirm); }
}
