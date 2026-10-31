import { clickGraphAction, openPalette, loadTranslationFixture } from './ui-controls.js';
import { legacyGraph } from '../fixtures/legacy-graph.js';
import { test, expect, openGraph, startGraph, emitFinal, addAudioPath, disconnectWire } from './graph-fixture.js';

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));

test('fresh install and Reset save the minimal graph; explicit translation, visual edits and immutable session graph', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  const minimal = await saved(page);
  expect(minimal.nodes.map(n => n.type)).toEqual(['ChromeTabAudio', 'SpeechToTextReazonSpeech', 'LiveTextDisplay', 'TextAccumulator', 'TextToDOM', 'TextToDOM', 'DOMCombiner']);
  expect(minimal.edges).toEqual([
    { from: ['audio', 'audio'], to: ['speech', 'audio'] },
    { from: ['speech', 'provisional'], to: ['transcript-preview', 'text'] },
    { from: ['speech', 'final'], to: ['transcript-accumulator', 'append'] },
    { from: ['transcript-accumulator', 'text'], to: ['transcript-dom', 'text'] },
    { from: ['transcript-dom', 'dom'], to: ['transcript-combined', 'first'] },
    { from: ['transcript-preview', 'dom'], to: ['transcript-combined', 'second'] },
    { from: ['transcript-combined', 'dom'], to: ['transcript', 'dom'] },
  ]);
  await expect(page.editor.locator('#graph-translation')).toHaveCount(0);
  expect(f.requests).toEqual([]); await startGraph(page);
  await expect(page.locator('.live-text-region')).toHaveCount(1);
  await expect(page.locator('.display-label')).toHaveText('Text');
  await expect(page.locator('#translation-status')).toHaveText('Translation off');
  await emitFinal(page, 'fresh default'); await expect(page.locator('.display-content')).toHaveText(['fresh default'].join('\n'));
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  // Translation remains an explicit draft choice, available in the palette.
  await expect(page.editor.locator('#graph-node-type option[value="OpusMtJaEn"]')).toHaveCount(1);
  await expect(page.editor.locator('#graph-node-type option[value="OpusMtEnJa"]')).toHaveCount(1);
  await loadTranslationFixture(page.editor); f.mode('error'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect(page.editor.locator('#graph-models .model-status')).toHaveText('Error'); await startGraph(page);
  await expect(page.locator('#translation-status')).toContainText('assets missing');
  const workers = await page.evaluate(() => window.graphWorkers.length);
  await emitFinal(page, 'original'); await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('original');
  await expect(page.locator('[data-display="translated"] tbody td')).toHaveText(['original','']);
  // Modify the saved graph while running. Capture/Workers are not replaced.
  await page.editor.getByRole('button', { name: 'Select translation', exact: true }).click(); await page.editor.getByRole('button', { name: 'Remove translation', exact: true }).click();
  await page.editor.getByRole('button', { name: 'Select translated', exact: true }).click(); await page.editor.getByRole('button', { name: 'Remove translated', exact: true }).click();
  await page.editor.getByRole('button', { name: 'Select translated-format', exact: true }).click(); await page.editor.getByRole('button', { name: 'Remove translated-format', exact: true }).click();
  await expect(page.editor.locator('#graph-state')).toContainText('Unsaved draft');
  await expect(page.editor.locator('#graph-errors')).toBeEmpty(); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect(page.editor.locator('#graph-state')).toContainText('earlier graph');
  expect(await page.evaluate(() => window.graphWorkers.length)).toBe(workers);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); await startGraph(page);
  await expect(page.locator('#translation-status')).toHaveText('Translation off');
  await emitFinal(page, 'transcription only'); await expect(page.locator('[data-display="transcript"] .display-content')).toContainText('transcription only');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  // Repeating an existing connection is a no-op; validation still rejects
  // externally supplied duplicates in the schema/runtime tests.
  await page.editor.getByRole('button', { name: 'speech output final', exact: true }).click();
  await page.editor.getByRole('button', { name: 'transcript-accumulator input append', exact: true }).click();
  await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  await expect(page.editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(page)).edges).toHaveLength(7);
  await clickGraphAction(page.editor, 'graph-load'); await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  // Remove and reconnect a required named port.
  await disconnectWire(page.editor, 'audio.audio to speech.audio');
  await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  await page.editor.getByRole('button', { name: 'speech output final', exact: true }).click();
  await expect(page.editor.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
  await page.editor.getByRole('button', { name: 'audio output audio', exact: true }).click();
  await page.editor.getByRole('button', { name: 'speech input audio', exact: true }).click();
  await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  const heading = page.editor.locator('[data-node="speech"] .graph-heading');
  await heading.focus(); await heading.press('ArrowRight'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect.poll(async () => (await saved(page)).nodes.find(n => n.id === 'speech').position.x).toBe(280);
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox(); await page.editor.mouse.move(box.x + 20, box.y + 10); await page.editor.mouse.down(); await page.editor.mouse.move(box.x + 50, box.y + 30); await page.editor.mouse.up();
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect.poll(async () => (await saved(page)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 50 });
  expect(f.requests).toHaveLength(1);
  const graph = await saved(page); await page.close(); const reopened = await openGraph(f); expect(await saved(reopened)).toEqual(graph);
  await f.restart(); const restarted = await openGraph(f); expect(await saved(restarted)).toEqual(graph);
  await loadTranslationFixture(restarted.editor); await restarted.editor.locator('#graph-save').click(); await expect(restarted.editor.locator('#graph-save')).toBeEnabled();
  await clickGraphAction(restarted.editor, 'graph-reset');
  await expect(restarted.editor.locator('[data-node=translation]')).toHaveCount(0);
  expect((await saved(restarted)).nodes).toHaveLength(10); // Reset is draft-only until Save.
  await restarted.editor.locator('#graph-save').click(); await expect(restarted.editor.locator('#graph-save')).toBeEnabled(); expect(await saved(restarted)).toEqual(minimal);
});

