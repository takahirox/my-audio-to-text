import { test, chromium } from '@playwright/test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkCanvasFirst, checkLeanInspector, checkGraphCommands } from '../fixtures/graph-canvas-first.js';
import { checkZoomRecovery } from '../fixtures/graph-zoom.js';
import { checkPointerZoom, checkZoomInputModes, checkZoomControls } from '../fixtures/graph-pointer-zoom.js';
import { checkInputDetach, checkInputReconnect, checkRecovery } from '../fixtures/graph-inspector.js';

// Production editor modules and the real MV3 manifest, without inference assets.
test('MV3 canvas-first controls, inspector, zoom focus, connections and recovery', async ({}, info) => {
  test.setTimeout(120000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'graph-canvas-first-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(source) });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true, hasTouch: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const page = await context.newPage(); const url = `chrome-extension://${id}/extension/graph-editor.html`;
    await page.goto(url);
    for (const width of [1440, 390, 320]) await checkCanvasFirst(page, width);
    await page.setViewportSize({ width: 1440, height: 900 }); await checkLeanInspector(page);
    await page.evaluate(() => localStorage.clear());
    await page.goto(url); await checkGraphCommands(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 }); await checkZoomRecovery(page, 'large', info);
      await checkInputDetach(page, width);
    }
    await checkPointerZoom(page);
    await checkZoomInputModes(page);
    await checkZoomControls(page);
    await checkInputReconnect(page);
    for (const kind of ['invalid', 'unsupported']) await checkRecovery(page, kind);
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});
