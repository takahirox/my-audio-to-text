import { corruptSavedGraph, recoverAsNew } from './ui-controls.js';
import { expectPreparedIdle } from './live-lifecycle.js';
import { clickGraphAction, openPalette, loadTranslationFixture } from './ui-controls.js';
import { test, expect, openGraph, startGraph, emitFinal, addAudioPath, disconnectWire } from './graph-fixture.js';

const saved = page => page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());

test('fresh install and Reset use current transcription; saved model requirements apply next session', async ({ graphExtension: f }) => {
  const page = await openGraph(f), minimal = await saved(page);
  expect(minimal.nodes.map(n => n.type)).toEqual(['ChromeTabAudio', 'SpeechToTextReazonSpeech', 'KeyedTextCoalesce', 'KeyedTextPair', 'KeyedPairedTextAccumulator', 'Display']);
  expect(minimal.edges).toContainEqual({ from: ['pair', 'pair'], to: ['history', 'pair'] });
  expect(f.requests).toEqual([]); await startGraph(page);
  await emitFinal(page, 'fresh default'); await expect(page.locator('.display-content')).toHaveText('fresh default');
  const workers = await page.evaluate(() => window.graphWorkers.length);
  await loadTranslationFixture(page.editor); f.mode('error');
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => window.graphWorkers.length)).toBe(workers);
  await expect(page.locator('#saved-state')).toBeVisible();
  await emitFinal(page, 'active graph stays unchanged');
  await expect(page.locator('.display-content')).toContainText('active graph stays unchanged');
  await page.locator('#stop').click();
  await expect(page.locator('#errors')).toContainText('assets missing');
  await expect(page.locator('#start')).toBeDisabled();
  await page.editor.getByRole('button', { name: 'Select translation', exact: true }).click();
  await page.editor.getByRole('button', { name: 'Remove translation', exact: true }).click();
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await startGraph(page); await expect(page.locator('#translation-status')).toHaveText('Translation off');
  await emitFinal(page, 'source visible'); await expect(page.locator('.display-content')).toHaveText('source visible');
  await page.locator('#stop').click(); await expectPreparedIdle(page);
  await clickGraphAction(page.editor, 'graph-reset');
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  expect(await saved(page)).toEqual(minimal);
});

for (const type of ['Supertonic3', 'Kokoro']) {
  test(`${type}: visual final-text/audio path uses production Workers, explicit preparation, playback, repeat, failure and cancellation (fixture inference)`, async ({ graphExtension: f }) => {
    const page = await openGraph(f), requests = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
    f.mode('error'); await addAudioPath(page, type); await expect(page.editor.locator('#graph-models .model-status')).toHaveText('Error');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#tts-status')).toContainText('assets missing');
    await expect(page.locator('#errors')).toContainText('assets missing');
    await expect(page.locator('#model-recovery')).toBeVisible();
    await expect(page.locator('#start')).toBeDisabled();
    expect(f.requests.length).toBeGreaterThan(0);
    f.mode('error'); await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} .model-status`)).toContainText('Error');
    f.mode('hold'); await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} .model-status`)).toContainText('Downloading');
    await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Cancel download' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' })).toBeEnabled();
    f.mode('normal'); await page.models.locator(`#${type.toLowerCase()} button`).filter({ hasText: 'Download / retry' }).click(); await expect(page.models.locator(`#${type.toLowerCase()} .model-status`)).toContainText('Ready');
    const count = f.requests.length;
    // Abort a production TTS load RPC while startup is pending.
    await page.evaluate(() => { window.holdTtsLoad = true; });
    await page.locator('#retry-models').click();
    await expect.poll(() => page.evaluate(() => window.graphWorkers.some(w => w.url.match(/supertonic3-worker|kokoro-worker/) && w.messages.some(m => m.type === 'load')))).toBe(true);
    await page.locator('#stop').click(); await expect.poll(() => page.evaluate(() => window.graphWorkers.every(w => w.released))).toBe(true);
    await page.evaluate(() => { window.holdTtsLoad = false; });
    await startGraph(page);
    await emitFinal(page, 'hello'); await expect(page.locator('#audio-outputs audio')).toHaveCount(1);
    await page.locator('#audio-outputs audio').evaluate(async player => { await player.play(); });
    await expect.poll(() => page.locator('#audio-outputs audio').evaluate(player => player.currentTime)).toBeGreaterThan(0);
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    await expectPreparedIdle(page);
    // Graceful Stop waits for the actual pending synthesis RPC and output sink.
    await startGraph(page); await emitFinal(page, 'slow');
    await expect.poll(() => page.evaluate(() => window.graphWorkers.some(w => !w.released && w.messages.some(m => m.type === 'generate' && m.text === 'slow')))).toBe(true);
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Finalizing');
    await expect(page.locator('#start')).toBeEnabled(); await expect(page.locator('#audio-outputs audio')).toHaveCount(1);
    await startGraph(page); await emitFinal(page, 'slow');
    await expect.poll(() => page.evaluate(() => window.graphWorkers.some(w => !w.released && w.messages.some(m => m.type === 'generate' && m.text === 'slow')))).toBe(true);
    await page.evaluate(() => window.graphSession.cancel());
    await expect(page.locator('#audio-outputs audio')).toHaveCount(0); await expectPreparedIdle(page);
    await startGraph(page); await emitFinal(page, 'fail'); await expect(page.locator('#tts-status')).toContainText('Fixture inference failure');
    await expect(page.locator('#errors')).toContainText('Fixture inference failure');
    expect((await page.locator('#errors').textContent()).split('\n')).toHaveLength(1);
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
    await reopened.close(); const evicted = await openGraph(f);
    await expect(evicted.locator('#errors')).toContainText('assets missing');
    await expect(evicted.locator('#start')).toBeDisabled();
    await expect(evicted.locator('#audio-outputs audio')).toHaveCount(0);
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
    await corruptSavedGraph(page, JSON.stringify(graph)); await page.reload(); await page.editor.reload();
    await expect(page.locator('#errors')).toContainText(label);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect(await page.evaluate(() => window.graphWorkers.length)).toBe(0);
    await recoverAsNew(page.editor, valid);
    await expect(page.locator('#errors')).toContainText(label); // This window keeps the invalid ID.
    const recovered = new URL(page.editor.url()).searchParams.get('id');
    await page.goto(`${f.url}?graph=${recovered}&tab=42`);
    await expect(page.locator('#errors')).toBeEmpty();
  }
  expect(f.requests).toEqual([]);
});

