import { test, expect, openGraph, startGraph, emitFinal, addAudioPath } from './graph-fixture.js';

const saved = page => page.evaluate(() => JSON.parse(localStorage.getItem('processing-graph-v1')));

test('fresh install saves default translation without downloading; visual edits, validation, recovery and immutable session graph', async ({ graphExtension: f }) => {
  const page = await openGraph(f);
  expect((await saved(page)).nodes.map(n => n.type)).toEqual(['ChromeTabAudio', 'SpeechToText', 'TranscriptView', 'OpusMtJaEn', 'TranslationView']);
  expect(f.requests).toEqual([]); await startGraph(page);
  await expect(page.locator('#translation-status')).toContainText('assets missing');
  await emitFinal(page, 'original'); await expect(page.locator('#final')).toHaveText('original\n');
  await expect(page.locator('#paired-finals')).toContainText('Translation failed');
  // Modify the saved graph while running. Capture/Workers are not replaced.
  await page.editor.getByRole('button', { name: 'Remove translation', exact: true }).click();
  await page.editor.getByRole('button', { name: 'Remove translated', exact: true }).click();
  await expect(page.editor.locator('#graph-state')).toContainText('Unsaved draft');
  await expect(page.editor.locator('#graph-errors')).toBeEmpty(); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect(page.editor.locator('#graph-state')).toContainText('earlier graph');
  expect(await page.evaluate(() => window.graphWorkers.length)).toBe(2);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); await startGraph(page);
  await expect(page.locator('#translation-status')).toHaveText('Translation off');
  await emitFinal(page, 'transcription only'); await expect(page.locator('#paired-finals')).toContainText('Translation off');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  // Duplicate edges cannot be saved. Load saved restores the draft.
  await page.editor.getByRole('button', { name: 'speech output final', exact: true }).click();
  await page.editor.getByRole('button', { name: 'transcript input final', exact: true }).click();
  await expect(page.editor.locator('#graph-errors')).toContainText('Duplicate edge');
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(page)).edges).toHaveLength(3);
  await page.editor.locator('#graph-load').click(); await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  // Remove and reconnect a required named port.
  await page.editor.getByRole('button', { name: 'Disconnect audio.audio to speech.audio', exact: true }).click();
  await expect(page.editor.locator('#graph-errors')).toContainText('Required connection');
  await page.editor.getByRole('button', { name: 'speech output final', exact: true }).click();
  await expect(page.editor.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
  await page.editor.getByRole('button', { name: 'audio output audio', exact: true }).click();
  await page.editor.getByRole('button', { name: 'speech input audio', exact: true }).click();
  await expect(page.editor.locator('#graph-errors')).toBeEmpty();
  const heading = page.editor.locator('[data-node="speech"] .graph-heading');
  await heading.focus(); await heading.press('ArrowRight'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect.poll(async () => (await saved(page)).nodes.find(n => n.id === 'speech').position.x).toBe(280);
  const box = await heading.boundingBox(); await page.editor.mouse.move(box.x + 20, box.y + 10); await page.editor.mouse.down(); await page.editor.mouse.move(box.x + 50, box.y + 30); await page.editor.mouse.up();
  await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled();
  await expect.poll(async () => (await saved(page)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 50 });
  expect(f.requests).toEqual([]);
  const graph = await saved(page); await page.close(); const reopened = await openGraph(f); expect(await saved(reopened)).toEqual(graph);
  await f.restart(); const restarted = await openGraph(f); expect(await saved(restarted)).toEqual(graph);
  await restarted.editor.locator('#graph-reset').click(); await restarted.editor.locator('#graph-save').click(); await expect(restarted.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(restarted)).nodes).toHaveLength(5);
});