test('legacy preference migration, direction switch and corrupt saved graph recovery persist in the Chrome profile', async ({ graphExtension: f }) => {
  let page = await f.context.newPage(); await page.goto(f.url);
  await page.evaluate(() => {
    localStorage.removeItem('processing-graph-v1');
    localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: 'en-ja' }));
  }); await page.close(); page = await openGraph(f);
  expect((await saved(page)).nodes).toHaveLength(7); expect((await saved(page)).translationDirection).toBe('en-ja');
  await loadTranslationFixture(page.editor, 'en-ja'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(page)).nodes[3].type).toBe('OpusMtEnJa');
  await loadTranslationFixture(page.editor, 'ja-en'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(page)).nodes[3].type).toBe('OpusMtJaEn');
  await page.evaluate(() => localStorage.setItem('processing-graph-v1', '{broken')); await page.reload(); await page.editor.reload();
  await expect(page.locator('#errors')).toContainText('Saved graph unavailable'); await expect(page.locator('#start')).toBeDisabled();
  await clickGraphAction(page.editor, 'graph-reset'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); await expect(page.locator('#errors')).toBeEmpty();
  expect((await saved(page)).version).toBe(15);
});

for (const type of ['Supertonic3', 'Kokoro']) {
  test(`${type}: visual final-text/audio path uses production Workers, explicit preparation, playback, repeat, failure and cancellation (fixture inference)`, async ({ graphExtension: f }) => {
    const page = await openGraph(f), requests = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
    f.mode('error'); await addAudioPath(page, type); await expect(page.editor.locator('#graph-models .model-status')).toHaveText('Error'); await startGraph(page);
    await expect(page.locator('#tts-status')).toContainText('assets missing');
    await emitFinal(page, 'missing'); await expect(page.locator('[data-display="transcript"] .display-content')).toContainText('missing');
    expect(f.requests.length).toBeGreaterThan(0); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    f.mode('error'); await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} .model-status`)).toContainText('Error');
    f.mode('hold'); await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} .model-status`)).toContainText('Downloading');
    await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Cancel download' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' })).toBeEnabled();
    f.mode('normal'); await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} .model-status`)).toContainText('Ready');
    const count = f.requests.length;
    // Abort a production TTS load RPC while startup is pending.
    await page.evaluate(() => { window.holdTtsLoad = true; window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }); });
    await expect.poll(() => page.evaluate(() => window.graphWorkers.some(w => w.url.match(/supertonic3-worker|kokoro-worker/) && w.messages.some(m => m.type === 'load')))).toBe(true);
    await page.locator('#cancel-session').click(); expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
    await page.evaluate(() => { window.holdTtsLoad = false; });
    await startGraph(page); await expect(page.locator('#tts-status')).toContainText('ready (local)');
    await emitFinal(page, 'hello'); await expect(page.locator('#audio-outputs audio')).toHaveCount(1);
    await page.locator('#audio-outputs audio').evaluate(async player => { await player.play(); });
    await expect.poll(() => page.locator('#audio-outputs audio').evaluate(player => player.currentTime)).toBeGreaterThan(0);
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
    // Graceful Stop waits for the actual pending synthesis RPC and output sink.
    await startGraph(page); await emitFinal(page, 'slow');
    await expect.poll(() => page.evaluate(() => window.graphWorkers.some(w => !w.released && w.messages.some(m => m.type === 'generate' && m.text === 'slow')))).toBe(true);
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Finalizing');
    await expect(page.locator('#start')).toBeEnabled(); await expect(page.locator('#audio-outputs audio')).toHaveCount(1);
    await startGraph(page); await emitFinal(page, 'slow');
    await expect.poll(() => page.evaluate(() => window.graphWorkers.some(w => !w.released && w.messages.some(m => m.type === 'generate' && m.text === 'slow')))).toBe(true);
    await page.locator('#cancel-session').click();
    await expect(page.locator('#audio-outputs audio')).toHaveCount(0); expect(await page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
    await startGraph(page); await emitFinal(page, 'fail'); await expect(page.locator('#tts-status')).toContainText('Fixture inference failure');
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('fail'); await expect(page.locator('#status')).toHaveText('Transcription active');
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    // Cached models survive window recreation and a browser restart, with no
    // new model GETs and no text/audio in any remote request.
    await f.restart(); const reopened = await openGraph(f); await startGraph(reopened); await emitFinal(reopened, 'cached');
    await expect(reopened.locator('#audio-outputs audio')).toHaveCount(1); await reopened.locator('#stop').click();
    expect(f.requests).toHaveLength(count);
    await reopened.evaluate(async () => {
      const cache = await caches.open('transformers-cache'); const keys = await cache.keys();
      await cache.delete(keys.find(request => request.url.includes('.onnx')));
    });
    await expect(reopened.locator('#start')).toBeEnabled(); await startGraph(reopened);
    await expect(reopened.locator('#tts-status')).toContainText('assets missing'); await emitFinal(reopened, 'evicted');
    await expect(reopened.locator('[data-display="transcript"] .display-content')).toHaveText('evicted'); await expect(reopened.locator('#audio-outputs audio')).toHaveCount(0);
    expect(f.requests).toHaveLength(count);
    expect(requests.every(r => r.method === 'GET' && r.body === null && !/hello|missing|slow|cached/.test(r.url))).toBe(true);
  });
}

test('saved cycles, type mismatches, unknown ports/types refuse invocation before creating any Workers', async ({ graphExtension: f }) => {
  const page = await openGraph(f), valid = await saved(page);
  for (const [label, edit] of [
    ['acyclic', graph => graph.edges.push({ from: ['speech', 'final'], to: ['speech', 'audio'] })],
    ['Incompatible port types', graph => graph.edges[0].from = ['speech', 'final']],
    ['Unknown port', graph => graph.edges[0].from[1] = 'missing'],
    ['Unknown Node type', graph => graph.nodes[0].type = 'UnverifiedModel'],
  ]) {
    const graph = structuredClone(valid); edit(graph);
    await page.evaluate(graph => localStorage.setItem('processing-graph-v1', JSON.stringify(graph)), graph); await page.reload(); await page.editor.reload();
    await expect(page.locator('#errors')).toContainText(label);
    await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
    expect(await page.evaluate(() => window.graphWorkers.length)).toBe(0);
    await clickGraphAction(page.editor, 'graph-reset'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); await expect(page.locator('#errors')).toBeEmpty();
  }
  expect(f.requests).toEqual([]);
});

test('wide editor has a palette, typed keyboard/drag ports, inspector, zoom and preserved conflicting drafts', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await loadTranslationFixture(editor); await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await openPalette(editor); await expect(editor.getByRole('complementary', { name: 'Node palette' })).toBeVisible();
  await editor.locator('#graph-palette-toggle').click();
  await editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
  await expect(editor.getByRole('complementary', { name: 'Graph details inspector' })).toContainText('Live text display');
  await expect(editor.getByLabel('transcript label', { exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'speech output final', exact: true })).toContainText('text');
  await disconnectWire(editor, 'audio.audio to speech.audio');
  const output = editor.getByRole('button', { name: 'audio output audio', exact: true });
  const input = editor.getByRole('button', { name: 'speech input audio', exact: true });
  await output.focus(); await output.press('Space'); await input.focus(); await input.press('Enter');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await disconnectWire(editor, 'audio.audio to speech.audio');
  await output.dragTo(input); await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.locator('#graph-zoom').selectOption('0.75');
  const heading = editor.getByRole('button', { name: 'Select speech', exact: true });
  await heading.scrollIntoViewIfNeeded();
  const box = await heading.boundingBox();
  await editor.mouse.move(box.x + 10, box.y + 10); await editor.mouse.down(); await editor.mouse.move(box.x + 40, box.y + 25); await editor.mouse.up();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect.poll(async () => (await saved(live)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 50 });
  expect(await editor.locator('.graph-wires .wire-line').count()).toBe((await saved(live)).edges.length);
  expect(await editor.locator('#graph-canvas').evaluate(canvas => [...canvas.querySelectorAll('.graph-node')].every(card => card.offsetTop + card.offsetHeight <= canvas.offsetHeight))).toBe(true);
  await expect(editor.getByRole('button', { name: 'translation output source', exact: true })).toContainText('text');
  const second = await f.context.newPage(); await second.goto(editor.url());
  // Both drafts diverge from the same saved graph; saving one keeps the other's draft.
  await editor.getByRole('button', { name: 'Select speech', exact: true }).press('ArrowRight');
  await second.getByRole('button', { name: 'Select speech', exact: true }).press('ArrowDown');
  await second.locator('#graph-save').click(); await expect(second.locator('#graph-save')).toBeEnabled(); await expect(second.locator('#graph-state')).not.toContainText('Unsaved draft');
  await expect(editor.locator('#graph-state')).toContainText('draft kept');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled(); await expect(editor.locator('#graph-errors')).toContainText('Load saved');
  expect((await saved(live)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 60 });
  await clickGraphAction(editor, 'graph-load'); await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  expect(f.requests).toHaveLength(7);
});

test('three screen layouts show actual provisional/final state and capture-free Models (deterministic screenshots)', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await loadTranslationFixture(live.editor, 'ja-en', false); await live.editor.locator('#graph-save').click();
  await expect(live.editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await startGraph(live); await emitFinal(live, 'Completed fixture utterance.');
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'Current fixture utterance…' }));
  await expect(live.locator('[data-display="transcript"] .display-content')).toHaveCount(1);
  await expect(live.locator('[data-display="transcript"] .display-content')).toHaveText('Completed fixture utterance.Current fixture utterance…');
  await expect(live.getByRole('heading', { name: 'Text', exact: true })).toBeVisible();
  await live.setViewportSize({ width: 620, height: 900 });
  await live.editor.setViewportSize({ width: 1440, height: 1000 });
  await live.models.setViewportSize({ width: 1200, height: 1000 });
  await expect(live.models.getByText('ReazonSpeech ja-en · Bundled', { exact: true })).toBeVisible();
  await expect(live.models.locator('.model-status')).toHaveText(Array(12).fill('Not downloaded'));
  await expect(live.models.getByText('CosyVoice3 0.5B · streaming', { exact: true })).toBeVisible();
  expect(await live.models.evaluate(() => window.graphWorkers.length)).toBe(0);
  expect(await live.editor.evaluate(() => window.graphWorkers.length)).toBe(0);
  if (process.env.UPDATE_UI_SCREENSHOTS) {
    await live.screenshot({ path: 'docs/evidence/ui-132-live.png', fullPage: true });
    await loadTranslationFixture(live.editor);
    await live.editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
    await live.editor.locator('#graph-fit').click();
    await live.editor.screenshot({ path: 'docs/evidence/ui-132-graph.png', fullPage: true });
    await live.models.screenshot({ path: 'docs/evidence/ui-132-models.png', fullPage: true });
  }
  await live.models.setViewportSize({ width: 440, height: 800 });
  expect(await live.models.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await live.editor.setViewportSize({ width: 440, height: 800 });
  expect(await live.editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await live.emulateMedia({ reducedMotion: 'reduce' });
  await live.getByRole('link', { name: 'Graph', exact: true }).focus();
  expect(await live.getByRole('link', { name: 'Graph', exact: true }).evaluate(link => getComputedStyle(link).outlineStyle)).toBe('solid');
  expect(f.requests).toEqual([]);
  await live.locator('#cancel-session').click(); await expect(live.editor.locator('#graph-state')).toContainText('No active recording');
});

for (const [id, voice, other] of [['supertonic3', 'F1', 'M1'], ['kokoro', 'jf_alpha', 'af_heart']]) {
  test(`Models ${id}: voice-specific verified readiness, shared weights, removal and page recreation`, async ({ graphExtension: f }) => {
    const live = await openGraph(f), models = live.models, card = models.locator(`#${id}`), initialGraph = await saved(live);
    await card.locator('select').selectOption(voice);
    await expect(card.locator('.model-status')).toHaveText('Not downloaded');
    await card.getByRole('button', { name: 'Download / retry', exact: true }).click();
    await expect(card.locator('.model-status')).toContainText('Ready'); const firstCount = f.requests.length;
    await card.locator('select').selectOption(other); await expect(card.locator('.model-status')).toHaveText('Not downloaded');
    await card.getByRole('button', { name: 'Download / retry', exact: true }).click();
    await expect(card.locator('.model-status')).toContainText('Ready');
    expect(f.requests).toHaveLength(firstCount + 1); // Only the missing voice, shared weights reused.
    await models.reload(); await models.locator(`#${id} select`).selectOption(other);
    await expect(card.locator('.model-status')).toContainText('Ready');
    await card.getByRole('button', { name: 'Delete cached assets', exact: true }).click();
    await expect(card.locator('.model-status')).toHaveText('Not downloaded');
    await card.locator('select').selectOption(voice); await expect(card.locator('.model-status')).toHaveText('Not downloaded');
    expect(await models.evaluate(() => window.graphWorkers.length)).toBe(0);
    expect(await saved(live)).toEqual(initialGraph);
    expect((await saved(live)).nodes.some(node => ['Supertonic3', 'Kokoro'].includes(node.type))).toBe(false);
  });
}

