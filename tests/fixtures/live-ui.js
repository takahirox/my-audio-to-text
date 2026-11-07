// Shared layout acceptance against the production recorder and model-free graph.
export async function installLiveUIGraph(page) {
  await page.evaluate(async () => {
    const { graphNode, edge, GRAPH_KEY, GRAPH_VERSION } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    const { TabSession } = await import('./session.js');
    const update = TabSession.prototype.update;
    TabSession.prototype.update = function(...args) { window.liveUISession = this; return update.apply(this, args); };
    const source = graphNode('Text', 'source'), translation = graphNode('Text', 'translation');
    source.settings.value = Array.from({ length: 50 }, (_, i) => `${i + 1}. 音声から届いた文章を、落ち着いて読み進められます。\n表示する内容とタブの名前はグラフで設定できます。`).join('\n\n');
    translation.settings.value = Array.from({ length: 50 }, (_, i) => `${i + 1}. Read the current text at your own pace. This reading pane preserves literal text and keeps the session controls within easy reach.`).join('\n\n');
    const main = graphNode('Display', 'main');
    main.settings = { title: 'Reading', inputCount: 3, inputLabels: { input1: '文字起こし', input2: 'Translation', input3: 'Notes' } };
    const review = graphNode('Button', 'review'), notes = graphNode('Button', 'notes');
    review.settings.label = 'Review translation'; notes.settings.label = 'Cancel';
    const graph = { version: GRAPH_VERSION, nodes: [source, translation, main, review, notes, graphNode('Hold', 'held-translation'), graphNode('Hold', 'held-notes')], edges: [
      edge('source', 'value', 'main', 'input1'),
      edge('translation', 'value', 'held-translation', 'input'), edge('review', 'trigger', 'held-translation', 'trigger'), edge('held-translation', 'value', 'main', 'input2'),
      edge('source', 'value', 'held-notes', 'input'), edge('notes', 'trigger', 'held-notes', 'trigger'), edge('held-notes', 'value', 'main', 'input3'),
    ] };
    await saveLiveGraphData(localStorage, graph);
    dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
  });
}

export async function checkLiveUI(page, expect, screenshot) {
  await expect(page.locator('#session-state')).toHaveText('Idle');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#stop')).toBeDisabled();
  await expect(page.locator('#cancel-session, #targets, #target-status, #target-controls, .target-row')).toHaveCount(0);
  await expect(page.locator('#hold-status')).toBeHidden();
  await expect(page.locator('.actions button')).toHaveText(['▶ Start', '■ Stop']);
  await expect(page.locator('#graph-action-buttons button')).toHaveText(['Cancel', 'Review translation']);
  await page.locator('#start').click();
  await expect(page.locator('#status')).toHaveText('Processing active');
  await expect(page.locator('#session-state')).toHaveText('Running');
  await expect(page.locator('#start')).toBeDisabled();
  const content = page.locator('[data-port=input1] .display-content');
  await expect(content).toContainText('50.');
  // Use the beginning of real fixture text for the visual evidence.
  await content.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  for (const [width, height] of [[1440, 1000], [800, 844], [390, 844], [390, 520]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => scrollTo(0, 0));
    const geometry = await page.evaluate(() => {
      const rect = selector => { const b = document.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, height: b.height }; };
      return { overflow: document.documentElement.scrollWidth > innerWidth, reader: rect('.live-display'), content: rect('[data-port=input1] .display-content'), controls: rect('.capture-panel'), toolbar: rect('.actions'), start: rect('#start'), stop: rect('#stop'), status: rect('.live-status'), actions: rect('#graph-action-area'), buttons: [...document.querySelectorAll('.actions button, #graph-action-buttons button, nav a')].map(b => ({ height: b.getBoundingClientRect().height, right: b.getBoundingClientRect().right })), light: getComputedStyle(document.documentElement).colorScheme };
    });
    expect(geometry.overflow).toBe(false);
    expect(geometry.start.y).toBe(geometry.stop.y);
    expect(geometry.start.x).toBe(geometry.toolbar.x);
    expect(geometry.stop.right).toBeCloseTo(geometry.toolbar.right, 1);
    expect(geometry.stop.right - geometry.stop.x).toBeCloseTo(geometry.start.right - geometry.start.x, 1);
    expect(geometry.light).toBe('light');
    expect(geometry.actions.bottom).toBeLessThan(geometry.reader.y);
    expect(geometry.reader.bottom).toBeLessThanOrEqual(geometry.status.y);
    if (height >= 844) {
      expect(geometry.reader.height).toBeGreaterThan(height * .5);
      expect(geometry.status.bottom).toBeLessThanOrEqual(height);
    }
    expect(geometry.content.height).toBeGreaterThan(200);
    for (const button of geometry.buttons) { expect(button.height).toBeGreaterThanOrEqual(44); expect(button.right).toBeLessThanOrEqual(width); }
    await expect(page.locator('#start')).toBeInViewport();
    expect(await content.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth)).toBe(true);
    await screenshot(`${width}x${height}`, geometry);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-node-id=review]').click();
  await page.getByRole('tab', { name: 'Translation', exact: true }).click();
  await expect(page.locator('[data-port=input2] .display-content')).toContainText('Read the current text');
  await expect(content).toBeHidden();
  await expect(page.locator('.live-text-region:visible')).toHaveCount(1);
  await page.locator('#stop').click();
  await expect(page.locator('#session-state')).toHaveText('Completed');
  await page.locator('#start').click();
  // A graph Button named Cancel remains an ordinary graph action.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('tab', { name: 'Notes', exact: true }).click();
  await expect(page.locator('[data-port=input3] .display-content')).toContainText('50.');
  await expect(page.locator('#session-state')).toHaveText('Running');
  await page.locator('#stop').click();
  await expect(page.locator('#session-state')).toHaveText('Completed');
  // Render transient lifecycle states without adding test-only production hooks.
  for (const [state, label] of [['loading', 'Loading'], ['starting', 'Starting'], ['stopping', 'Stopping']]) {
    await page.evaluate(state => liveUISession.update({ state, status: 'Controlled lifecycle progress' }), state);
    await expect(page.locator('#session-state')).toHaveText(label);
    await expect(page.locator('#start')).toBeDisabled();
    await expect(page.locator('#stop')).toBeEnabled({ enabled: state !== 'stopping' });
  }
  await page.evaluate(() => liveUISession.update({ state: 'idle', error: 'Permission denied. Choose a capture target and retry.', modelRecovery: true }));
  await expect(page.locator('#session-state')).toHaveText('Error');
  await expect(page.locator('#errors')).toBeInViewport();
  await expect(page.locator('#model-recovery')).toBeVisible();
  await expect(page.locator('#summary-status')).toBeHidden();
  await screenshot('error-390', null);
  await page.evaluate(async () => {
    const { graphNode, GRAPH_KEY, GRAPH_VERSION } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
    liveUISession.update({ error: '', summaryStatus: '', status: 'Ready' });
    await saveLiveGraphData(localStorage, { version: GRAPH_VERSION, nodes: [graphNode('Text', 'only-source')], edges: [] });
    dispatchEvent(new StorageEvent('storage', { key: GRAPH_KEY }));
  });
  await expect(page.locator('#graph-action-area')).toBeHidden();
  // Retained completed output clears on reload even for a graph with no path.
  await page.reload();
  await expect(page.locator('#no-live-displays')).toBeVisible();
}