test('legacy preference migration, direction switch and corrupt saved graph recovery persist in the Chrome profile', async ({ graphExtension: f }) => {
  let page = await f.context.newPage(); await page.goto(f.url);
  await page.evaluate(() => {
    localStorage.removeItem('processing-graph-v1');
    localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: 'en-ja' }));
  }); await page.close(); page = await openGraph(f);
  expect((await saved(page)).nodes).toHaveLength(3); await expect(page.editor.locator('#translation-direction')).toHaveValue('en-ja');
  await page.editor.locator('#translation-enabled').check(); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(page)).nodes[3].type).toBe('OpusMtEnJa');
  await page.editor.locator('#translation-direction').selectOption('ja-en'); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); expect((await saved(page)).nodes[3].type).toBe('OpusMtJaEn');
  await page.evaluate(() => localStorage.setItem('processing-graph-v1', '{broken')); await page.reload(); await page.editor.reload();
  await expect(page.locator('#errors')).toContainText('Saved graph unavailable'); await expect(page.locator('#start')).toBeDisabled();
  await page.editor.locator('#graph-reset').click(); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); await expect(page.locator('#errors')).toBeEmpty();
  expect((await saved(page)).version).toBe(2);
});

for (const type of ['Supertonic3', 'Kokoro']) {
  test(`${type}: visual final-text/audio path uses production Workers, explicit preparation, playback, repeat, failure and cancellation (fixture inference)`, async ({ graphExtension: f }) => {
    const page = await openGraph(f), requests = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
    await addAudioPath(page, type); await startGraph(page);
    await expect(page.locator('#tts-status')).toContainText('assets missing');
    await emitFinal(page, 'missing'); await expect(page.locator('#final')).toContainText('missing');
    expect(f.requests).toEqual([]); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
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
    await expect(page.locator('#final')).toHaveText('fail\n'); await expect(page.locator('#status')).toHaveText('Transcription active');
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
    await expect(reopened.locator('#final')).toHaveText('evicted\n'); await expect(reopened.locator('#audio-outputs audio')).toHaveCount(0);
    expect(f.requests).toHaveLength(count);
    expect(requests.every(r => r.method === 'GET' && r.body === null && !/hello|missing|slow|cached/.test(r.url))).toBe(true);
  });
}

test('saved cycles, type mismatches, unknown ports/types and missing inputs refuse invocation before creating any Workers', async ({ graphExtension: f }) => {
  const page = await openGraph(f), valid = await saved(page);
  for (const [label, edit] of [
    ['acyclic', graph => graph.edges.push({ from: ['speech', 'final'], to: ['speech', 'audio'] })],
    ['Incompatible port types', graph => graph.edges[0].from = ['speech', 'final']],
    ['Unknown port', graph => graph.edges[0].from[1] = 'missing'],
    ['Unknown Node type', graph => graph.nodes[0].type = 'UnverifiedModel'],
    ['Required connection', graph => graph.edges.pop()],
    ['Only one shared Live transcript', graph => {
      graph.nodes.push({ ...structuredClone(graph.nodes.find(node => node.type === 'TranscriptView')), id: 'other' });
      for (const port of ['provisional', 'final']) graph.edges.push({ from: ['speech', port], to: ['other', port] });
    }],
  ]) {
    const graph = structuredClone(valid); edit(graph);
    await page.evaluate(graph => localStorage.setItem('processing-graph-v1', JSON.stringify(graph)), graph); await page.reload(); await page.editor.reload();
    await expect(page.locator('#errors')).toContainText(label);
    await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
    expect(await page.evaluate(() => window.graphWorkers.length)).toBe(0);
    await page.editor.locator('#graph-reset').click(); await page.editor.locator('#graph-save').click(); await expect(page.editor.locator('#graph-save')).toBeEnabled(); await expect(page.locator('#errors')).toBeEmpty();
  }
  expect(f.requests).toEqual([]);
});