test('version 1/2/3 field sinks migrate in MV3 to direct TEXT; ambiguous routes recover visibly', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  for (const version of [1, 2, 3]) for (const type of (version === 3 ? ['FocusedInputTextOutputNode'] : ['FocusedInputTextOutputNode', 'SelectedFormFieldTextOutputNode'])) {
    await page.evaluate(async ({ version, type, graph }) => {
      const { defaultGraph, graphNode, edge, GRAPH_KEY } = await import('./graph.js');
      graph.version = version;
      graph.nodes.push({ ...graphNode('FocusedInputTextOutputNode', 'field'), type });
      if (version < 3) graph.edges.push(edge('speech', 'final', 'field', 'final'));
      else {
        graph.nodes.push({ id: 'text', type: 'FinalText', settings: {}, position: { x: 20, y: 20 } });
        graph.edges.push(edge('speech', 'final', 'text', 'final'), edge('text', 'text', 'field', 'text'));
      }
      localStorage.setItem(GRAPH_KEY, JSON.stringify(graph));
    }, { version, type, graph: legacyGraph({ enabled: false }, version) });
    await page.reload(); await page.editor.reload();
    await expect(page.editor.locator('#errors')).toContainText('requires review');
    await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
    const graph = await saved(page);
    expect(graph.version).toBe(15); expect(graph.nodes.some(n => n.type === 'SelectedFormFieldTextOutputNode')).toBe(false);
    expect(graph.nodes.some(n => n.type === 'FinalText')).toBe(false);
    expect(graph.edges).toContainEqual({ from: ['speech', 'final'], to: ['field', 'text'] });
    await expect(page.editor.locator('#graph-errors')).toBeEmpty();
    await expect(page.editor.locator('#graph-node-type option[value="SelectedFormFieldTextOutputNode"]')).toHaveCount(0);
  }
  await page.evaluate(() => {
    const graph = JSON.parse(localStorage.getItem('processing-graph-v1')); graph.version = 2;
    graph.edges = graph.edges.filter(e => e.to[0] !== 'field'); localStorage.setItem('processing-graph-v1', JSON.stringify(graph));
  });
  await page.reload(); await page.editor.reload();
  await expect(page.locator('#errors')).toContainText('Cannot migrate field output'); await expect(page.locator('#start')).toBeDisabled();
  await clickGraphAction(page.editor, 'graph-reset'); await page.editor.locator('#graph-save').click();
  await expect(page.locator('#errors')).toBeEmpty(); expect((await saved(page)).version).toBe(15);
});

