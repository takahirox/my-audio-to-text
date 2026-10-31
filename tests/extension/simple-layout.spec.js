import { test, expect, openGraph, startGraph, emitFinal, addAudioPath } from './graph-fixture.js';

test('Simple lays out 0, 1, 2 and 4 saved displays at narrow and wide sizes with keyboard scrolling', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  for (const count of [0, 1, 2, 4]) {
    await live.editor.evaluate(async count => {
      const { graphNode, edge, saveGraph } = await import('./graph.js');
      const source = graphNode('Text', 'source'); source.settings.value = 'Long plain text '.repeat(2000);
      const displays = Array.from({ length: count }, (_, i) => {
        const node = graphNode('LiveTextDisplay', `display-${i}`); node.settings.label = `Output ${i + 1}`; return node;
      });
      saveGraph(localStorage, window.addDOMFormatters({ version: 15, nodes: [source, ...displays], edges: displays.map(node => edge('source', 'value', node.id, 'content')) }));
    }, count);
    // A stopped session retains its output snapshot until the next Start/reload.
    await live.reload();
    await expect(live.locator('.live-text-region')).toHaveCount(count);
    await expect(live.locator('#no-live-displays')).toBeVisible({ visible: count === 0 });
    if (count) {
      await live.locator('#start').click(); await expect(live.locator('#status')).toHaveText('Processing active');
      await expect(live.locator('.display-content').first()).toContainText('Long plain text');
    }
    for (const width of [390, 1440]) {
      await live.setViewportSize({ width, height: 844 });
      expect(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(live.locator('#start')).toBeInViewport();
      await expect(live.locator('#stop')).toBeInViewport();
      await expect(live.locator('#cancel-session')).toBeInViewport();
      if (count) {
        const content = live.locator('.display-content').first();
        await content.focus(); await content.press('ArrowDown');
        await expect.poll(() => content.evaluate(root => root.scrollTop)).toBeGreaterThan(0);
        expect(await content.evaluate(root => root.scrollWidth <= root.clientWidth)).toBe(true);
        const boxes = await live.locator('.live-text-region').evaluateAll(regions => regions.map(root => ({ x: root.offsetLeft, y: root.offsetTop })));
        if (count > 1) expect(boxes[1].y === boxes[0].y).toBe(width === 1440);
        // Inspect the normal compact header/control area, not a page scrolled to its output.
        await live.evaluate(() => scrollTo(0, 0));
      }
      if (process.env.UPDATE_UI_SCREENSHOTS && [0, 1, 4].includes(count)) await live.screenshot({ path: `docs/evidence/ui-136-simple-${count}-${width}.png`, fullPage: true });
    }
    if (count) { await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled(); }
  }
});

test('Simple hides routine details but keeps unknown diagnostics, recovery and next-session changes visible', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await live.evaluate(async () => {
    const { TabSession } = await import('./session.js'), update = TabSession.prototype.update;
    TabSession.prototype.update = function(...args) { window.layoutSession = this; return update.apply(this, args); };
  });
  await startGraph(live); await emitFinal(live, 'Readable output');
  await expect(live.locator('#diagnostics')).not.toHaveAttribute('open', '');
  await expect(live.locator('#translation-status')).toBeHidden();
  await expect(live.locator('#tab-status')).toBeHidden();
  await live.locator('#diagnostics > summary').press('Enter');
  await expect(live.locator('#tab-status')).toBeVisible();
  await expect(live.locator('#translation-status')).toBeVisible();
  await live.locator('#diagnostics > summary').press('Enter');
  await live.evaluate(() => window.layoutSession.update({
    conditionStatus: 'decision: A new diagnostic without a recognized error keyword.',
    summaryStatus: 'notes: Model unavailable. Retry in Models.',
    signal: 'speech: Waiting for startup language; model has not started.',
  }));
  for (const id of ['condition-status', 'summary-status', 'signal', 'model-recovery']) await expect(live.locator(`#${id}`)).toBeVisible();
  await live.editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
  await live.editor.getByLabel('transcript label', { exact: true }).fill('Next session output');
  await live.editor.locator('#graph-save').click();
  await expect(live.locator('#saved-state')).toBeVisible();
  await expect(live.locator('.display-label')).toHaveText('Text');
  await expect(live.locator('#stop')).toBeEnabled();
  await expect(live.locator('#start')).toBeDisabled();
  await live.locator('#cancel-session').click();
  await expect(live.locator('.display-content')).toHaveText('Readable output');
  await expect(live.locator('#cancel-session')).toBeDisabled();
});

