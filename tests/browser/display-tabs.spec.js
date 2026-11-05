import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkDisplayTabs } from '../fixtures/display-tabs.js';
test('Display tabs retain independent panes, background processing, scroll, selection, copy and lifecycle', async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
    const body = ['/extension/recorder.js', '/extension/navigation.js'].includes(pathname) ? '' : await readFile(path.resolve(pathname.slice(1)));
    await route.fulfill({ body, contentType });
  });
  await page.goto('/extension/recorder.html');
  await checkDisplayTabs(page, expect);
});
