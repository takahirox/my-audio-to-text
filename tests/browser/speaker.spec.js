import { test, expect } from '@playwright/test';
import { observeSpeaker } from '../fixtures/speaker-observer.js';

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(observeSpeaker);
  await page.evaluate(async () => {
    const { SpeakerOutputNode } = await import('/speaker-output.js');
    document.body.replaceChildren();
    for (const label of ['Start', 'Enable speaker', 'Stop', 'Cancel']) {
      const button = document.createElement('button'); button.textContent = label; button.id = label.split(' ')[0]; document.body.append(button);
    }
    const status = document.createElement('p'); status.id = 'speaker-status'; document.body.append(status);
    window.accept = value => window.speaker.receive('audio', {
      samples: new Float32Array(4800).fill(value), sampleRate: 24000, channels: 1,
    }, { signal: window.controller.signal });
    document.getElementById('Start').onclick = () => {
      window.speaker?.dispose(); window.controller = new AbortController();
      window.speaker = new SpeakerOutputNode({ onState: state => { status.textContent = state.message; window.speakerState = state; } });
      window.speaker.enable(); window.speaker.start({ signal: window.controller.signal });
    };
    document.getElementById('Enable').onclick = () => window.speaker.enable();
    document.getElementById('Stop').onclick = async () => { await window.speaker.stop(); window.drained = true; };
    document.getElementById('Cancel').onclick = () => { window.controller.abort(); };
  });
});

test('native default output starts consecutive clips automatically in order and Stop drains', async ({ page }) => {
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(() => { window.accept(.25); window.accept(.5); window.accept(.75); });
  await page.getByText('Stop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.drained)).toBe(true);
  const events = await page.evaluate(() => window.speakerEvents);
  expect(events.map(event => event.type)).toEqual(['start', 'end', 'start', 'end', 'start', 'end']);
  expect(events.filter(event => event.type === 'start').map(event => event.id)).toEqual([0, 1, 2]);
  expect(events.filter(event => event.type === 'start').map(event => event.firstSample)).toEqual([.25, .5, .75]);
  for (let i = 0; i < 3; i++) expect(events[i * 2 + 1].time - events[i * 2].time).toBeGreaterThanOrEqual(.19);
  expect(await page.evaluate(() => window.speaker.bytes)).toBe(0);
  await page.evaluate(() => window.speaker.dispose());
  expect(await page.evaluate(() => window.speakerContexts.map(context => context.state))).toEqual(['closed']);
});

test('blocked browser resume is visible and Enable speaker recovers queued playback during Stop', async ({ page }) => {
  await page.evaluate(() => {
    window.resumeSpeaker = AudioContext.prototype.resume;
    AudioContext.prototype.resume = () => Promise.reject(new DOMException('Browser requires activation', 'NotAllowedError'));
  });
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(async () => { await window.speaker.audio.suspend(); window.accept(.25); window.accept(.5); });
  await expect(page.locator('#speaker-status')).toContainText('Enable speaker');
  expect(await page.evaluate(() => window.speakerState.needsActivation)).toBe(true);
  await page.getByText('Stop', { exact: true }).click();
  expect(await page.evaluate(() => window.speakerEvents)).toEqual([]);
  await page.evaluate(() => { AudioContext.prototype.resume = window.resumeSpeaker; });
  await page.getByText('Enable speaker', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.drained)).toBe(true);
  expect(await page.evaluate(() => window.speakerEvents.map(event => event.type))).toEqual(['start', 'end', 'start', 'end']);
  await page.evaluate(() => window.speaker.dispose());
});

test('Cancel and repeated Start close native audio and prevent late callbacks from reviving playback', async ({ page }) => {
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(() => {
    window.accept(.25); window.accept(.5);
    window.oldSpeaker = window.speaker;
  });
  await expect.poll(() => page.evaluate(() => window.speakerEvents.length)).toBe(1);
  await page.evaluate(() => { window.lateEnd = window.speaker.current.onended; });
  await page.getByText('Cancel', { exact: true }).click();
  expect(await page.evaluate(() => window.oldSpeaker.queue.length)).toBe(0);
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(() => { window.lateEnd(); window.accept(.75); });
  await page.getByText('Stop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.drained)).toBe(true);
  expect(await page.evaluate(() => window.speakerEvents.filter(event => event.type === 'start').length)).toBe(2);
  await page.evaluate(() => window.speaker.dispose());
  expect(await page.evaluate(() => window.speakerContexts.map(context => context.state))).toEqual(['closed', 'closed']);
});
