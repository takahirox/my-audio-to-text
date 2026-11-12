import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const legalLinks = [
  ['qwen3-tts', 'License & source', '../web/licenses/qwen3-tts.txt', 'Qwen Team / Danyal Malik ONNX conversion'],
  ['cosyvoice3', 'License & source', '../web/licenses/cosyvoice3.txt', 'LibriTTS-R reference features: Koizumi et al., speaker 4446, CC BY 4.0'],
  ['meeting-summary-lfm2', 'License / terms', '../web/licenses/meeting-summary-lfm2.txt', 'Commercial use above the $10M annual revenue threshold needs a separate license'],
  ['meeting-summary-qwen35', 'License', '../web/licenses/meeting-summary-qwen35.txt', 'pinned conversion provenance and evidence'],
  ['if-condition', 'License & source', '../web/licenses/if-condition-model.txt', 'Moritz Laurer / Microsoft · MIT'],
  ['parakeet-v3', 'License & source', 'https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx', 'NVIDIA · CC BY 4.0 · ysdede/istupakov ONNX conversion'],
  ['moonshine-medium-en', 'Source', 'https://moonshine-voice.readthedocs.io/en/latest/models/available-models/', 'Moonshine AI / Useful Sensors · MIT'],
  ['opus-ja-en', 'License', 'https://creativecommons.org/licenses/by/4.0/', 'Helsinki-NLP / ONNX Community · CC BY 4.0'],
  ['opus-en-ja', 'License & source', 'https://huggingface.co/Helsinki-NLP/opus-tatoeba-en-ja', 'Helsinki-NLP / Kadonox ONNX conversion · Apache 2.0'],
  ['translategemma', 'License & source', '../web/licenses/gemma-notices.txt', 'Gemma Terms of Use and Prohibited Use Policy apply to this conversion. Read before downloading or using.'],
  ['supertonic3', 'License & source', '../web/licenses/tts-notices.txt', 'OpenRAIL-M weights and voices'],
  ['kokoro', 'License & source', '../web/licenses/tts-notices.txt', 'Apache-2.0 weights; frontends have separate notices'],
];

test('Models wraps real manifests, licenses, expanded file paths and controls at narrow and wide widths', async ({ page, browserName }, info) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/(licenses\/)?[\w.-]+\.(js|html|css|json|txt)$/.test(pathname)) return route.continue();
    const types = { js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json', txt: 'text/plain' };
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: types[pathname.split('.').at(-1)] });
  });
  await page.addInitScript(() => {
    window.openedPages = [];
    window.chrome = { runtime: { getURL: p => location.origin + '/' + p },
      tabs: { create: async options => window.openedPages.push(options) } };
  });
  await page.goto('/extension/model-cache.html');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Models');
  const navigation = page.getByRole('navigation', { name: 'View', exact: true });
  await expect(navigation.locator(':scope > *')).toHaveText(['Library']);
  const library = navigation.getByRole('link', { name: 'Library', exact: true });
  await expect(library).toHaveAttribute('href', 'graph-library.html');
  await expect(library).toHaveAttribute('data-page', 'graph-library.html');
  await expect(page.locator('#navigation-status')).toHaveCount(0);
  await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(library).toBeFocused();
  await expect(page.locator('.model-card')).toHaveCount(12);
  await expect(page.locator('.model-card[data-state="Not downloaded"]')).toHaveCount(12);
  await expect(page.getByRole('button', { name: 'Check cache', includeHidden: true })).toHaveCount(0);
  for (const card of await page.locator('.model-card').all()) {
    await expect(card.getByRole('button')).toHaveText(['Download / retry', 'Delete cached assets']);
    await expect(card.getByRole('button', { name: 'Cancel download', includeHidden: true })).toBeHidden();
    await expect(card.getByRole('status')).toHaveText('Not downloaded');
    await expect(card.locator('.model-license a')).toBeVisible();
  }
  for (const [id, label, href, notice] of legalLinks) {
    const card = page.locator(`#${id}`), link = card.locator('.model-license a');
    await expect(link).toBeVisible();
    await expect(link).toHaveText(label);
    await expect(link).toHaveAccessibleName(`${label} for ${await card.locator('h3').textContent()}`);
    await expect(link).toHaveAttribute('href', href);
    const notices = card.locator('.model-license details'), summary = notices.locator('summary');
    await expect(notices).not.toHaveAttribute('open');
    await expect(notices.locator('p')).toBeHidden();
    await summary.focus(); await summary.press('Enter');
    await expect(notices.locator('p')).toBeVisible();
    await expect(notices.locator('p')).toContainText(notice);
    await summary.press('Space');
    await expect(notices.locator('p')).toBeHidden();
    // Native Tab navigation reaches the link and then its separate disclosure.
    await link.focus(); await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(summary).toBeFocused();
    await expect(card.locator(':scope > details')).toHaveCSS('border-top-width', '0px');
    expect(await card.evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
    expect(await card.locator('.model-status').evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth))).toBeGreaterThan(0);
    if (href.startsWith('../')) {
      const url = new URL(href, page.url()).href, response = page.waitForResponse(url);
      await link.press('Enter');
      expect((await response).ok()).toBe(true);
      expect((await page.locator('body').textContent()).length).toBeGreaterThan(100);
      await page.goBack();
      await expect(page.locator('.model-card[data-state="Not downloaded"]')).toHaveCount(12);
    }
  }
  const gemma = page.locator('#translategemma');
  await expect(gemma).toContainText('3.112 GB download shared by both directions');
  await expect(gemma).toContainText('Google / ONNX Community · Gemma Terms');
  await gemma.getByText('Verified files and size', { exact: true }).click();
  const spec = JSON.parse(await readFile('extension/translategemma-assets.json'));
  await expect(gemma.locator('li')).toHaveText(spec.map(file => `${file.path}: Missing`));
  const total = spec.reduce((sum, file) => sum + file.bytes, 0);
  await expect(gemma.locator(':scope > details p')).toHaveText(`0 / ${total.toLocaleString('en-US')} bytes · 0 bytes verified cached`);
  const verification = gemma.locator(':scope > details');
  await verification.locator('summary').press('Space');
  await expect(gemma.locator('ul')).toBeHidden();
  await verification.locator('summary').press('Enter');
  await expect(gemma.locator('ul')).toBeVisible();
  for (const width of [320, 390, 800, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await gemma.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const card of await page.locator('.model-card').all()) {
      const notices = card.locator('.model-license details');
      await notices.locator('summary').click();
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await notices.locator('summary').click();
    }
    await page.evaluate(() => scrollTo(0, 0));
    await expect(library).toBeInViewport({ ratio: 1 });
    expect((await library.boundingBox()).height).toBeGreaterThanOrEqual(44);
    for (const button of await gemma.locator('.actions button:visible').all()) {
      const box = await button.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    if (width === 390 || width === 1440) {
      await page.screenshot({ path: info.outputPath(`models-${width}.png`), fullPage: true });
    }
  }
  const download = gemma.getByRole('button', { name: 'Download / retry', exact: true });
  const remove = gemma.getByRole('button', { name: 'Delete cached assets', exact: true });
  await download.focus(); await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
  await expect(remove).toBeFocused();
  await remove.press('Enter');
  await expect(remove).toBeEnabled();
  await remove.focus(); await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab');
  await expect(download).toBeFocused();
  await expect(gemma.locator('.model-status')).toHaveText('Not downloaded');
  await library.press('Enter');
  expect(await page.evaluate(() => window.openedPages)).toEqual([{ url: new URL('/extension/graph-library.html', page.url()).href }]);
});
