// Shared acceptance checks against browser-served source and unpacked MV3.
export async function checkDisplayTabs(page, expect, packaged = false) {
  await page.evaluate(async packaged => {
    const base = packaged ? './' : '/extension/';
    const { graphNode, edge, GRAPH_VERSION } = await import(base + 'graph.js');
    const { TabSession } = await import(base + 'session.js');
    const { renderTextRegions } = await import(base + 'live-text-regions.js');
    const a = graphNode('Text', 'a'), b = graphNode('Text', 'b');
    a.settings.value = Array.from({ length: 100 }, (_, i) => `Source ${i}`).join('\n');
    b.settings.value = a.settings.value.replaceAll('Source', 'Translation');
    const main = graphNode('Display', 'main'), summary = graphNode('Display', 'summary');
    main.settings = { title: 'Main', inputCount: 2 }; summary.settings.title = 'Summary';
    const graph = { version: GRAPH_VERSION, nodes: [a, b, main, graphNode('TextSummaryLfm2', 'processor'), summary], edges: [
      edge('a', 'value', 'main', 'input1'), edge('b', 'value', 'main', 'input2'),
      edge('a', 'value', 'processor', 'text'), edge('processor', 'summary', 'summary', 'input1'),
    ] };
    window.summaryRequests = []; window.copiedTexts = [];
    navigator.clipboard.writeText = async text => copiedTexts.push(text);
    const session = new TabSession(view => {
      renderTextRegions(document.querySelector('#live-displays'), view.activeGraph || view.savedGraph, view.displays);
    }, { graph, textSummaryWorkerFactory: () => {
      const worker = { postMessage(message) {
        if (message.type === 'load') queueMicrotask(() => worker.onmessage?.({ data: { id: message.id, type: 'ready' } }));
        if (message.type === 'summarize') {
          summaryRequests.push(message.text);
          queueMicrotask(() => worker.onmessage?.({ data: { id: message.id, type: 'result', summary: message.text } }));
        }
      }, terminate() {} }; return worker;
    } });
    window.tabsFixture = {
      session, graph,
      send(id, text) { session.session.pipeline.entries.get(id).context.emit('value', text); },
      start() { return session.start(); },
      end(method) { return session[method](); },
      long(prefix, count = 120) { return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n'); },
    };
    await session.start();
  }, packaged);
  const main = page.locator('[data-display="main"]'), summary = page.locator('[data-display="summary"]');
  const left = main.locator('[data-port="input1"] .display-content'), right = main.locator('[data-port="input2"] .display-content');
  const notes = summary.locator('.display-content'), tab = name => page.getByRole('tab', { name, exact: true });
  const bottom = content => content.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(page.getByRole('tab')).toHaveCount(2); await expect(tab('Main')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Main')).toHaveAttribute('tabindex', '0'); await expect(tab('Summary')).toHaveAttribute('tabindex', '-1');
  expect(await tab('Main').getAttribute('aria-controls')).toBe(await main.getAttribute('id'));
  await expect(main.getByRole('heading')).toHaveText(['Input 1', 'Input 2']);
  await expect(summary).toBeHidden(); await expect(notes).toHaveAttribute('aria-live', 'off');
  await expect(left).toContainText('Source 99'); await expect(right).toContainText('Translation 99');
  await expect(notes).toContainText('Source 99');
  // Stable DOM, selection and focus survive unrelated pane updates.
  await left.evaluate(el => {
    window.savedFlow = el.firstChild; window.savedContent = el; el.focus();
    const range = document.createRange(); range.selectNodeContents(el.firstChild);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await page.evaluate(() => tabsFixture.send('b', tabsFixture.long('new translation')));
  await expect(right).toContainText('new translation 119'); await expect(left).toBeFocused();
  expect(await left.evaluate(el => el === savedContent && el.firstChild === savedFlow && getSelection().toString().includes('Source 99'))).toBe(true);
  // Establish independent intent in each tab, then update it while hidden.
  await left.evaluate(el => { getSelection().removeAllRanges(); el.scrollTop = 123; el.dispatchEvent(new Event('scroll')); });
  await tab('Main').focus(); await tab('Main').press('ArrowRight');
  await expect(tab('Summary')).toBeFocused();
  expect(await tab('Summary').evaluate(el => getComputedStyle(el).outlineStyle !== 'none')).toBe(true);
  await expect(summary).toBeVisible(); await expect(main).toBeHidden();
  await expect(notes).toHaveAttribute('aria-live', 'polite');
  await expect.poll(() => bottom(notes)).toBeLessThanOrEqual(1);
  await notes.evaluate(el => { el.scrollTop = 87; el.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => {
    tabsFixture.send('a', tabsFixture.long('background source', 150));
    tabsFixture.send('b', tabsFixture.long('background translation', 160));
  });
  await expect(left).toContainText('background source 149'); await expect(notes).toContainText('background source 149');
  const requests = await page.evaluate(() => summaryRequests.length);
  await tab('Summary').press('Home'); await expect(tab('Main')).toBeFocused();
  await expect.poll(() => left.evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
  await expect.poll(() => bottom(right)).toBeLessThanOrEqual(1);
  await page.evaluate(() => tabsFixture.send('a', tabsFixture.long('hidden summary', 180)));
  await expect(notes).toContainText('hidden summary 179');
  await tab('Main').press('End');
  await expect.poll(() => notes.evaluate(el => el.scrollTop)).toBeCloseTo(87, 0);
  expect(await page.evaluate(() => summaryRequests.length)).toBe(requests + 1);
  // Clicking/touch-style selection is also presentation-only; wrap navigation.
  await tab('Summary').press('ArrowRight'); await expect(tab('Main')).toBeFocused();
  await main.locator('[data-port="input2"] button').click();
  expect((await page.evaluate(() => copiedTexts.at(-1))).startsWith('background translation')).toBe(true);
  await tab('Summary').click(); await summary.locator('button').click();
  expect((await page.evaluate(() => copiedTexts.at(-1))).startsWith('hidden summary')).toBe(true);
  await tab('Main').click();
  for (const width of [1440, 390, 280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const boxes = await main.locator('.live-text-region').evaluateAll(panes => panes.map(el => {
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right };
    }));
    expect(boxes[1].y === boxes[0].y).toBe(width === 1440);
    expect(boxes.every(box => box.x >= 0 && box.right <= width)).toBe(true);
  }
  // Literal safe data, one pair, a whole list and empty replacement stay local.
  await page.evaluate(() => {
    const pipeline = tabsFixture.session.session.pipeline, node = pipeline.entries.get('main');
    node.node.receive('input1', [{ id: 2, first: '<img src=x>', second: '訳' }, { id: 1, first: 'B', second: '' }], node.context);
  });
  await expect(left.locator('td')).toHaveText(['<img src=x>', '訳', 'B', '']); await expect(main.locator('img')).toHaveCount(0);
  await page.evaluate(() => {
    const n = tabsFixture.session.session.pipeline.entries.get('main');
    n.node.receive('input1', { id: 1, first: 'only', second: '' }, n.context);
  });
  await expect(left.locator('tr')).toHaveCount(1);
  for (const ending of ['stop', 'cancel']) {
    const retained = await left.textContent();
    await page.evaluate(ending => tabsFixture.end(ending), ending);
    await expect(left).toHaveText(retained);
    await page.evaluate(() => tabsFixture.start());
    await expect(left).toContainText('Source 99'); await expect(right).toContainText('Translation 99');
  }
  await page.evaluate(() => tabsFixture.end('cancel'));
}
