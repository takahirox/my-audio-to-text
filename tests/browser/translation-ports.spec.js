import { test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkTranslationPorts, checkTranslationPortRecovery, translationPortWorker } from '../fixtures/translation-ports.js';

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    const body = /\/(translategemma|opus-mt|opus-mt-en-ja)-worker\.js$/.test(pathname)
      ? translationPortWorker : await readFile(path.resolve(pathname.slice(1)));
    await route.fulfill({ body, contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('/');
});
for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'OpusMtEnJa', 'OpusMtJaEn'])
  test(`${type}: direct committed history, separate preview clearing, Cancel and restart`, async ({ page }) => {
    await checkTranslationPorts(page, type, '/extension/');
  });

for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'OpusMtEnJa', 'OpusMtJaEn'])
  test(`${type}: mixed saved routes require reviewed repair and exact JSON recovery`, async ({ page }) => {
    await page.goto('/extension/graph-editor.html');
    await checkTranslationPortRecovery(page, type);
  });
