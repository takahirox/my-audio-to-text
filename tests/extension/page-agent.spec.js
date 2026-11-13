import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';

let browser, server, url, outputBundle;
test.beforeAll(async () => {
  outputBundle = (await build({ entryPoints: ['extension/page-output-node.js'], bundle: true, write: false, format: 'iife', globalName: 'OutputModule', define: { 'import.meta.url': '"http://127.0.0.1/unused-worker.js"' } })).outputFiles[0].text;
  server = createServer((req, res) => res.end('<!doctype html><title>Toolbar output fixture</title><input id="first" value="manual"><textarea id="second">notes</textarea><input id="secret" type="password">'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function fixture() {
  const page = await browser.newPage(); await page.goto(url);
  // Exercise the actual page-agent command handler and editing primitives.
  // Only the authorized extension port is substituted; DOM events are real.
  await page.evaluate(() => {
    let connect, receive, request = 0;
    const replies = new Map();
    window.chrome = { runtime: { id: 'fixture', onConnect: { addListener(listener) { connect = listener; } } } };
    window.connectOutput = () => connect({
      name: 'local-page-target', sender: { id: 'fixture' },
      onDisconnect: { addListener(listener) { window.disconnectOutput = listener; } },
      onMessage: { addListener(listener) { receive = listener; } },
      postMessage(message) {
        const { resolve, reject } = replies.get(message.request); replies.delete(message.request);
        if (message.error) reject(Error(message.error)); else resolve(message.result);
      },
    });
    window.command = (action, data = {}) => new Promise((resolve, reject) => {
      const id = ++request; replies.set(id, { resolve, reject }); receive({ ...data, action, request: id });
    });
  });
  for (const file of ['text-insertion.js', 'page-agent.js']) await page.addScriptTag({ content: await readFile(`extension/${file}`, 'utf8') });
  await page.evaluate(async () => { connectOutput(); await command('output'); });
  return page;
}
const append = (page, sequence, text) => page.evaluate(({ sequence, text }) => command('append', { sequence, text }), { sequence, text });

async function recovery(page, label) {
  // Closed shadow roots keep page scripts out of recovery controls. CDP only
  // locates their rendered bounds; actions still use trusted browser input.
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = node => node.attributes?.includes('data-local-text-recovery') ? node : [...node.children || [], ...node.shadowRoots || []].map(find).find(Boolean);
    const host = find(root);
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: `function(label) {
        const button = [...this.querySelectorAll('button')].find(button => button.textContent === label);
        const rect = button?.getBoundingClientRect();
        return { text: this.querySelector('textarea').value, status: this.querySelector('[role=status]').textContent,
          point: rect && { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
      }`, arguments: [{ value: label }],
    });
    if (label) await page.mouse.click(result.value.point.x, result.value.point.y);
    return result.value;
  } finally { await cdp.detach(); }
}

for (const replace of [true, false]) test(`programmatic focus ${replace ? 'after replacement' : 'on another field'} cannot redirect successful toolbar delivery`, async () => {
  const page = await fixture();
  try {
    await page.locator('#first').click();
    expect(await append(page, 0, ' one')).toMatchObject({ inserted: true });
    await page.evaluate(replace => {
      const original = document.querySelector('#first');
      if (replace) { const replacement = original.cloneNode(true); replacement.value = 'replacement'; original.replaceWith(replacement); replacement.focus(); }
      else document.querySelector('#second').focus();
    }, replace);
    expect(await append(page, 1, ' two')).toMatchObject({ outcome: 'not-inserted' });
    expect(await append(page, 2, ' three')).toMatchObject({ outcome: 'not-inserted' });
    expect(await append(page, 1, ' two')).toEqual({ duplicate: true });
    await expect(page.locator('#first')).toHaveValue(replace ? 'replacement' : 'manual one');
    await expect(page.locator('#second')).toHaveValue('notes');
    await recovery(page, 'Review text'); expect((await recovery(page)).text).toBe(' two three');
    if (replace) {
      await page.locator('#first').click(); await recovery(page, 'Retry in original field');
      await expect(page.locator('#first')).toHaveValue('replacement');
      expect((await recovery(page)).status).toContain('Replacement fields require a new session');
    } else {
      await page.locator('#first').click(); await recovery(page, 'Retry in original field');
      await expect(page.locator('#first')).toHaveValue('manual one two three');
    }
  } finally { await page.close(); }
});

test('deliberate pointer and keyboard field selections still route later successful segments', async () => {
  const page = await fixture();
  try {
    await page.locator('#first').click(); expect(await append(page, 0, ' one')).toMatchObject({ inserted: true });
    await page.locator('#second').click(); expect(await append(page, 1, ' two')).toMatchObject({ inserted: true });
    await page.keyboard.press('Shift+Tab'); expect(await append(page, 2, ' three')).toMatchObject({ inserted: true });
    await expect(page.locator('#first')).toHaveValue('manual one three');
    await expect(page.locator('#second')).toHaveValue('notes two');
  } finally { await page.close(); }
});

for (const keyboard of [false, true]) test(`initial targetless text is retained in order until explicit ${keyboard ? 'keyboard' : 'pointer'} recovery`, async () => {
  const page = await fixture();
  try {
    expect(await append(page, 0, ' one')).toMatchObject({ outcome: 'not-inserted' });
    await expect(page.locator('[data-local-text-recovery]')).toBeVisible();
    await page.locator('#second').click();
    expect(await append(page, 1, ' two')).toMatchObject({ outcome: 'not-inserted' });
    expect(await append(page, 0, ' one')).toEqual({ duplicate: true });
    await expect(page.locator('#second')).toHaveValue('notes');
    await recovery(page, 'Review text'); expect((await recovery(page)).text).toBe(' one two');
    // Unsupported targets cannot authorize recovery or consume the queue.
    await page.locator('#secret').click(); await recovery(page, 'Retry in selected field');
    expect((await recovery(page)).text).toBe(' one two');
    await expect(page.locator('#secret')).toHaveValue('');
    await page.locator('#second').click();
    if (keyboard) {
      await page.locator('#secret').evaluate(element => { element.tabIndex = -1; });
      // The revealed review textarea precedes Retry in keyboard order.
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    } else await recovery(page, 'Retry in selected field');
    await expect(page.locator('#second')).toHaveValue('notes one two');
    await expect(page.locator('[data-local-text-recovery]')).toHaveCount(0);
    expect(await append(page, 1, ' two')).toEqual({ duplicate: true });
    expect(await append(page, 2, ' three')).toMatchObject({ inserted: true });
    await expect(page.locator('#second')).toHaveValue('notes one two three');
  } finally { await page.close(); }
});

test('actual toolbar output preserves bounded recovery on overflow until explicit Stop closes the connection', async () => {
  const page = await fixture();
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.addScriptTag({ content: outputBundle });
    await page.evaluate(async () => {
      window.states = []; window.outputDisconnects = 0; window.context = { signal: new AbortController().signal };
      window.node = new OutputModule.FocusedInputTextOutputNode({
        target: { tabId: 42, documentId: 'fixture', label: 'Fixture' }, onState: (...state) => states.push(state),
        connectionFactory: () => ({ request: command, close() { outputDisconnects++; disconnectOutput(); } }),
      });
      await node.start(context);
      for (let sequence = 0; sequence < 128; sequence++) await node.receive('text', 'x', context);
      await node.receive('text', 'overflow', context);
    });
    expect(await page.evaluate(() => ({ failed: !!node.failed, closed: outputDisconnects, state: states.at(-1) }))).toMatchObject({
      failed: false, closed: 0, state: [expect.stringContaining('capacity reached'), false, 'warning'],
    });
    await recovery(page, 'Review text'); expect((await recovery(page)).text).toBe('x'.repeat(128));
    await recovery(page, 'Copy for review');
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('x'.repeat(128));
    await page.evaluate(() => node.stop());
    expect(await page.evaluate(() => outputDisconnects)).toBe(1);
    await expect(page.locator('[data-local-text-recovery]')).toHaveCount(0);
    await page.locator('#first').click(); await page.evaluate(() => { connectOutput(); return command('output'); });
    expect(await append(page, 0, ' fresh')).toMatchObject({ inserted: true });
    await expect(page.locator('#first')).toHaveValue('manual fresh');
    await page.evaluate(() => disconnectOutput());
    await expect(page.locator('[data-local-text-recovery]')).toHaveCount(0);
  } finally { await page.close(); }
});

test('targetless recovery remains visible and usable on a long page', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => { document.body.style.minHeight = '3000px'; });
    expect(await append(page, 0, 'retained')).toMatchObject({ outcome: 'not-inserted' });
    const bounds = await page.locator('[data-local-text-recovery]').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize().height);
    await recovery(page, 'Review text'); expect((await recovery(page)).text).toBe('retained');
    expect(await page.evaluate(() => scrollY)).toBe(0);
  } finally { await page.close(); }
});
