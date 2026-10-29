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
      preview(id, text) { new TextToDOMNode().receive('text', text, previews[id]); },
      resize(width) { root.style.width = `${width}px`; },
      clear(id) { histories[id].start(contexts[id].history); this.preview(id, ''); },
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

export async function checkLiveScrolling(page, expect) {
  const content = id => page.locator(`#scroll-fixture [data-display="${id}"] .display-content`);
  const bottomGap = id => content(id).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  for (const id of ['a', 'b']) {
    expect(await content(id).evaluate(el => el.scrollHeight > el.clientHeight + 300)).toBe(true);
    await expect.poll(() => bottomGap(id)).toBeLessThanOrEqual(1);
  }
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
