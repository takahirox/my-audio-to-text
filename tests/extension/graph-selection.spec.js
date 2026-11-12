import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkSelectionAppearance, expectSelected } from '../fixtures/graph-selection.js';

test('MV3 selection keeps heading layout, pointer focus and keyboard access separate', async ({}, info) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'graph-selection-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(source) });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    await context.addInitScript(() => Object.defineProperty(navigator, 'userAgentData', { value: { platform: 'macOS' } }));
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const page = await context.newPage(); await page.goto(`chrome-extension://${id}/extension/graph-editor.html`);
    await checkSelectionAppearance(page, info);
    await page.getByRole('button', { name: 'Select source', exact: true }).click();
    const hold = page.getByRole('button', { name: 'Select hold', exact: true });
    await hold.click({ modifiers: ['Meta'] }); await expectSelected(page, ['source', 'hold']);
    await hold.click({ modifiers: ['Meta'] }); await expectSelected(page, ['source']);
    await expect(hold).toHaveCSS('outline-style', 'none');
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});
