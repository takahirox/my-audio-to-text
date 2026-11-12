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
    const { defaultGraph } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    await saveLiveGraphData(localStorage, defaultGraph({ direction, enabled }));
  }, { direction, enabled });
  await page.reload();
}
export async function clickGraphAction(page, id, { discard = true } = {}) {
  if ((await page.locator('.graph-actions').getAttribute('open')) === null) await page.locator('.graph-actions > summary').click();
  const confirm = dialog => discard ? dialog.accept() : dialog.dismiss();
  page.on('dialog', confirm);
  try { await page.locator(`#${id}`).click(); } finally { page.off('dialog', confirm); }
}

// Simulate corruption without validating/normalizing it or changing legacy keys.
export async function corruptSavedGraph(page, raw) {
  await page.evaluate(raw => {
    const key = 'processing-graph-library-v1', library = JSON.parse(localStorage.getItem(key));
    const id = new URLSearchParams(location.search).get('id') || library.assignments.live;
    const entry = library.graphs.find(entry => entry.id === id);
    try { entry.graph = JSON.parse(raw); } catch { entry.graph = null; }
    entry.source = raw; entry.revision = crypto.randomUUID(); library.revision = crypto.randomUUID();
    localStorage.setItem(key, JSON.stringify(library));
  }, raw);
}
export async function recoverAsNew(page, graph) {
  const id = await page.evaluate(async graph => {
    const { GraphLibrary, readLibrary } = await import(new URL('./graph-library.js', location.href));
    const { defaultGraph } = await import(new URL('./graph.js', location.href));
    const store = new GraphLibrary(localStorage);
    const next = await store.create({ name: 'Recovered graph', graph: graph || defaultGraph() });
    const id = next.graphs.at(-1).id; await store.assign('live', id, next.revision);
    return id;
  }, graph);
  const url = new URL(page.url()); url.searchParams.set('id', id); await page.goto(url.href);
}

// End a focused edit transaction and observe persistence, never sleep for a
// guessed debounce interval. Failure assertions inspect #graph-save-error.
export async function settleAutoSave(page) {
  await page.evaluate(() => document.activeElement?.blur());
  if (await page.locator('#graph-retry').isVisible()) await page.locator('#graph-retry').click();
  const { expect } = await import('@playwright/test');
  await expect(page.locator('#graph-state')).toHaveText(/^(Saved|Save failed)$/);
}
