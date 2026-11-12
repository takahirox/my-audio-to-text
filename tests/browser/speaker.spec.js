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
      window.speaker = new SpeakerOutputNode({ onState: state => {
        status.textContent = state.message; window.speakerState = state;
        if (state.type === 'scheduled') (window.scheduleEvents ||= []).push(state);
      } });
      window.speaker.enable(); window.speaker.start({ signal: window.controller.signal, inputContracts: { audio: window.sourceContract } });
    };
    document.getElementById('Enable').onclick = () => window.speaker.enable();
    document.getElementById('Stop').onclick = async () => { await window.speaker.stop(); window.drained = true; };
    document.getElementById('Cancel').onclick = () => { window.controller.abort(); };
  });
});

test('stream input schedules native-rate chunks incrementally, preserves order across boundaries and drains Stop', async ({ page }) => {
  await page.evaluate(async () => { window.sourceContract = (await import('/audio-stream.js')).AUDIO_STREAM; });
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(() => {
    window.streamEvent = event => window.speaker.receive('audio', event, { signal: window.controller.signal });
    window.streamEvent({ type: 'start', id: 1, sampleRate: 24000, channels: 1 });
    window.streamEvent({ type: 'chunk', id: 1, sequence: 0, samples: new Float32Array(12000).fill(.25) });
  });
  await expect.poll(() => page.evaluate(() => window.speakerEvents.some(event => event.type === 'end'))).toBe(true);
  expect(await page.evaluate(() => window.speaker.active.id)).toBe(1);
  // The first chunk has actually finished while synthesis is still open.
  await page.evaluate(() => {
    window.streamEvent({ type: 'chunk', id: 1, sequence: 1, samples: new Float32Array(2400).fill(.5) });
    window.streamEvent({ type: 'end', id: 1, sequence: 2 });
    window.streamEvent({ type: 'start', id: 2, sampleRate: 48000, channels: 1 });
    window.streamEvent({ type: 'chunk', id: 2, sequence: 0, samples: new Float32Array(4800).fill(.75) });
    window.streamEvent({ type: 'end', id: 2, sequence: 1 });
  });
  await page.getByText('Stop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.drained)).toBe(true);
  const scheduled = await page.evaluate(() => window.scheduleEvents);
  expect(scheduled.map(event => [event.id, event.sequence])).toEqual([[1, 0], [1, 1], [2, 0]]);
  expect(scheduled[1].underruns).toBe(1);
  expect(scheduled[2].audioTime).toBeCloseTo(scheduled[1].audioTime + scheduled[1].duration, 8);
  expect(await page.evaluate(() => window.speakerEvents.filter(event => event.type === 'start').map(event => event.firstSample))).toEqual([.25, .5, .75]);
  expect(await page.evaluate(() => window.speaker.bytes)).toBe(0);
  await page.evaluate(() => window.speaker.dispose());
  expect(await page.evaluate(() => window.speakerContexts.map(context => context.state))).toEqual(['closed']);
});

test('stream playback recovers activation during Stop; Cancel releases scheduled chunks and restart selects clips', async ({ page }) => {
  await page.evaluate(async () => {
    window.sourceContract = (await import('/audio-stream.js')).AUDIO_STREAM;
    window.resumeSpeaker = AudioContext.prototype.resume;
    AudioContext.prototype.resume = () => Promise.reject(new DOMException('Requires activation', 'NotAllowedError'));
  });
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(async () => {
    await window.speaker.audio.suspend();
    const context = { signal: window.controller.signal };
    window.speaker.receive('audio', { type: 'start', id: 1, sampleRate: 24000, channels: 1 }, context);
    window.speaker.receive('audio', { type: 'chunk', id: 1, sequence: 0, samples: new Float32Array(12000).fill(.25) }, context);
    window.speaker.receive('audio', { type: 'end', id: 1, sequence: 1 }, context);
  });
  await expect(page.locator('#speaker-status')).toContainText('Enable speaker');
  await page.getByText('Stop', { exact: true }).click();
  expect(await page.evaluate(() => window.speakerEvents)).toEqual([]);
  await page.evaluate(() => { AudioContext.prototype.resume = window.resumeSpeaker; });
  await page.getByText('Enable speaker', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.speakerEvents.filter(event => event.type === 'start').length)).toBe(1);
  await page.getByText('Cancel', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.drained)).toBe(true);
  expect(await page.evaluate(() => window.speaker.queue.length)).toBe(0);
  await page.evaluate(() => { window.sourceContract = undefined; window.drained = false; });
  await page.getByText('Start', { exact: true }).click();
  await page.evaluate(() => window.accept(.75));
  await page.getByText('Stop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.drained)).toBe(true);
  await page.evaluate(() => window.speaker.dispose());
  expect(await page.evaluate(() => window.speakerContexts.map(context => context.state))).toEqual(['closed', 'closed']);
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
