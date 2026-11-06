import { test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkPortOrderAndHelp, checkPortGeometryAndInteractions } from '../fixtures/graph-port-order.js';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/extension/graph-editor.html');
});
test('all paired and dynamic ports share visual, keyboard and inspector order', async ({ page, browserName }) => {
  test.setTimeout(120000);
  // WebKit on macOS follows Safari's Option-Tab convention for buttons.
  await checkPortOrderAndHelp(page, browserName === 'webkit' && process.platform === 'darwin' ? 'Alt+Tab' : 'Tab');
});
test('named wire attachments, crossing comparison and gestures survive reordered rows at four zooms', async ({ page }, info) => {
  test.setTimeout(120000);
  const measurements = await checkPortGeometryAndInteractions(page);
  await info.attach('port-order-crossings', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  if (process.env.GRAPH_PORT_ORDER_EVIDENCE && info.project.name === 'chromium') {
    await writeFile('docs/evidence/graph-237-crossings.json', JSON.stringify(measurements, null, 2) + '\n');
  }
});
