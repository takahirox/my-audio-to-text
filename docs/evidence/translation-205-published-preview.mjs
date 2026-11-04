// Post-merge check: published shared modules, reviewed extension adapter,
// and controlled Worker replies. No model weights or local server are used.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { checkTranslationPorts, translationPortWorker } from '../../tests/fixtures/translation-ports.js';
const base = 'https://takahirox.github.io/my-audio-to-text/';
const browser = await chromium.launch({ channel: 'chrome' });
const results = [];
try {
  const context = await browser.newContext();
  await context.route(`${base}extension/*.js`, async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    await route.fulfill({ body: await readFile(new URL(`../../extension/${name}`, import.meta.url)), contentType: 'text/javascript' });
  });
  await context.route(`${base}web/*.js`, async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    if (/^(translategemma|opus-mt|opus-mt-en-ja)-worker\.js$/.test(name)) {
      return route.fulfill({ body: translationPortWorker, contentType: 'text/javascript' });
    }
    // Resolve the extension package's ../web path to the actual Pages artifact.
    const response = await route.fetch({ url: new URL(name, base).href });
    if (response.status() !== 200) throw Error(`Published module unavailable: ${name}`);
    return route.fulfill({ response });
  });
  const page = await context.newPage();
  await page.goto(base);
  for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'OpusMtEnJa', 'OpusMtJaEn']) {
    await checkTranslationPorts(page, type, './extension/');
    results.push({ type, result: 'passed', checks: 'committed history; separate previews; final clears before completion; stale results suppressed; Stop/Cancel clear; restart; saved JSON preserved; Workers released' });
  }
  console.log(JSON.stringify({ base_url: base, inference: 'controlled native Worker replies; real-model inference unverified', adapter: 'reviewed local extension source; shared web modules fetched from Pages', results }, null, 2));
} finally { await browser.close(); }
