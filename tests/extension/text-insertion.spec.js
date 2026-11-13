import { test, expect, chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

let server, browser, url;
test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ['tests/fixtures/rich-editors/editors.js'], bundle: true, write: false, define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' } });
  server = createServer((req, res) => {
    if (req.url === '/editors.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].text); }
    else { res.end('<!doctype html><title>Rich editor fixtures</title><style>section{margin:20px;padding:8px;border:1px solid #999} [contenteditable],textarea{min-height:50px;white-space:pre-wrap}</style><script src="/editors.js" defer></script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
const selectors = { react: '#react textarea', pm: '#pm .ProseMirror', lexical: '#lexical [contenteditable]', draft: '#draft [contenteditable]', quill: '#quill .ql-editor' };
async function fixture() {
  const page = await browser.newPage(); await page.goto(url); await page.waitForFunction(() => window.fixtureReady);
  await page.addScriptTag({ content: await readFile('extension/text-insertion.js', 'utf8') }); return page;
}
async function select(page, id, start = 6, end = start) {
  await page.locator(selectors[id]).focus();
  await page.locator(selectors[id]).evaluate((element, { start, end }) => {
    if (element.setSelectionRange) { element.setSelectionRange(start, end); return; }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const point = offset => { for (const node of nodes) { if (offset <= node.length) return [node, offset]; offset -= node.length; } return [nodes.at(-1), nodes.at(-1).length]; };
    const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }, { start, end });
  // Frameworks observe selectionchange asynchronously.
  await page.waitForTimeout(30);
}
async function insert(page, id, text) {
  return page.evaluate(async ({ selector, text }) => {
    const owner = { element: document.querySelector(selector) }; LocalTextInsertion.saveCaret(owner);
    return LocalTextInsertion.insert(owner, text);
  }, { selector: selectors[id], text });
}
for (const id of Object.keys(selectors)) test(`${id}: actual application model, caret, replacement, multiline and repeated final segments survive rendering`, async () => {
  const page = await fixture();
  try {
    await select(page, id, 6, 11);
    expect(await insert(page, id, 'voice')).toMatchObject({ inserted: true });
    expect(await page.evaluate(id => editors[id].read(), id)).toBe('hello voice');
    await page.evaluate(id => editors[id].render(), id); await page.waitForTimeout(70);
    expect(await page.evaluate(id => editors[id].read(), id)).toBe('hello voice');
    // A second committed value, including equal utterances, is a distinct edit.
    expect(await insert(page, id, ' voice')).toMatchObject({ inserted: true });
    expect(await insert(page, id, ' voice')).toMatchObject({ inserted: true });
    if (['lexical', 'draft'].includes(id)) {
      expect(await insert(page, id, '\nnext')).toMatchObject({ outcome: 'not-inserted' });
      expect(await page.evaluate(id => editors[id].read(), id)).toBe('hello voice voice voice');
      return;
    }
    expect(await insert(page, id, '\nnext')).toMatchObject({ inserted: true });
    await page.evaluate(id => editors[id].render(), id); await page.waitForTimeout(80);
    expect(await page.evaluate(id => editors[id].read(), id)).toBe('hello voice voice voice\nnext');
  } finally { await page.close(); }
});
for (const id of ['pm', 'lexical', 'draft', 'quill']) test(`${id}: editor Undo/Redo and manual edits remain in the application model`, async () => {
  const page = await fixture();
  try {
    await select(page, id, 6, 11); expect(await insert(page, id, 'voice')).toMatchObject({ inserted: true });
    await page.evaluate(id => editors[id].undo(), id); await expect.poll(() => page.evaluate(id => editors[id].read(), id)).toBe('hello world');
    await page.evaluate(id => editors[id].redo(), id); await expect.poll(() => page.evaluate(id => editors[id].read(), id)).toBe('hello voice');
    await select(page, id, 11); await page.keyboard.type(' manual');
    expect(await insert(page, id, ' final')).toMatchObject({ inserted: true });
    await page.evaluate(id => editors[id].render(), id);
    expect(await page.evaluate(id => editors[id].read(), id)).toBe('hello voice manual final');
  } finally { await page.close(); }
});

test('definite rejection is retained in order; only explicit same-target retry delivers once', async () => {
  const page = await fixture();
  try {
    await select(page, 'react');
    expect(await page.evaluate(async () => {
      const element = document.querySelector('#react textarea');
      window.reject = event => event.preventDefault(); element.addEventListener('beforeinput', reject);
      window.delivery = new LocalTextInsertion.Delivery(element, () => true);
      const first = await delivery.append(0, 'one'); const second = await delivery.append(1, 'two');
      const duplicate = await delivery.append(0, 'one');
      return { first, second, duplicate, text: delivery.text() };
    })).toMatchObject({ first: { outcome: 'not-inserted' }, second: { outcome: 'not-inserted' }, duplicate: { duplicate: true }, text: 'onetwo' });
    await select(page, 'pm');
    expect(await page.evaluate(() => delivery.retry(LocalTextInsertion.active()))).toMatchObject({ outcome: 'not-inserted' });
    expect(await page.evaluate(() => editors.pm.read())).toBe('hello world');
    await select(page, 'react');
    await page.evaluate(() => document.querySelector('#react textarea').removeEventListener('beforeinput', reject));
    expect(await page.evaluate(() => delivery.retry(LocalTextInsertion.active()))).toMatchObject({ inserted: true });
    expect(await page.evaluate(() => editors.react.read())).toBe('hello onetwoworld');
    expect(await page.evaluate(() => delivery.text())).toBe('');
  } finally { await page.close(); }
});

test('async reconciliation is ambiguous, blocks replay and exposes accessible user-mediated recovery', async () => {
  const page = await fixture();
  try {
    await select(page, 'pm');
    const result = await page.evaluate(async () => {
      const element = document.querySelector('#pm .ProseMirror');
      element.addEventListener('input', () => setTimeout(() => { element.textContent = 'reconciled'; }, 10), { once: true });
      window.delivery = new LocalTextInsertion.Delivery(element, () => true);
      const result = await delivery.append(0, 'uncertain');
      window.recovery = LocalTextInsertion.recoveryView(delivery, () => element); return result;
    });
    expect(result.outcome).toBe('ambiguous');
    expect((await page.evaluate(() => delivery.retry(delivery.owner.element))).outcome).toBe('ambiguous');
    expect((await page.evaluate(() => delivery.append(0, 'uncertain'))).duplicate).toBe(true);
    expect(await page.evaluate(() => delivery.text())).toBe('uncertain');
    expect(await page.evaluate(() => recovery.shadowRoot)).toBeNull();
    // CDP only for inspecting closed recovery UI; production adds no page bridge.
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = n => n.attributes?.includes('data-local-text-recovery') ? n : [...n.children || [], ...n.shadowRoots || []].map(find).find(Boolean);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: find(root).shadowRoots[0].backendNodeId });
    const { result: ui } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){return {retry:this.querySelector('button').disabled,status:this.querySelector('[role=status]').textContent, preview:this.querySelector('textarea').getAttribute('aria-label')}}` });
    expect(ui.value.retry).toBe(true); expect(ui.value.status).toContain('uncertain'); expect(ui.value.preview).toContain('Retained text');
    await cdp.detach();
  } finally { await page.close(); }
});

test('IME, focus loss, target replacement, no-op browser editing and revoked authorization are safe failures', async () => {
  const page = await fixture();
  try {
    await select(page, 'pm');
    const result = await page.evaluate(async () => {
      const element = document.querySelector('#pm .ProseMirror'), owner = { element };
      LocalTextInsertion.saveCaret(owner);
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const ime = await LocalTextInsertion.insert(owner, 'text');
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      const command = document.execCommand; document.execCommand = () => true;
      const noop = await LocalTextInsertion.insert(owner, 'text'); document.execCommand = command;
      document.querySelector('#react textarea').focus(); const focus = await LocalTextInsertion.insert(owner, 'text');
      element.replaceWith(element.cloneNode(true)); const removed = await LocalTextInsertion.insert(owner, 'text');
      const revoked = await LocalTextInsertion.insert(owner, 'text', () => false);
      return { ime, noop, focus, removed, revoked };
    });
    for (const value of Object.values(result)) expect(value.outcome).toBe('not-inserted');
    expect(await page.evaluate(() => editors.react.read())).toBe('hello world');
  } finally { await page.close(); }
});

test('editable roots include rich and open-shadow editors while excluding sensitive and unrelated controls', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const eligible = Object.values({ pm: '#pm .ProseMirror', lexical: '#lexical [contenteditable]', draft: '#draft [contenteditable]', quill: '#quill .ql-editor' }).map(s => LocalTextInsertion.editable(document.querySelector(s)));
      const wrapper = document.createElement('div'); document.body.append(wrapper);
      wrapper.innerHTML = '<form><input type="password"><div contenteditable="true"><p>private</p></div></form><div contenteditable="true" aria-readonly="true">readonly</div><div inert><div contenteditable="true">inert</div></div><div contenteditable="true" aria-label="Payment">sensitive</div>';
      const blocked = [...wrapper.querySelectorAll('[contenteditable]')].map(e => LocalTextInsertion.editable(e));
      const host = document.createElement('div'); document.body.append(host); host.attachShadow({ mode: 'open' }).innerHTML = '<div contenteditable="true"><p>shadow</p></div>';
      const editor = host.shadowRoot.firstChild; editor.focus();
      return { eligible, blocked, shadow: LocalTextInsertion.active() === editor && LocalTextInsertion.editable(editor), nested: LocalTextInsertion.field(editor.firstChild) === editor && !LocalTextInsertion.editable(editor.firstChild) };
    });
    expect(result).toEqual({ eligible: [true,true,true,true], blocked: [false,false,false,false], shadow: true, nested: true });
  } finally { await page.close(); }
});

test('bounded recovery explicitly rejects overload and disposal prevents late edits', async () => {
  const page = await fixture();
  try {
    await select(page, 'react');
    const result = await page.evaluate(async () => {
      const delivery = new LocalTextInsertion.Delivery(document.querySelector('#react textarea'), () => false);
      for (let sequence = 0; sequence < 128; sequence++) await delivery.append(sequence, 'x');
      let overload; try { await delivery.append(128, 'overflow'); } catch (error) { overload = error.message; }
      const retained = delivery.text(); delivery.dispose();
      const late = await delivery.append(129, 'late');
      return { overload, retained, late, text: delivery.text() };
    });
    expect(result.overload).toContain('capacity'); expect(result.retained).toHaveLength(128);
    expect(result.late.outcome).toBe('not-inserted'); expect(result.text).toBe('');
  } finally { await page.close(); }
});

test('selection changes during asynchronous preflight cannot redirect a rich edit', async () => {
  const page = await fixture();
  try {
    await select(page, 'pm');
    const result = await page.evaluate(async () => {
      const owner = { element: document.querySelector('#pm .ProseMirror') }; LocalTextInsertion.saveCaret(owner);
      owner.element.addEventListener('beforeinput', () => setTimeout(() => {
        const range = document.createRange(); range.selectNodeContents(owner.element); range.collapse(true);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      }, 10), { once: true });
      return LocalTextInsertion.insert(owner, 'wrong caret');
    });
    expect(result.outcome).toBe('not-inserted'); expect(await page.evaluate(() => editors.pm.read())).toBe('hello world');
  } finally { await page.close(); }
});

test('the recovery clipboard changes only after a trusted explicit Copy action', async () => {
  const page = await fixture();
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await select(page, 'react');
    await page.evaluate(async () => {
      await navigator.clipboard.writeText('existing clipboard');
      const delivery = new LocalTextInsertion.Delivery(document.querySelector('#react textarea'), () => false);
      await delivery.append(0, 'retained'); window.recovery = LocalTextInsertion.recoveryView(delivery, () => delivery.owner.element);
    });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('existing clipboard');
    const cdp = await page.context().newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = n => n.attributes?.includes('data-local-text-recovery') ? n : [...n.children || [], ...n.shadowRoots || []].map(find).find(Boolean);
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: find(root).shadowRoots[0].backendNodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){const b=[...this.querySelectorAll('button')].find(b=>b.textContent==='Copy for review'),r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}}` });
    await page.mouse.click(result.value.x, result.value.y);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('retained');
    await cdp.detach();
  } finally { await page.close(); }
});

test('plain contenteditable retains verbatim whitespace, selection replacement and browser Undo', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const element = document.createElement('div'); element.id = 'plain'; element.contentEditable = 'true'; element.style.whiteSpace = 'pre-wrap'; element.textContent = 'hello world'; document.body.prepend(element); element.focus();
      const range = document.createRange(); range.setStart(element.firstChild, 6); range.setEnd(element.firstChild, 11); getSelection().removeAllRanges(); getSelection().addRange(range);
      window.plainOwner = { element }; LocalTextInsertion.saveCaret(plainOwner);
    });
    expect(await page.evaluate(() => LocalTextInsertion.insert(plainOwner, 'voice'))).toMatchObject({ inserted: true });
    await page.evaluate(() => document.execCommand('undo')); await expect(page.locator('#plain')).toHaveText('hello world');
    await page.evaluate(() => { document.execCommand('redo'); LocalTextInsertion.saveCaret(plainOwner); });
    expect(await page.evaluate(() => LocalTextInsertion.insert(plainOwner, ' \n\t <b>literal</b>  '))).toMatchObject({ inserted: true });
    expect(await page.locator('#plain').innerText()).toBe('hello voice \n\t <b>literal</b>  ');
    await expect(page.locator('#plain b')).toHaveCount(0);
  } finally { await page.close(); }
});

test('an open-shadow editor receives text at its own selection; nested controls cannot redirect it', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const host = document.createElement('div'); document.body.prepend(host); host.attachShadow({ mode: 'open' }).innerHTML = '<div contenteditable="true">hello world</div>';
      const element = host.shadowRoot.firstChild; element.focus();
      const range = document.createRange(); range.setStart(element.firstChild, 6); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range);
      const owner = { element }; LocalTextInsertion.saveCaret(owner);
      const result = await LocalTextInsertion.insert(owner, 'shadow ');
      const input = document.createElement('input'); element.append(input); input.focus();
      const nested = LocalTextInsertion.active() === input;
      const moved = await LocalTextInsertion.insert(owner, 'wrong');
      return { result, moved, nested, text: element.textContent, input: input.value };
    });
    expect(result).toMatchObject({ result: { inserted: true }, moved: { outcome: 'not-inserted' }, nested: true, text: 'hello shadow world', input: '' });
  } finally { await page.close(); }
});
