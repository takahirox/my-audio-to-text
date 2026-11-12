import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('packaged icons decode and register on native extension surfaces after reload', async ({}, testInfo) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'extension-icons-'));
  const root = path.resolve('dist/chrome-extension');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
    for (const reload of [false, true]) {
      const worker = context.serviceWorkers().find(worker => worker.url().includes(id))
        || await context.waitForEvent('serviceworker', { predicate: worker => worker.url().includes(id) });
      await expect.poll(() => worker.evaluate(() => chrome.action.onClicked.hasListeners())).toBe(true);
      const installed = await worker.evaluate(async () => ({
        manifest: chrome.runtime.getManifest(), title: await chrome.action.getTitle({}),
      }));
      expect(installed.manifest.icons).toEqual(manifest.icons);
      expect(installed.manifest.action.default_icon).toEqual(manifest.icons);
      expect(installed.title).toBe('Transcribe this tab');

      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/extension/graph-library.html`);
      const images = await page.evaluate(async icons => {
        return Promise.all(Object.entries(icons).map(async ([size, relative]) => {
          const response = await fetch(chrome.runtime.getURL(relative));
          const bitmap = await createImageBitmap(await response.blob());
          return { size: Number(size), width: bitmap.width, height: bitmap.height, ok: response.ok };
        }));
      }, manifest.icons);
      for (const image of images) expect(image).toEqual({
        size: image.size, width: image.size, height: image.size, ok: true,
      });

      await page.goto('chrome://extensions/');
      if (!reload) await page.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
      const card = page.locator(`extensions-item#${id}`);
      await expect(card).toBeVisible();
      const image = card.locator('img#icon');
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
      // Chrome serves a re-encoded data URL here. Compare decoded pixels to the
      // configured PNG so a successfully loaded placeholder cannot pass.
      const size = await image.evaluate(image => image.naturalWidth);
      const expectedIcon = await readFile(path.join(root, manifest.icons[size]));
      expect(await image.evaluate(async (image, source) => {
        const expected = new Image();
        expected.src = source;
        await expected.decode();
        const pixels = image => {
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
          canvas.getContext('2d').drawImage(image, 0, 0);
          return canvas.toDataURL();
        };
        return pixels(image) === pixels(expected);
      }, `data:image/png;base64,${expectedIcon.toString('base64')}`)).toBe(true);
      const errors = await page.evaluate(async id => {
        const extensions = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true });
        const extension = extensions.find(extension => extension.id === id);
        return { manifest: extension.manifestErrors, runtime: extension.runtimeErrors };
      }, id);
      expect(errors).toEqual({ manifest: [], runtime: [] });
      if (reload) {
        const screenshot = testInfo.outputPath('native-extension-card.png');
        await card.screenshot({ path: screenshot });
        await testInfo.attach('native-extension-card', { path: screenshot, contentType: 'image/png' });
      }
      if (!reload) {
        // Reload acknowledges the request before re-enabling the extension.
        await page.evaluate(id => chrome.developerPrivate.reload(id), id);
        await expect.poll(() => page.evaluate(async id => {
          const extensions = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true });
          const extension = extensions.find(extension => extension.id === id);
          return { state: extension?.state, reloading: extension?.disableReasons.reloading };
        }, id)).toEqual({ state: 'ENABLED', reloading: false });
      }
      await page.close();
    }
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
