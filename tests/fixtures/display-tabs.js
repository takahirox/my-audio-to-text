// Shared acceptance checks against browser-served source and unpacked MV3.
export async function checkDisplayTabs(page, expect, packaged = false) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async packaged => {
    const base = packaged ? './' : '/extension/';
    const { graphNode, edge, GRAPH_VERSION } = await import(base + 'graph.js');
    const { TabSession } = await import(base + 'session.js');
    const { renderTextRegions } = await import(base + 'live-text-regions.js');
    const a = graphNode('Text', 'a'), b = graphNode('Text', 'b');
    a.settings.value = Array.from({ length: 100 }, (_, i) => `Source ${i}`).join('\n');
    b.settings.value = a.settings.value.replaceAll('Source', 'Translation');
    const main = graphNode('Display', 'main');
    main.settings = { title: 'Main', inputCount: 3, inputLabels: { input1: 'Transcript', input2: 'Translation', input3: 'Summary' } };
    const graph = { version: GRAPH_VERSION, nodes: [a, b, main, graphNode('TextSummaryLfm2', 'processor')], edges: [
      edge('a', 'value', 'main', 'input1'), edge('b', 'value', 'main', 'input2'),
      edge('a', 'value', 'processor', 'text'), edge('processor', 'summary', 'main', 'input3'),
    ] };
    window.summaryRequests = [];
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
      render(settings, displays = session.view.displays) {
        renderTextRegions(document.querySelector('#live-displays'), { ...graph, nodes: graph.nodes.map(node =>
          node.id === 'main' ? { ...node, settings: { ...main.settings, ...settings } } : node) }, displays);
      },
      long(prefix, count = 120) { return Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n'); },
    };
    await session.start();
  }, packaged);
  const main = page.locator('[data-display="main"]');
  const pane = port => main.locator(`[data-port="${port}"]`);
  const left = pane('input1').locator('.display-content'), right = pane('input2').locator('.display-content');
  const notes = pane('input3').locator('.display-content'), tab = name => main.getByRole('tab', { name, exact: true });
  const bottom = content => content.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(page.locator('.live-display')).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveText(['Transcript', 'Translation', 'Summary']);
  await expect(main.locator('.display-label, h2, .section-heading, [role="status"], [data-port] button')).toHaveCount(0);
  expect(await main.locator('[data-port]').evaluateAll(panes => panes.every(pane =>
    pane.children.length === 1 && pane.firstElementChild.classList.contains('display-content')))).toBe(true);
  await expect(pane('input1')).toHaveAccessibleName('Transcript');
  await expect(tab('Transcript')).toHaveAttribute('aria-selected', 'true');
  await expect(tab('Transcript')).toHaveAttribute('tabindex', '0'); await expect(tab('Summary')).toHaveAttribute('tabindex', '-1');
  expect(await tab('Transcript').getAttribute('aria-controls')).toBe(await pane('input1').getAttribute('id'));
  await expect(pane('input2')).toBeHidden(); await expect(pane('input3')).toBeHidden();
  await expect(notes).toHaveAttribute('aria-live', 'off');
  await expect(left).toContainText('Source 99'); await expect(right).toContainText('Translation 99');
  await expect(notes).toContainText('Source 99');
  // Stable DOM, selection and focus survive unrelated hidden input updates.
  await left.evaluate(el => {
    window.savedFlow = el.firstChild; window.savedContent = el; el.focus();
    const range = document.createRange(); range.selectNodeContents(el.firstChild);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    window.savedPipeline = tabsFixture.session.session.pipeline;
  });
  await page.evaluate(() => tabsFixture.send('b', tabsFixture.long('new translation')));
  await expect(right).toContainText('new translation 119'); await expect(left).toBeFocused();
  expect(await left.evaluate(el => el === savedContent && el.firstChild === savedFlow && getSelection().toString().includes('Source 99'))).toBe(true);
  await left.evaluate(el => { getSelection().removeAllRanges(); el.scrollTop = 123; el.dispatchEvent(new Event('scroll')); });
  await tab('Transcript').focus(); await tab('Transcript').press('ArrowRight');
  await expect(tab('Translation')).toBeFocused(); await expect(right).toBeVisible();
  await expect.poll(() => bottom(right)).toBeLessThanOrEqual(1);
  await tab('Translation').press('End'); await expect(tab('Summary')).toBeFocused();
  expect(await tab('Summary').evaluate(el => getComputedStyle(el).outlineStyle !== 'none')).toBe(true);
  await expect(notes).toBeVisible(); await expect(left).toBeHidden();
  await expect(notes).toHaveAttribute('aria-live', 'polite');
  await expect.poll(() => bottom(notes)).toBeLessThanOrEqual(1);
  await notes.evaluate(el => { el.scrollTop = 87; el.dispatchEvent(new Event('scroll')); });
  await page.evaluate(() => {
    tabsFixture.send('a', tabsFixture.long('background source', 150));
    tabsFixture.send('b', tabsFixture.long('background translation', 160));
  });
  await expect(left).toContainText('background source 149'); await expect(notes).toContainText('background source 149');
  const requests = await page.evaluate(() => summaryRequests.length);
  await tab('Summary').press('Home'); await expect(tab('Transcript')).toBeFocused();
  await expect.poll(() => left.evaluate(el => el.scrollTop)).toBeCloseTo(123, 0);
  await page.evaluate(() => tabsFixture.send('a', tabsFixture.long('hidden summary', 180)));
  await expect(notes).toContainText('hidden summary 179');
  await tab('Transcript').press('End');
  await expect.poll(() => notes.evaluate(el => el.scrollTop)).toBeCloseTo(87, 0);
  expect(await page.evaluate(() => summaryRequests.length)).toBe(requests + 1);
  await tab('Summary').press('ArrowRight'); await expect(tab('Transcript')).toBeFocused();
  await tab('Transcript').press('ArrowLeft'); await expect(tab('Summary')).toBeFocused();
  await tab('Translation').click(); await expect(right).toBeVisible();
  await expect.poll(() => bottom(right)).toBeLessThanOrEqual(1);
  await tab('Summary').click(); await expect(notes).toBeVisible();
  for (const width of [1440, 390, 280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [i, name] of ['Transcript', 'Translation', 'Summary'].entries()) {
      await tab(name).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(main.locator('.live-text-region:visible')).toHaveCount(1);
      await expect(pane(`input${i + 1}`)).toHaveAccessibleName(name);
      expect(await pane(`input${i + 1}`).getAttribute('aria-labelledby')).toBe(await tab(name).getAttribute('id'));
      // Only a small reading inset separates the tab strip and content.
      const spacing = await pane(`input${i + 1}`).evaluate(el => {
        const top = el.querySelector('.display-content').getBoundingClientRect().top;
        return { inset: top - el.getBoundingClientRect().top,
          belowTabs: top - el.parentNode.querySelector('.display-tabs').getBoundingClientRect().bottom };
      });
      expect(spacing.inset).toBeLessThanOrEqual(9); expect(spacing.belowTabs).toBeLessThanOrEqual(18);
      const boxes = await main.locator('.live-text-region').evaluateAll(panes => panes.map(el => {
        const r = el.getBoundingClientRect(); return { x: r.x, width: r.width, right: r.right, height: r.height };
      }));
      expect(boxes[i].width).toBeGreaterThan(0); expect(boxes[i].x).toBeGreaterThanOrEqual(0); expect(boxes[i].right).toBeLessThanOrEqual(width);
      expect(boxes.filter((_, index) => index !== i).every(box => box.width === 0 && box.height === 0)).toBe(true);
    }
  }
  expect(await page.evaluate(() => tabsFixture.session.session.pipeline === savedPipeline)).toBe(true);
  expect(await page.evaluate(() => summaryRequests.length)).toBe(requests + 1);
  // Literal safe variants and empty replacements update only their own port.
  await page.evaluate(() => {
    const node = tabsFixture.session.session.pipeline.entries.get('main');
    node.node.receive('input1', [{ id: 2, first: '<img src=x>', second: '訳' }, { id: 1, first: 'B', second: '' }], node.context);
  });
  await tab('Transcript').click();
  await expect(left.locator('td')).toHaveText(['<img src=x>', '訳', 'B', '']); await expect(main.locator('img')).toHaveCount(0);
  await page.evaluate(() => {
    const n = tabsFixture.session.session.pipeline.entries.get('main');
    n.node.receive('input1', { id: 1, first: 'only', second: '' }, n.context);
    n.node.receive('input2', '', n.context);
  });
  await expect(left.locator('tr')).toHaveCount(1); await tab('Translation').click();
  await expect(right).toBeEmpty(); await expect(pane('input2').locator('button, [role="status"]')).toHaveCount(0);
  for (const ending of ['stop', 'cancel']) {
    const retained = await left.textContent();
    await page.evaluate(ending => tabsFixture.end(ending), ending);
    await expect(left).toHaveText(retained);
    await page.evaluate(() => tabsFixture.start());
    await expect(left).toContainText('Source 99'); await expect(right).toContainText('Translation 99');
  }
  await page.evaluate(() => tabsFixture.end('cancel'));
  // Runtime relabeling retains the tab/panel association, DOM and focus.
  const panelId = await pane('input2').getAttribute('id');
  await tab('Translation').focus();
  await page.evaluate(() => tabsFixture.render({ inputLabels: { input1: 'Transcript', input2: 'Updated translation', input3: 'Summary' } }));
  await expect(tab('Updated translation')).toBeFocused();
  await expect(pane('input2')).toHaveAccessibleName('Updated translation');
  expect(await pane('input2').getAttribute('id')).toBe(panelId);
  expect(await left.evaluate(el => el === savedContent)).toBe(true);
  // Null snapshots clear active and hidden panes, including before a switch.
  await page.evaluate(() => tabsFixture.render({}, { main: {} }));
  await expect(right).toBeEmpty(); await tab('Translation').press('Home'); await expect(left).toBeEmpty();
  await page.evaluate(() => tabsFixture.render({ inputCount: 1, inputLabels: { input1: 'Live transcript' } }, {}));
  await expect(main.getByRole('tablist')).toHaveCount(0);
  await expect(pane('input1')).toHaveAttribute('role', 'group');
  await expect(pane('input1')).toHaveAccessibleName('Live transcript');
  await expect(pane('input1')).not.toHaveAttribute('aria-labelledby');
  await expect(left).toBeFocused(); await expect(left).toBeEmpty();
  await expect(main.locator('.display-label, h2, .section-heading, button, [role="status"]')).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await left.evaluate(el => el.getBoundingClientRect().top - el.parentNode.getBoundingClientRect().top)).toBeLessThanOrEqual(9);
  }
  expect(errors).toEqual([]);
}
