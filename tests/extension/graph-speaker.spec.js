import { test, expect, openGraph, emitFinal } from './graph-fixture.js';
import { openPalette, loadTranslationFixture } from './ui-controls.js';
import { observeSpeaker } from '../fixtures/speaker-observer.js';

async function speakerGraph(f, type = 'Supertonic3') {
  const page = await openGraph(f), editor = page.editor;
  await page.evaluate(observeSpeaker);
  await page.evaluate(async () => {
    const { SpeakerOutputNode } = await import('../web/speaker-output.js');
    const start = SpeakerOutputNode.prototype.start;
    SpeakerOutputNode.prototype.start = function(context) { window.liveSpeaker = this; return start.call(this, context); };
  });
  await loadTranslationFixture(editor, 'ja-en', false);
  for (const node of [type, 'SpeakerOutput']) {
    await openPalette(editor);
    if (node === 'SpeakerOutput') {
      await editor.getByLabel('Node category', { exact: true }).selectOption('Outputs');
      await expect(editor.locator('#graph-node-type option[value="AudioOutput"]')).toHaveText('Audio player / WAV');
      await expect(editor.locator('#graph-node-type option[value="SpeakerOutput"]')).toHaveText('Speaker');
    }
    await editor.locator('#graph-node-type').selectOption(node); await editor.locator('#graph-add').click();
  }
  for (const [source, output, target, input] of [['speech', 'final', type.toLowerCase(), 'text'], [type.toLowerCase(), 'audio', 'speakeroutput', 'audio']]) {
    await editor.getByRole('button', { name: `${source} output ${output}`, exact: true }).click();
    await editor.getByRole('button', { name: `${target} input ${input}`, exact: true }).click();
  }
  await expect(editor.locator('#graph-errors')).toBeEmpty();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect(editor.locator('#graph-models .model-status')).toContainText('Ready');
  await editor.reload();
  await expect(editor.getByRole('button', { name: 'speakeroutput input audio', exact: true })).toBeVisible();
  return page;
}
async function startSpeaker(page) {
  await page.evaluate(() => window.graphInvoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
  await expect(page.locator('#status')).toContainText('Press Start');
  expect(await page.evaluate(() => window.speakerContexts.length)).toBe(0);
  await page.locator('#start').click(); await expect(page.locator('#status')).toHaveText('Transcription active');
}
for (const type of ['Supertonic3', 'Kokoro']) {
  test(`MV3 ${type} → Speaker saves/reloads, plays consecutive TTS clips and drains on Stop`, async ({ graphExtension: f }) => {
    const page = await speakerGraph(f, type), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await startSpeaker(page);
    await emitFinal(page, 'First'); await emitFinal(page, 'Second'); await emitFinal(page, 'Third');
    await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(() => window.speakerEvents.map(event => event.type))).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
    expect(await page.evaluate(() => window.speakerContexts.map(context => context.state))).toEqual(['closed']);
    await expect(page.locator('#audio-outputs audio')).toHaveCount(0);
    await expect(page.locator('#audio-outputs a')).toHaveCount(0);
    await expect(page.locator('#speaker-hint')).toContainText('Keep this Live window open');
    expect(await page.evaluate(() => window.graphWorkers.every(worker => worker.released))).toBe(true);
    expect(await page.evaluate(() => window.graphWorkers.flatMap(worker => worker.messages)
      .filter(message => message.type === 'generate').map(message => message.text))).toEqual(['First', 'Second', 'Third']);
    expect(errors).toEqual([]);
  });
}