test('MV3 editor accepts translated TEXT through TextToDOM into LiveTextDisplay and field output with optional interim/diagnostics disconnected', async ({ graphExtension: f }) => {
  const page = await openGraph(f), editor = page.editor;
  await loadTranslationFixture(editor);
  await editor.getByRole('button', { name: 'Select translated', exact: true }).click(); await editor.getByRole('button', { name: 'Remove translated', exact: true }).click();
  await editor.getByRole('button', { name: 'Select translated-format', exact: true }).click(); await editor.getByRole('button', { name: 'Remove translated-format', exact: true }).click();
  for (const [source, output, target, input] of [['speech', 'provisional', 'transcript-preview', 'text'], ['speech', 'final', 'transcript-accumulator', 'append']]) {
    await disconnectWire(editor, `${source}.${output} to ${target}.${input}`);
  }
  await editor.getByRole('button', { name: 'translation output text', exact: true }).click();
  await expect(editor.getByRole('button', { name: 'transcript-dom input text', exact: true })).toBeEnabled();
  await expect(editor.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: 'transcript-dom input text', exact: true }).click();
  await openPalette(editor); await editor.locator('#graph-node-type').selectOption('FocusedInputTextOutputNode'); await editor.locator('#graph-add').click();
  await editor.getByRole('button', { name: 'translation output text', exact: true }).click();
  await editor.getByRole('button', { name: 'focusedinputtextoutputnode input text', exact: true }).click();
  await expect(editor.locator('#graph-errors')).toBeEmpty(); await editor.locator('#graph-save').click();
  await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  const graph = await saved(page);
  expect(graph.edges).toContainEqual({ from: ['translation', 'text'], to: ['transcript-dom', 'text'] });
  expect(graph.edges).toContainEqual({ from: ['translation', 'text'], to: ['focusedinputtextoutputnode', 'text'] });
  expect(graph.nodes.some(n => ['FinalText', 'TranslatedFinalText'].includes(n.type))).toBe(false);
  expect(await page.evaluate(() => window.graphWorkers.length)).toBe(0);
});

