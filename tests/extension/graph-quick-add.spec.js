import { test, chromium } from '@playwright/test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkQuickAddInteraction, checkQuickAddPlacement, checkQuickAddTouch } from '../fixtures/graph-quick-add.js';

// This editor-only MV3 suite loads production sources and the real manifest.
// It needs no downloaded inference assets or mocked editor/graph modules.
test('MV3 quick-add mouse, keyboard, touch, Save, zoom, pan and responsive layout', async () => {
  test.setTimeout(120000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'graph-quick-add-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(source) });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: process.env.TRANSLATION_CHANNEL || 'chromium', headless: true, hasTouch: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const session = await context.browser().newBrowserCDPSession();
    const { id } = await session.send('Extensions.loadUnpacked', { path: root });
    const page = await context.newPage(); await page.goto(`chrome-extension://${id}/extension/graph-editor.html`);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await checkQuickAddInteraction(page);
    }
    for (const width of [390, 1440]) for (const zoom of ['0.25', '0.5', '1', '1.5', 'fit']) await checkQuickAddPlacement(page, width, zoom);
    await checkQuickAddPlacement(page, 1440, '0.5', true);
    await checkQuickAddPlacement(page, 390, '1.5', false, 'KeyedTextCoalesce');
    await checkQuickAddTouch(page);
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});
