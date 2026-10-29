import { readFile } from 'node:fs/promises';

// Exercise the production shared renderer and formatter CSS in both browser
// engines and MV3. The web-only test server doesn't publish extension sources.
export async function installLiveScrollFixture(page, packaged = false) {
  if (!packaged) {
    const source = await readFile(new URL('../../extension/live-text-regions.js', import.meta.url), 'utf8');
    await page.route('**/live-text-regions.js', route => route.fulfill({ contentType: 'text/javascript', body: source.replace('../web/dom-nodes.js', '/dom-nodes.js') }));
    await page.addStyleTag({ content: await readFile(new URL('../../extension/recorder.css', import.meta.url), 'utf8') });
  }
  await page.evaluate(async packaged => {
    const { renderTextRegions } = await import(packaged ? './live-text-regions.js' : '/live-text-regions.js');
    const { DOMCombinerNode, DOMAccumulatorNode, PairedTextToDOMNode, TextToDOMNode } = await import(packaged ? '../web/dom-nodes.js' : '/dom-nodes.js');
    const root = document.createElement('div'); root.id = 'scroll-fixture'; document.body.append(root);
    const graph = { nodes: ['a', 'b'].map(id => ({ id, type: 'LiveTextDisplay', settings: { label: id, language: 'und' } })) };
    const displays = {}, contexts = {}, histories = {}, previews = {};
    const signal = new AbortController().signal;
    window.scrollFixture = {
      pair(id, source = 'original', translated = 'translation') { const pair = new PairedTextToDOMNode(); pair.start(); pair.receiveInputs({ source, text: translated }, { signal, groupInputs: ['source', 'text'], emit: (_, dom) => histories[id].receive('append', dom, contexts[id].history) }); },
      preview(id, text) { new TextToDOMNode({ className: 'paired-text-tail' }).receive('text', text, previews[id]); },
      resize(width) { root.style.width = `${width}px`; },
      clear(id) { histories[id].start(contexts[id].history); this.preview(id, ''); },
      snapshot(id, dom) { displays[id] = dom; this.render(); },
      render() { renderTextRegions(root, graph, displays); },
    };
    for (const id of ['a', 'b']) {
      const combiner = new DOMCombinerNode();
      const output = { signal, emit: (_, dom) => { displays[id] = dom; renderTextRegions(root, graph, displays); } };
      combiner.start(output);
      const history = { signal, emit: (_, dom) => combiner.receive('first', dom, output) };
      contexts[id] = { history }; previews[id] = { signal, emit: (_, dom) => combiner.receive('second', dom, output) };
      histories[id] = new DOMAccumulatorNode(); histories[id].start(history);
      for (let i = 0; i < 20; i++) scrollFixture.pair(id, `original ${i} ` + 'words '.repeat(8), `translation ${i} ` + '日本語 '.repeat(8));
    }
  }, packaged);
}

export async function checkLiveTextFlowScrolling(page, expect, rootType) {
  const content = id => page.locator(`#scroll-fixture [data-display="${id}"] .display-content`);
  const bottomGap = id => content(id).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await page.evaluate(rootType => {
    scrollFixture.resize(320);
    for (const id of ['a', 'b']) {
      const text = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n');
      const snapshot = rootType === 'text' ? document.createTextNode(text)
        : rootType === 'inline' ? document.createElement('span') : document.createDocumentFragment();
      if (rootType === 'inline') snapshot.textContent = text;
      if (rootType === 'fragment') {
        const span = document.createElement('span'); span.textContent = text.slice(0, text.indexOf('\n') + 1);
        snapshot.append(span, document.createTextNode(text.slice(text.indexOf('\n') + 1)));
      }
      scrollFixture.snapshot(id, snapshot);
    }
  }, rootType);
  for (const id of ['a', 'b']) {
    expect(await content(id).evaluate(el => el.scrollHeight > el.clientHeight + 300)).toBe(true);
    await expect.poll(() => bottomGap(id)).toBeLessThanOrEqual(1);
  }
  // Settle initial observer notifications before establishing independent intent.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await content('a').evaluate(el => { el.scrollTop = 123; el.dispatchEvent(new Event('scroll')); });
  const initialHeight = await content('b').evaluate(el => el.scrollHeight);
  // Only layout changes: no replacement snapshot can rescue missing observations
  // of inline roots, bare text, or a fragment's mixed inline/text children.
  for (const fontSize of [32, 24, 40]) {
    await page.evaluate(fontSize => {
      for (const el of document.querySelectorAll('#scroll-fixture .display-content')) el.style.fontSize = `${fontSize}px`;
    }, fontSize);
    // Let each layout paint, including the browser's clamping on shrink, before
    // issuing another font change. A clamped bottom alone can precede observers.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(() => content('b').evaluate(el => el.scrollHeight)).toBeGreaterThan(initialHeight);
    await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
    await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
  }
  // Returning manually to the bottom resumes following subsequent font changes.
  await content('a').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('#scroll-fixture .display-content')) el.style.fontSize = '48px';
  });
  for (const id of ['a', 'b']) await expect.poll(() => bottomGap(id)).toBeLessThanOrEqual(1);
}