test('wide editor has a palette, typed keyboard/drag ports, inspector, zoom and preserved conflicting drafts', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await loadTranslationFixture(editor); await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await openPalette(editor); await expect(editor.getByRole('dialog', { name: 'Add Node' })).toBeVisible();
  await editor.locator('#graph-palette-toggle').click();
  await editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
  await expect(editor.getByRole('complementary', { name: 'Graph details inspector' })).toContainText('Display');
  await expect(editor.getByLabel('transcript title', { exact: true })).toHaveValue('');
  await expect(editor.getByLabel('transcript Add input', { exact: true })).toBeEnabled();
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
  await second.locator('#graph-save').click(); await expect(second.locator('#graph-save')).toBeEnabled(); await expect(second.locator('#graph-state')).not.toContainText('Unsaved');
  await expect(editor.locator('.graph-state-notice')).toContainText('draft kept');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled(); await expect(editor.locator('#graph-errors')).toContainText('Load saved');
  expect((await saved(live)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 60 });
  await clickGraphAction(editor, 'graph-load'); await expect(editor.locator('#graph-state')).not.toContainText('Unsaved');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  expect(f.requests).toHaveLength(7);
});

test('three screen layouts show actual provisional/final state and capture-free Models (deterministic screenshots)', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await loadTranslationFixture(live.editor, 'ja-en', false); await live.editor.locator('#graph-save').click();
  await expect(live.editor.locator('#graph-state')).not.toContainText('Unsaved');
  await startGraph(live); await emitFinal(live, 'Completed fixture utterance.');
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'Current fixture utterance…' }));
  await expect(live.locator('[data-display="transcript"] .display-content')).toHaveCount(1);
  await expect(live.locator('[data-display="transcript"] .display-content')).toHaveText('Completed fixture utterance.Current fixture utterance…');
  await expect(live.locator('.live-text-region')).toHaveAccessibleName('Input 1');
  await live.setViewportSize({ width: 620, height: 900 });
  await live.editor.setViewportSize({ width: 1440, height: 1000 });
  await live.models.setViewportSize({ width: 1200, height: 1000 });
  await expect(live.models.locator('.bundled-models').getByText('ReazonSpeech ja-en', { exact: true })).toBeVisible();
  await expect(live.models.locator('.model-card .model-status')).toHaveText(Array(12).fill('Not downloaded'));
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
  await live.getByRole('link', { name: 'Edit graph', exact: true }).focus();
  await live.keyboard.press('Shift+Tab'); await live.keyboard.press('Tab');
  expect(await live.getByRole('link', { name: 'Edit graph', exact: true }).evaluate(link => getComputedStyle(link).outlineStyle)).toBe('solid');
  expect(f.requests).toEqual([]);
  await live.locator('#stop').click(); await expect(live.editor.locator('.graph-activity')).toBeHidden();
  await expect(live.editor.locator('#graph-state')).toHaveText('Saved');
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