test('Simple exposes required media selection and retains permission and graph recovery errors', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await expect(live.locator('#start')).toBeDisabled(); // No toolbar capture tab.
  await live.editor.evaluate(async () => {
    const { defaultGraph, graphNode, saveGraph } = await import('./graph.js');
    const graph = defaultGraph(); graph.nodes[0] = graphNode('SelectedPageMediaAudio', 'audio'); saveGraph(localStorage, window.addDOMFormatters(graph));
  });
  await expect(live.locator('#targets')).toHaveAttribute('open', '');
  await expect(live.getByRole('button', { name: 'Discover media in capture tab' })).toBeVisible();
  await live.editor.evaluate(async () => {
    const { defaultGraph, graphNode, saveGraph } = await import('./graph.js');
    const graph = defaultGraph(); graph.nodes[0] = graphNode('MicrophoneAudio', 'audio'); saveGraph(localStorage, window.addDOMFormatters(graph));
  });
  await live.evaluate(() => { window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }); });
  await expect(live.locator('#status')).toContainText('Press Start to request browser permission');
  await expect(live.locator('#start')).toBeEnabled();
  await live.editor.evaluate(() => localStorage.setItem('processing-graph-v1', '{broken'));
  await expect(live.locator('#errors')).toBeVisible(); await expect(live.locator('#start')).toBeDisabled();
  await expect(live.getByRole('link', { name: 'Graph', exact: true })).toBeVisible();
});

test('audio-only output keeps its player and download usable at narrow and wide sizes', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await addAudioPath(live, 'Supertonic3');
  await expect(live.editor.locator('#graph-models .model-status')).toContainText('Ready');
  await live.editor.evaluate(async () => {
    const { readGraph, saveGraph } = await import('./graph.js');
    const graph = readGraph(localStorage), displays = graph.nodes.filter(node => node.type === 'LiveTextDisplay').map(node => node.id);
    graph.nodes = graph.nodes.filter(node => !displays.includes(node.id));
    graph.edges = graph.edges.filter(route => !displays.includes(route.to[0])); saveGraph(localStorage, window.addDOMFormatters(graph));
  });
  await startGraph(live); await emitFinal(live, 'Spoken output');
  await expect(live.locator('.live-text-region')).toHaveCount(0);
  await expect(live.getByLabel('Generated speech', { exact: true })).toBeVisible();
  await expect(live.getByRole('link', { name: 'Download WAV' })).toBeVisible();
  for (const width of [390, 1440]) {
    await live.setViewportSize({ width, height: 844 });
    expect(await live.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const audio = live.getByLabel('Generated speech', { exact: true });
    expect(await audio.evaluate(player => player.controls && player.clientWidth <= player.parentElement.clientWidth)).toBe(true);
    if (process.env.UPDATE_UI_SCREENSHOTS) await live.screenshot({ path: `docs/evidence/ui-136-audio-${width}.png` });
  }
  await live.locator('#stop').click(); await expect(live.locator('#start')).toBeEnabled();
  await expect(live.locator('#audio-outputs audio')).toHaveCount(1);
});

test('Graph stays canvas-first and Models keeps preparation and legal notices secondary', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  for (const width of [390, 1440]) {
    await live.editor.setViewportSize({ width, height: 844 });
    await expect(live.editor.locator('#graph-save')).toBeInViewport();
    await expect(live.editor.locator('#graph-palette-toggle')).toBeInViewport();
    await expect(live.editor.locator('#graph-palette')).toBeHidden();
    await expect(live.editor.locator('.graph-inspector')).toContainText('Select a node or connection.');
    await expect(live.editor.locator('.graph-actions')).not.toHaveAttribute('open', '');
    await live.editor.locator('#graph-fit').click();
    await live.editor.getByRole('button', { name: 'Simple', exact: true }).focus();
    await live.editor.keyboard.press('Tab');
    await expect(live.editor.getByRole('link', { name: 'Models', exact: true })).toBeFocused();
    expect(await live.editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await live.models.setViewportSize({ width, height: 844 });
    await expect(live.models.locator('#translategemma a')).toContainText('Gemma Terms');
    await expect(live.models.locator('#translategemma progress')).toBeHidden();
    await expect(live.models.locator('#translategemma').getByRole('button', { name: 'Cancel download', includeHidden: true })).toBeHidden();
    await expect(live.models.locator('#persist')).toBeHidden();
    if (process.env.UPDATE_UI_SCREENSHOTS) {
      await live.editor.screenshot({ path: `docs/evidence/ui-136-graph-${width}.png` });
      await live.models.screenshot({ path: `docs/evidence/ui-136-models-${width}.png` });
    }
  }
  await live.models.getByText('Storage and cache management', { exact: true }).press('Enter');
  await expect(live.models.locator('#persistence')).toBeVisible();
  await expect(live.models.getByRole('link', { name: 'TTS terms and notices', exact: true })).toBeVisible();
  expect(f.requests).toEqual([]);
});