export async function checkLiveScrolling(page, expect) {
  const content = id => page.locator(`#scroll-fixture [data-display="${id}"] .display-content`);
  const bottomGap = id => content(id).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  for (const id of ['a', 'b']) {
    expect(await content(id).evaluate(el => el.scrollHeight > el.clientHeight + 300)).toBe(true);
    await expect.poll(() => bottomGap(id)).toBeLessThanOrEqual(1);
  }
  // Separate one-pixel wheel movements must accumulate beyond the bottom
  // tolerance, even though each event fits within the layout-rounding tolerance.
  await content('a').hover();
  const initialTop = await content('a').evaluate(el => el.scrollTop);
  for (let i = 1; i <= 50; i++) {
    await page.mouse.wheel(0, -1);
    await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(initialTop - i, 0);
  }
  expect(await bottomGap('a')).toBeGreaterThan(24);
  const readingTop = await content('a').evaluate(el => el.scrollTop);
  await page.evaluate(() => {
    for (const id of ['a', 'b']) scrollFixture.preview(id, 'preview after small wheel movements\n'.repeat(10));
  });
  await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(readingTop, 0);
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  // A user reads older content in A, while B stays within the bottom tolerance.
  await content('a').evaluate(el => { el.scrollTop = 123; el.dispatchEvent(new Event('scroll')); });
  await content('b').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 20; el.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => {
    for (const id of ['a', 'b']) { scrollFixture.pair(id); scrollFixture.preview(id, 'long provisional\n'.repeat(10)); }
  });
  await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  // Shorter/empty tails clamp correctly without losing the independent policy.
  for (const tail of ['short', '', 'growing again\n'.repeat(15)]) {
    await page.evaluate(tail => { for (const id of ['a', 'b']) scrollFixture.preview(id, tail); }, tail);
    await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
    await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  }
  // A snapshot can arrive before ResizeObserver handles a wrapping change.
  // Keep B's established follow intent while A continues reading older content.
  await page.evaluate(() => {
    scrollFixture.resize(360);
    for (const id of ['a', 'b']) scrollFixture.preview(id, 'first update');
  });
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
  await page.evaluate(() => scrollFixture.preview('b', 'subsequent update\n'.repeat(10)));
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  // Layout changes without another snapshot still follow B; A retains its offset.
  await page.evaluate(() => scrollFixture.resize(300));
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  await expect.poll(() => content('a').evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
  // Honor an offset change even when its native scroll event is still queued.
  await content('b').evaluate(el => { el.scrollTop = 211; scrollFixture.preview('b', 'reading older content'); });
  await expect.poll(() => content('b').evaluate(el => el.scrollTop)).toBeCloseTo(211, 0);
  await content('b').evaluate(el => { el.scrollTop = el.scrollHeight; scrollFixture.preview('b', 'back at bottom\n'.repeat(10)); });
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
  // Manual return to bottom resumes following. No focus is moved by rendering.
  await content('a').evaluate(el => { el.focus(); el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => { scrollFixture.pair('a'); scrollFixture.preview('a', 'new tail\n'.repeat(20)); });
  await expect(content('a')).toBeFocused(); await expect.poll(() => bottomGap('a')).toBeLessThanOrEqual(1);
  await page.evaluate(() => { scrollFixture.clear('a'); scrollFixture.pair('a', 'fresh', '短い'); });
  expect(await content('a').evaluate(el => el.scrollTop)).toBe(0);
  await expect(content('a').locator('tr')).toHaveCount(1);
  await expect.poll(() => bottomGap('b')).toBeLessThanOrEqual(1);
}
