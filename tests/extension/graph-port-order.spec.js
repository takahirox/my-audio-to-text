import { test, chromium } from '@playwright/test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkPortOrderAndHelp, checkPortGeometryAndInteractions } from '../fixtures/graph-port-order.js';

// Real MV3 manifest and production editor modules; no inference assets needed.
test('MV3 data/ID ordering, keyboard/help, exact wire attachments and row gestures at multiple zooms', async ({}, info) => {
  test.setTimeout(120000);
  const temporary = await mkdtemp(path.join(tmpdir(), 'graph-port-order-'));
  let context;
  try {
    const root = path.join(temporary, 'extension');
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(source) });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
    context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), { channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
    const { id } = await (await context.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: root });
    const page = await context.newPage(); await page.goto(`chrome-extension://${id}/extension/graph-editor.html`);
    await checkPortOrderAndHelp(page);
    const measurements = await checkPortGeometryAndInteractions(page);
    await info.attach('MV3-port-order-crossings', { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  } finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
});