test('wide editor has a palette, typed keyboard/drag ports, inspector, zoom and preserved conflicting drafts', async ({ graphExtension: f }) => {
  const live = await openGraph(f), editor = live.editor;
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await expect(editor.getByRole('complementary', { name: 'Node palette' })).toBeVisible();
  await editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
  await expect(editor.getByRole('complementary', { name: 'Node settings inspector' })).toContainText('Original transcript');
  await expect(editor.getByLabel('transcript direction', { exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'speech output final', exact: true })).toContainText('transcript');
  await editor.getByRole('button', { name: 'Disconnect audio.audio to speech.audio', exact: true }).click();
  const output = editor.getByRole('button', { name: 'audio output audio', exact: true });
  const input = editor.getByRole('button', { name: 'speech input audio', exact: true });
  await output.focus(); await output.press('Space'); await input.focus(); await input.press('Enter');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.getByRole('button', { name: 'Disconnect audio.audio to speech.audio', exact: true }).click();
  await output.dragTo(input); await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.locator('#graph-zoom').selectOption('0.75');
  const heading = editor.getByRole('button', { name: 'Select speech', exact: true });
  const box = await heading.boundingBox();
  await editor.mouse.move(box.x + 10, box.y + 10); await editor.mouse.down(); await editor.mouse.move(box.x + 40, box.y + 25); await editor.mouse.up();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect.poll(async () => (await saved(live)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 50 });
  expect(await editor.locator('.graph-wires path').count()).toBe(7);
  const second = await f.context.newPage(); await second.goto(editor.url());
  // Both drafts diverge from the same saved graph; saving one keeps the other's draft.
  await editor.getByRole('button', { name: 'Select speech', exact: true }).press('ArrowRight');
  await second.getByRole('button', { name: 'Select speech', exact: true }).press('ArrowDown');
  await second.locator('#graph-save').click(); await expect(second.locator('#graph-save')).toBeEnabled(); await expect(second.locator('#graph-state')).not.toContainText('Unsaved draft');
  await expect(editor.locator('#graph-state')).toContainText('draft kept');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled(); await expect(editor.locator('#graph-errors')).toContainText('Load saved');
  expect((await saved(live)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 60 });
  await editor.locator('#graph-load').click(); await expect(editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  expect(f.requests).toEqual([]);
});

test('three screen layouts show actual provisional/final state and capture-free Models (deterministic screenshots)', async ({ graphExtension: f }) => {
  const live = await openGraph(f);
  await live.editor.locator('#translation-enabled').uncheck(); await live.editor.locator('#graph-save').click();
  await expect(live.editor.locator('#graph-state')).not.toContainText('Unsaved draft');
  await startGraph(live); await emitFinal(live, 'Completed fixture utterance.');
  await live.evaluate(() => window.speech.receiveEvent({ type: 'partial', text: 'Current fixture utterance…' }));
  await expect(live.locator('#paired-finals li')).toHaveCount(1);
  await expect(live.locator('#partial')).toHaveText('Current fixture utterance…');
  await expect(live.getByText('In progress · provisional')).toBeVisible();
  await live.setViewportSize({ width: 620, height: 900 });
  await live.editor.setViewportSize({ width: 1440, height: 1000 });
  await live.models.setViewportSize({ width: 1200, height: 1000 });
  await expect(live.models.getByText('ReazonSpeech ja-en · Bundled', { exact: true })).toBeVisible();
  await expect(live.models.locator('.model-status')).toHaveText(['Not downloaded', 'Not downloaded', 'Not downloaded', 'Not downloaded']);
  expect(await live.models.evaluate(() => window.graphWorkers.length)).toBe(0);
  expect(await live.editor.evaluate(() => window.graphWorkers.length)).toBe(0);
  if (process.env.UPDATE_UI_SCREENSHOTS) {
    await live.screenshot({ path: 'docs/evidence/ui-77-live.png', fullPage: true });
    await live.editor.locator('#translation-enabled').check();
    await live.editor.getByRole('button', { name: 'Select transcript', exact: true }).click();
    await live.editor.screenshot({ path: 'docs/evidence/ui-77-graph.png', fullPage: true });
    await live.models.screenshot({ path: 'docs/evidence/ui-77-models.png', fullPage: true });
  }
  await live.models.setViewportSize({ width: 440, height: 800 });
  expect(await live.models.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await live.editor.setViewportSize({ width: 440, height: 800 });
  expect(await live.editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await live.emulateMedia({ reducedMotion: 'reduce' });
  await live.getByRole('link', { name: 'Graph Editor', exact: true }).focus();
  expect(await live.getByRole('link', { name: 'Graph Editor', exact: true }).evaluate(link => getComputedStyle(link).outlineStyle)).toBe('solid');
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