test('MV3 autoplay failure preserves clips and offers Enable speaker while Stop drains', async ({ graphExtension: f }) => {
  const page = await speakerGraph(f);
  await page.evaluate(() => {
    window.nativeResume = AudioContext.prototype.resume;
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(...args) { super(...args); void this.suspend(); }
      resume() { return Promise.reject(Error('Browser blocked playback')); }
    };
  });
  await startSpeaker(page);
  await expect(page.locator('#speaker-status')).toContainText('Browser blocked playback');
  await page.evaluate(() => window.liveSpeaker.audio.suspend());
  await emitFinal(page, 'First'); await emitFinal(page, 'Second');
  await expect.poll(() => page.evaluate(() => window.liveSpeaker.queue.length)).toBe(2);
  await expect(page.locator('#speaker-status')).toContainText('Enable speaker');
  await expect(page.locator('#enable-speaker')).toBeVisible();
  await page.locator('#stop').click(); await expect(page.locator('#status')).toHaveText('Finalizing graph outputs…');
  expect(await page.evaluate(() => window.speakerEvents)).toEqual([]);
  await page.evaluate(() => { AudioContext.prototype.resume = window.nativeResume; });
  await page.locator('#enable-speaker').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.speakerEvents.map(event => event.type))).toEqual(['start', 'end', 'start', 'end']);
  await expect(page.locator('#enable-speaker')).toBeHidden();
});

test('MV3 missing output device reports recovery and retries without losing accepted audio', async ({ graphExtension: f }) => {
  const page = await speakerGraph(f);
  await page.evaluate(() => {
    window.nativeContext = AudioContext;
    window.AudioContext = class { constructor() { throw Error('No audio output device'); } };
  });
  await startSpeaker(page); await emitFinal(page, 'First');
  await expect(page.locator('#speaker-status')).toContainText('No audio output device');
  await expect(page.locator('#enable-speaker')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.liveSpeaker.queue.length)).toBe(1);
  await page.evaluate(() => { window.AudioContext = window.nativeContext; });
  await page.locator('#enable-speaker').click(); await page.locator('#stop').click();
  await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.speakerEvents.map(event => event.type))).toEqual(['start', 'end']);
});

test('MV3 saturation reports rejected TTS clips and Stop drains every accepted clip', async ({ graphExtension: f }) => {
  const page = await speakerGraph(f); await startSpeaker(page);
  await page.evaluate(async () => {
    await window.liveSpeaker.audio.suspend();
    for (let i = 0; i < 34; i++) window.speech.receiveEvent({ type: 'final', text: `Clip ${i}` });
  });
  await expect(page.locator('#speaker-status')).toContainText('2 clip(s) rejected');
  expect(await page.evaluate(() => window.liveSpeaker.queue.length)).toBe(32);
  await page.locator('#stop').click(); await page.locator('#enable-speaker').click();
  await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.speakerEvents.filter(event => event.type === 'start').length)).toBe(32);
  expect(await page.evaluate(() => window.liveSpeaker.bytes)).toBe(0);
  await expect(page.locator('#speaker-status')).toContainText('2 clip(s) rejected');
});

test('MV3 Cancel, repeated Start and closing Live release audio and suppress old TTS replies', async ({ graphExtension: f }) => {
  const page = await speakerGraph(f); await startSpeaker(page);
  await emitFinal(page, 'First');
  await expect.poll(() => page.evaluate(() => window.speakerEvents.filter(event => event.type === 'start').length)).toBe(1);
  await emitFinal(page, 'slow');
  await expect.poll(() => page.evaluate(() => window.graphWorkers.some(worker => worker.messages.some(message => message.type === 'generate' && message.text === 'slow')))).toBe(true);
  await page.locator('#cancel-session').click();
  await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.speakerContexts.map(context => context.state))).toEqual(['closed']);
  expect(await page.evaluate(() => window.graphWorkers.every(worker => worker.released))).toBe(true);
  await page.locator('#start').click(); await expect(page.locator('#status')).toHaveText('Transcription active');
  await emitFinal(page, 'Fresh');
  await expect.poll(() => page.evaluate(() => window.speakerEvents.filter(event => event.type === 'start').length)).toBe(2);
  await page.evaluate(() => {
    const close = AudioContext.prototype.close;
    AudioContext.prototype.close = function() { localStorage.setItem('speaker-closed-on-hide', 'yes'); return close.call(this); };
  });
  await page.close();
  await expect.poll(() => page.editor.evaluate(() => localStorage.getItem('speaker-closed-on-hide'))).toBe('yes');
});
