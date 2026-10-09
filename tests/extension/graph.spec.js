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
  await page.getByRole('button', { name: 'Remove translation', exact: true }).click();
  await page.getByRole('button', { name: 'Remove translated', exact: true }).click();
  await expect(page.locator('#graph-state')).toContainText('Unsaved draft');
  await expect(page.locator('#graph-errors')).toBeEmpty(); await page.locator('#graph-save').click();
  await expect(page.locator('#graph-state')).toContainText('earlier graph');
  expect(await page.evaluate(() => window.graphWorkers.length)).toBe(2);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); await startGraph(page);
  await expect(page.locator('#translation-status')).toHaveText('Translation off');
  await emitFinal(page, 'transcription only'); await expect(page.locator('#paired-finals')).toContainText('Translation off');
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
  // Duplicate edges cannot be saved. Load saved restores the draft.
  await page.getByRole('button', { name: 'speech output final', exact: true }).click();
  await page.getByRole('button', { name: 'transcript input final', exact: true }).click();
  await expect(page.locator('#graph-errors')).toContainText('Duplicate edge');
  await page.locator('#graph-save').click(); expect((await saved(page)).edges).toHaveLength(3);
  await page.locator('#graph-load').click(); await expect(page.locator('#graph-errors')).toBeEmpty();
  // Remove and reconnect a required named port.
  await page.getByRole('button', { name: 'Disconnect audio.audio to speech.audio', exact: true }).click();
  await expect(page.locator('#graph-errors')).toContainText('Required connection');
  await page.getByRole('button', { name: 'speech output final', exact: true }).click();
  await expect(page.getByRole('button', { name: 'speech input audio', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'audio output audio', exact: true }).click();
  await page.getByRole('button', { name: 'speech input audio', exact: true }).click();
  await expect(page.locator('#graph-errors')).toBeEmpty();
  const heading = page.locator('[data-node="speech"] .graph-heading');
  await heading.focus(); await heading.press('ArrowRight'); await page.locator('#graph-save').click();
  expect((await saved(page)).nodes.find(n => n.id === 'speech').position.x).toBe(280);
  const box = await heading.boundingBox(); await page.mouse.move(box.x + 20, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 50, box.y + 30); await page.mouse.up();
  await page.locator('#graph-save').click();
  expect((await saved(page)).nodes.find(n => n.id === 'speech').position).toEqual({ x: 310, y: 50 });
  expect(f.requests).toEqual([]);
  const graph = await saved(page); await page.close(); const reopened = await openGraph(f); expect(await saved(reopened)).toEqual(graph);
  await f.restart(); const restarted = await openGraph(f); expect(await saved(restarted)).toEqual(graph);
  await restarted.locator('#graph-reset').click(); await restarted.locator('#graph-save').click(); expect((await saved(restarted)).nodes).toHaveLength(5);
});

test('legacy preference migration, direction switch and corrupt saved graph recovery persist in the Chrome profile', async ({ graphExtension: f }) => {
  let page = await f.context.newPage(); await page.goto(f.url);
  await page.evaluate(() => {
    localStorage.removeItem('processing-graph-v1');
    localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: 'en-ja' }));
  }); await page.close(); page = await openGraph(f);
  expect((await saved(page)).nodes).toHaveLength(3); await expect(page.locator('#translation-direction')).toHaveValue('en-ja');
  await page.locator('#translation-enabled').check(); expect((await saved(page)).nodes[3].type).toBe('OpusMtEnJa');
  await page.locator('#translation-direction').selectOption('ja-en'); expect((await saved(page)).nodes[3].type).toBe('OpusMtJaEn');
  await page.evaluate(() => localStorage.setItem('processing-graph-v1', '{broken')); await page.reload();
  await expect(page.locator('#errors')).toContainText('Saved graph unavailable'); await expect(page.locator('#start')).toBeDisabled();
  await page.locator('#graph-reset').click(); await page.locator('#graph-save').click(); await expect(page.locator('#errors')).toBeEmpty();
  expect((await saved(page)).version).toBe(1);
});

for (const type of ['Supertonic3', 'Kokoro']) {
  test(`${type}: visual final-text/audio path uses production Workers, explicit preparation, playback, repeat, failure and cancellation (fixture inference)`, async ({ graphExtension: f }) => {
    const page = await openGraph(f), requests = [];
    page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData() }));
    await addAudioPath(page, type); await startGraph(page);
    await expect(page.locator('#tts-status')).toContainText('assets missing');
    await emitFinal(page, 'missing'); await expect(page.locator('#final')).toContainText('missing');
    expect(f.requests).toEqual([]); await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    f.mode('error'); await page.locator('#prepare-tts').click(); await expect(page.locator('#tts-model-status')).toContainText('Error');
    f.mode('hold'); await page.locator('#prepare-tts').click(); await expect(page.locator('#tts-model-status')).toContainText('Downloading');
    await page.locator('#cancel-tts-download').click(); await expect(page.locator('#prepare-tts')).toBeEnabled();
    f.mode('normal'); await page.locator('#prepare-tts').click(); await expect(page.locator('#tts-model-status')).toContainText('Ready');
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
  ]) {
    const graph = structuredClone(valid); edit(graph);
    await page.evaluate(graph => localStorage.setItem('processing-graph-v1', JSON.stringify(graph)), graph); await page.reload();
    await expect(page.locator('#errors')).toContainText(label);
    await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
    expect(await page.evaluate(() => window.graphWorkers.length)).toBe(0);
    await page.locator('#graph-reset').click(); await page.locator('#graph-save').click(); await expect(page.locator('#errors')).toBeEmpty();
  }
  expect(f.requests).toEqual([]);
});
