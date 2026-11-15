// #377: comparative investigation. CDP supplies only the isolated-world test
// execution context; candidate actions use ordinary content-script DOM APIs.
import { test, expect, chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';

let browser, server, url;
const records = [];
test.beforeAll(async () => {
  const bundle = (await build({ entryPoints: ['tests/fixtures/rich-editors/editors.js'], bundle: true, write: false,
    define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' } })).outputFiles[0].text;
  server = createServer((req, res) => {
    if (req.url === '/editors.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle); }
    else res.end('<!doctype html><style>[contenteditable]{min-height:50px;white-space:pre-wrap}section{margin:20px}</style><script src="/editors.js" defer></script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});
test.afterAll(async () => {
  // A filtered run or worker restart must not replace the complete evidence
  // with a partial matrix. Regeneration requires all comparison rows.
  if (process.env.EDITOR_MATRIX_WRITE === '1' && records.length === 2 * Object.keys(operations).length) await writeFile('docs/evidence/web-voice-377-matrix.json', JSON.stringify({
    browser: browser.version(), versions: { lexical: '0.38.2', draft: '0.11.7', react: '18.3.1' },
    initial: 'hello world', selection: [6, 11], inserted: 'voice\nnext', expected: 'hello voice\nnext', records,
  }, null, 2) + '\n');
  await browser?.close(); await new Promise(resolve => server?.close(resolve));
});

async function setup(id) {
  const page = await browser.newPage(); await page.goto(url); await page.waitForFunction(() => window.fixtureReady);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message.slice(0, 500)));
  const selector = `#${id} [contenteditable]`;
  await page.locator(selector).focus();
  await page.locator(selector).evaluate(element => {
    const node = document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode(), range = document.createRange();
    range.setStart(node, 6); range.setEnd(node, 11); getSelection().removeAllRanges(); getSelection().addRange(range);
    window.inputEvents = [];
    for (const name of ['beforeinput', 'input', 'paste']) element.addEventListener(name, e => inputEvents.push({
      type: e.type, inputType: e.inputType, data: e.data, trusted: e.isTrusted, prevented: e.defaultPrevented,
    }));
  });
  await page.waitForTimeout(40);
  const cdp = await page.context().newCDPSession(page), { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'voice-377-test' });
  const isolated = async expression => {
    const result = await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  await isolated(`window.target = document.querySelector(${JSON.stringify(selector)})`);
  return { page, isolated, cdp, errors };
}
async function snapshot(page, id) {
  await page.waitForTimeout(120);
  return page.evaluate(id => {
    const root = document.querySelector(`#${id} [contenteditable]`), selection = getSelection();
    // innerText follows the browser's visual block separators. HTML + model
    // retain the distinction between Lexical soft breaks and Draft blocks.
    const point = (node, offset) => ({ text: node?.textContent, offset, inside: !!root?.contains(node) });
    return { model: editors[id].read(), state: editors[id].inspect(), dom: root?.innerText ?? null, html: root?.innerHTML ?? null,
      caret: { anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset), collapsed: selection.isCollapsed },
      events: [...inputEvents] };
  }, id);
}
const operations = {
  typing: async ({ page }) => { await page.keyboard.type('voice'); await page.keyboard.press('Enter'); await page.keyboard.type('next'); },
  'native-paste': async ({ page }) => {
    // Positive control only: clipboard permission and trusted keyboard input
    // belong to the test driver, never to the extension insertion strategy.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('voice\nnext'));
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  },
  insertText: ({ isolated }) => isolated(`document.execCommand('insertText', false, 'voice\\nnext')`),
  insertParagraph: ({ isolated }) => isolated(`document.execCommand('insertText', false, 'voice'); document.execCommand('insertParagraph'); document.execCommand('insertText', false, 'next')`),
  insertLineBreak: ({ isolated }) => isolated(`document.execCommand('insertText', false, 'voice'); document.execCommand('insertLineBreak'); document.execCommand('insertText', false, 'next')`),
  'insertParagraph-settled': ({ isolated }) => isolated(`(async () => { document.execCommand('insertText', false, 'voice'); await new Promise(r => setTimeout(r, 120)); document.execCommand('insertParagraph'); await new Promise(r => setTimeout(r, 120)); document.execCommand('insertText', false, 'next'); })()`),
  'insertLineBreak-settled': ({ isolated }) => isolated(`(async () => { document.execCommand('insertText', false, 'voice'); await new Promise(r => setTimeout(r, 120)); document.execCommand('insertLineBreak'); await new Promise(r => setTimeout(r, 120)); document.execCommand('insertText', false, 'next'); })()`),
  'paste-command': ({ isolated }) => isolated(`document.execCommand('paste')`),
  'synthetic-beforeinput': ({ isolated }) => isolated(`target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: 'voice\\nnext' }))`),
  'synthetic-input': ({ isolated }) => isolated(`target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: 'voice\\nnext' }))`),
  'synthetic-paste': ({ isolated }) => isolated(`(() => { const data = new DataTransfer(); data.setData('text/plain', 'voice\\nnext'); return target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, composed: true, cancelable: true, clipboardData: data })); })()`),
};
for (const id of ['lexical', 'draft']) for (const [operation, apply] of Object.entries(operations)) test(`${id}: multiline operation matrix / ${operation}`, async ({}, info) => {
  const f = await setup(id);
  try {
    const before = await snapshot(f.page, id), result = await apply(f), after = await snapshot(f.page, id);
    await f.page.evaluate(id => editors[id].render(), id); const rendered = await snapshot(f.page, id);
    await f.page.evaluate(id => editors[id].undo(), id); const undo = await snapshot(f.page, id);
    await f.page.evaluate(id => editors[id].redo(), id); const redo = await snapshot(f.page, id);
    const classification = f.errors.length || after.dom === null ? 'application-error' : after.model === 'hello voice\nnext' && after.dom === after.model && rendered.model === after.model && rendered.dom === after.model && redo.model === after.model && redo.dom === after.model
      ? 'persisted' : after.model === 'hello world' && after.html === before.html ? 'no-effect' : 'incompatible';
    const record = { editor: id, operation, result, classification, errors: f.errors, before, after, rendered, undo, redo };
    records.push(record); await info.attach('matrix', { body: JSON.stringify(record, null, 2), contentType: 'application/json' });
    if (['typing', 'native-paste', 'synthetic-paste'].includes(operation)) {
      expect(classification).toBe('persisted');
      expect(rendered.caret.collapsed).toBe(true); expect(rendered.caret.anchor.inside).toBe(true);
      if (operation !== 'typing') expect(undo.model).toBe('hello world');
    }
  } finally { await f.cdp.detach(); await f.page.close(); }
});

async function delivery(f) {
  await f.isolated(await readFile('extension/text-insertion.js', 'utf8'));
  await f.isolated('window.delivery = new LocalTextInsertion.Delivery(target, () => true)');
  let sequence = 0;
  return text => f.isolated(`delivery.append(${sequence++}, ${JSON.stringify(text)})`);
}
async function selectText(page, id, from, start, to = from, end = start) {
  await page.locator(`#${id} [contenteditable]`).evaluate((element, { from, start, to, end }) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const range = document.createRange(); range.setStart(nodes.find(n => n.data.includes(from)), start); range.setEnd(nodes.find(n => n.data.includes(to)), end);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  }, { from, start, to, end });
  await page.waitForTimeout(40);
}
for (const id of ['lexical', 'draft']) {
  test(`${id}: isolated shared delivery replaces world, repeats segments, then commits newline`, async () => {
    const f = await setup(id);
    try {
      const append = await delivery(f);
      for (const text of ['voice', ' voice', ' voice', '\nnext']) expect(await append(text)).toMatchObject({ inserted: true });
      await f.page.evaluate(id => editors[id].render(), id);
      expect((await snapshot(f.page, id)).model).toBe('hello voice voice voice\nnext');
      await f.page.keyboard.type(' manual');
      expect(await append('\nfinal')).toMatchObject({ inserted: true });
      expect((await snapshot(f.page, id)).model).toBe('hello voice voice voice\nnext manual\nfinal');
      await f.page.evaluate(id => editors[id].undo(), id); expect((await snapshot(f.page, id)).model).toBe('hello voice voice voice\nnext manual');
      await f.page.evaluate(id => editors[id].redo(), id); expect((await snapshot(f.page, id)).model).toBe('hello voice voice voice\nnext manual\nfinal');
      expect(await f.isolated('delivery.text()')).toBe('');
    } finally { await f.cdp.detach(); await f.page.close(); }
  });
  for (const shape of ['caret', 'replacement', 'newline-only', 'empty', 'existing-lines', 'line-start', 'line-end', 'cross-lines']) test(`${id}: isolated multiline ${shape} preserves model, DOM, caret and Undo after render`, async () => {
    const f = await setup(id);
    try {
      let text = 'left\nright', expected = 'hello left\nright', before = 'hello world';
      if (shape === 'caret') { await selectText(f.page, id, 'hello world', 6); expected += 'world'; }
      if (shape === 'newline-only') { text = '\n'; expected = 'hello \n'; }
      if (shape === 'empty') {
        await f.page.evaluate(id => editors[id].replace(''), id);
        await f.page.locator('#react textarea').focus();
        await f.page.locator(`#${id} [contenteditable]`).click({ position: { x: 5, y: 5 } });
        await f.page.waitForTimeout(40); before = ''; expected = 'left\nright';
      }
      if (['existing-lines', 'line-start', 'line-end', 'cross-lines'].includes(shape)) {
        // Establish pre-existing multiline content through real ordinary typing.
        await selectText(f.page, id, 'hello world', 11); await f.page.keyboard.press('Enter'); await f.page.keyboard.type('middle');
        await f.page.keyboard.press('Enter'); await f.page.keyboard.type('last');
        before = 'hello world\nmiddle\nlast';
        await selectText(f.page, id, 'middle', 0, 'middle', 6); expected = 'hello world\nleft\nright\nlast';
        if (shape === 'line-start' || shape === 'line-end') {
          await selectText(f.page, id, 'middle', shape === 'line-start' ? 0 : 6);
          expected = shape === 'line-start' ? 'hello world\nleft\nrightmiddle\nlast' : 'hello world\nmiddleleft\nright\nlast';
        }
        if (shape === 'cross-lines') {
          await selectText(f.page, id, 'hello world', 2, 'last', 2);
          text = '<b>literal</b>\r\n\nend\r'; expected = 'he<b>literal</b>\n\nend\nst';
        }
      }
      const append = await delivery(f);
      expect(await append(text)).toMatchObject({ inserted: true });
      await f.page.evaluate(id => editors[id].render(), id); const rendered = await snapshot(f.page, id);
      expect(rendered.model).toBe(expected);
      // Chromium innerText includes the layout BR in an empty Draft block,
      // and the trailing caret BR in both editors. These are not model breaks.
      const expectedDOM = id === 'draft' && shape === 'cross-lines' ? expected.replace('\n\n', '\n\n\n') : expected + (shape === 'newline-only' ? '\n' : '');
      expect(rendered.dom).toBe(expectedDOM);
      await expect(f.page.locator(`#${id} [contenteditable] b`)).toHaveCount(0);
      expect(rendered.caret.collapsed).toBe(true); expect(rendered.caret.anchor.inside).toBe(true);
      // A subsequent character proves the caret is at the end of the insertion,
      // including when content after the selected range must survive.
      await f.page.keyboard.type('!');
      const prefix = shape === 'cross-lines' ? 'he<b>literal</b>\n\nend\n' : shape === 'newline-only' ? 'hello \n' : expected.slice(0, expected.indexOf('right') + 5);
      expect((await snapshot(f.page, id)).model).toBe(prefix + '!' + expected.slice(prefix.length));
      await f.page.evaluate(id => editors[id].undo(), id);
      expect((await snapshot(f.page, id)).model).toBe(expected);
      await f.page.evaluate(id => editors[id].undo(), id);
      expect((await snapshot(f.page, id)).model).toBe(before);
      await f.page.evaluate(id => editors[id].redo(), id);
      expect((await snapshot(f.page, id)).model).toBe(expected);
    } finally { await f.cdp.detach(); await f.page.close(); }
  });
}

for (const id of ['lexical', 'draft']) for (const failure of ['ignored', 'cancelled', 'caret-only', 'post-paste-selection', 'reconciled', 'focus', 'selection', 'composition', 'unavailable']) test(`${id}: multiline ${failure} safely retains text without native fallback or duplicate replay`, async () => {
  const f = await setup(id);
  try {
    const append = await delivery(f);
    // Any fallback to native browser editing after a failed paste is a bug.
    await f.isolated(`document.execCommand = () => { throw Error('Unexpected native fallback'); }`);
    await f.page.locator(`#${id} [contenteditable]`).evaluate((element, { failure, id }) => {
      if (['ignored', 'cancelled', 'caret-only'].includes(failure)) element.addEventListener('paste', e => {
        if (failure === 'cancelled') e.preventDefault();
        if (failure === 'caret-only') getSelection().collapseToEnd();
        e.stopImmediatePropagation();
      }, { capture: true, once: true });
      if (failure === 'post-paste-selection') element.addEventListener('paste', () => setTimeout(() => getSelection().setPosition(element, 0), 10), { once: true });
      if (failure === 'reconciled') element.addEventListener('paste', () => setTimeout(() => { editors[id].replace('reconciled'); }, 10), { once: true });
      if (['focus', 'selection', 'composition'].includes(failure)) element.addEventListener('beforeinput', () => setTimeout(() => {
        if (failure === 'focus') document.querySelector('#react textarea').focus();
        if (failure === 'selection') getSelection().collapseToEnd();
        if (failure === 'composition') element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      }, 10), { once: true });
    }, { failure, id });
    if (failure === 'unavailable') await f.isolated('window.ClipboardEvent = undefined');
    const result = await append('\nnext');
    const ambiguous = ['reconciled', 'caret-only', 'post-paste-selection'].includes(failure) || id === 'lexical' && failure === 'composition';
    expect(result.outcome).toBe(ambiguous ? 'ambiguous' : 'not-inserted');
    expect(await f.isolated(`delivery.append(0, '\\nnext')`)).toMatchObject({ duplicate: true });
    expect((await append(' tail')).outcome).toBe('not-inserted');
    expect(await f.isolated('delivery.text()')).toBe('\nnext tail');
    if (ambiguous) expect((await f.isolated('delivery.retry(target)')).outcome).toBe('ambiguous');
    else expect((await snapshot(f.page, id)).model).toBe('hello world');
  } finally { await f.cdp.detach(); await f.page.close(); }
});