test('MV3 version 3 migration preserves translated field fan-out and reviewed formatter routes', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  await page.evaluate(async graph => {
    const { graphNode, edge, GRAPH_KEY } = await import('./graph.js');
    graph.edges = graph.edges.filter(route => route.to[0] !== 'translated');
    graph.edges.push(edge('translation', 'finalResult', 'translated', 'final'), edge('translation', 'provisionalResult', 'translated', 'provisional'));
    for (const route of graph.edges) {
      if (route.to[0] === 'translation' && route.to[1] === 'text') route.to[1] = 'final';
      if (route.from[0] === 'translation') route.from[1] = route.from[1] === 'finalResult' ? 'final' : 'provisional';
    }
    graph.nodes.push({ id: 'text', type: 'TranslatedFinalText', settings: {}, position: { x: 20, y: 20 } }, graphNode('FocusedInputTextOutputNode', 'a'), graphNode('FocusedInputTextOutputNode', 'b'));
    graph.edges.push(edge('translation', 'final', 'text', 'final'), edge('text', 'text', 'a', 'text'), edge('text', 'text', 'b', 'text'));
    localStorage.setItem(GRAPH_KEY, JSON.stringify(graph));
  }, legacyGraph());
  await page.reload(); await page.editor.reload();
  await expect(page.editor.locator('#errors')).toContainText('migration needs review');
  const original = await page.evaluate(() => localStorage.getItem('processing-graph-v1'));
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('processing-graph-before-v14'))).toBe(original);
  const graph = await saved(page);
  expect(graph.version).toBe(15); expect(graph.nodes.some(node => node.id === 'text')).toBe(false);
  for (const target of ['a', 'b']) expect(graph.edges).toContainEqual({ from: ['translation', 'text'], to: [target, 'text'] });
  expect(graph.edges).toContainEqual({ from: ['translation', 'source'], to: ['translated-format', 'input1'] });
  await expect(page.editor.locator('#graph-errors')).toBeEmpty();
});
