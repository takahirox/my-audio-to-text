import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setup(page, { hold = false } = {}) {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.testWorkers = []; window.requests = []; window.terminated = []; window.workerEvents = [];
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args); this.id = window.testWorkers.length; window.testWorkers.push(this);
        this.addEventListener('message', ({data}) => window.workerEvents.push(data));
      }
      postMessage(message, ...args) {
        window.requests.push({ ...message, id: this.id, audio: message.audio ? {
          length: message.audio.length, first: message.audio[0], last: message.audio.at(-1), samples: message.final ? Array.from(message.audio) : undefined,
        } : undefined });
        super.postMessage(message, ...args);
      }
      terminate() { window.terminated.push(this.id); super.terminate(); }
    };
  });
  // Exercise the actual message, VAD framing, recognition and cleanup paths.
  // Replace only heavyweight initialization and optionally hold decode requests.
  const actualWorker = readFileSync(new URL('../../web/sherpa-worker.js', import.meta.url), 'utf8') + `
    load = async () => {
      recognizer = {
        createStream() { return {
          acceptWaveform(rate, audio) { this.audio = audio; postMessage({type:'test-rate', rate, length:audio.length}); },
          free() { postMessage({type:'test-freed'}); },
        }; },
        decode(stream) { if (stream.audio[0] === -1) throw new Error('Controlled decode failure'); },
        getResult(stream) { return {text:stream.audio.every(sample => Math.abs(sample) < 0.03) ? '' : ' 日本語' + stream.audio.length + ' '}; },
      };
    };
    self.createVad = (module, config) => {
      postMessage({type:'test-vad-config', config});
      return { handle:1,
        reset() { postMessage({type:'test-vad-reset'}); },
        acceptWaveform(frame) { this.speech = frame.some(sample => sample !== 0); },
        isDetected() { return this.speech; }, flush() {}, clear() {},
      };
    };
    const originalHandle = handle;
    let pending;
    handle = async (data) => {
      if (data.type === 'decode' && ${hold}) {
        if (pending) throw new Error('Overlapping decode');
        pending = data;
      } else if (data.type === 'test-finish') {
        const request = pending; pending = null; await originalHandle(request);
      } else await originalHandle(data);
    };`;
  await page.context().route('**/sherpa-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: actualWorker,
  }));
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  // Deterministic 16 kHz audio at the microphone callback boundary. Existing
  // playground tests separately exercise real Web Audio capture and resampling.
  await page.evaluate(async () => {
    const { Microphone } = await import('./audio.js');
    window.captureStops = 0;
    Microphone.prototype.start = async function () {
      window.feed = (length, value = 0.05) => this.onAudio(new Float32Array(length).fill(value));
    };
    Microphone.prototype.stop = async function () {
      window.captureStops++;
      if (window.flushSamples) this.onAudio(new Float32Array(window.flushSamples).fill(0.01));
    };
  });
  await page.locator('#backend').selectOption('sherpa-simulated');
  await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
}

const feed = (page, length, value = 0.05) => page.evaluate(({ length, value }) => window.feed(length, value), { length, value });
const decodes = page => page.evaluate(() => window.requests.filter(m => m.type === 'decode'));
const finish = page => page.evaluate(() => window.testWorkers.at(-1).postMessage({ type: 'test-finish' }));

test('half-second provisional text, final worklet tail and repeat use the real worker paths', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#backend option[value=sherpa]')).toHaveText('sherpa-onnx — Japanese ReazonSpeech');
  await expect(page.locator('#description')).toContainText('not native streaming');
  await expect(page.locator('#description')).toContainText('Silero');
  await expect(page.locator('#partial-heading')).toContainText('unstable');
  await expect(page.locator('#moonshine-options')).toBeHidden();
  await page.locator('#start').click();
  await feed(page, 8191); expect(await decodes(page)).toHaveLength(0);
  await feed(page, 1); await expect(page.locator('#partial')).toHaveText('日本語8192');
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#stop')).toBeEnabled();
  await expect(page.locator('#first-partial')).not.toHaveText('—');
  await feed(page, 8192); await expect(page.locator('#partial')).toHaveText('日本語16384');
  await page.evaluate(() => { window.flushSamples = 37; });
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('日本語16421\n');
  await expect(page.locator('#partial')).toBeEmpty();
  await expect(page.locator('#audio')).toHaveText('1.0 s / 0.0 s');
  expect((await decodes(page)).map(m => [m.audio.length, m.final])).toEqual([[8192, false], [16384, false], [16421, true]]);
  expect(await page.evaluate(() => window.captureStops)).toBe(1);
  expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-rate').map(e => e.rate))).toEqual([16000, 16000, 16000]);
  expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-freed').length)).toBe(3);
  expect(await page.evaluate(() => window.workerEvents.find(e => e.type === 'test-vad-config').config.sileroVad.model)).toBe('./silero_vad.onnx');
  await page.evaluate(() => { window.flushSamples = 0; });
  await page.locator('#start').click();
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#partial')).toHaveText('Waiting for speech…');
  await feed(page, 8192); await expect(page.locator('#partial')).toHaveText('日本語8192');
  await page.locator('#stop').click(); await expect(page.locator('#final')).toHaveText('日本語8192\n');
  expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-vad-reset').length)).toBe(2);
});

test('silence stays bounded, speech includes 0.8-second pre-roll and a 0.35-second endpoint', async ({ page }) => {
  await setup(page); await page.locator('#start').click();
  await feed(page, 3 * 16000, 0);
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  expect(await decodes(page)).toHaveLength(0); await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#start').click();
  await feed(page, 12800, 0); await feed(page, 8192);
  await expect(page.locator('#partial')).toHaveText('日本語20992');
  await feed(page, 5120, 0); await expect(page.locator('#final')).toBeEmpty();
  await feed(page, 512, 0); await expect(page.locator('#final')).toHaveText('日本語26592\n');
  await expect(page.locator('#partial')).toBeEmpty();
  const final = (await decodes(page)).find(m => m.final);
  expect(final.audio.samples.slice(0, 12800).every(sample => sample === 0)).toBe(true);
  expect(final.audio.samples.slice(12800, 20992).every(sample => Math.abs(sample - 0.05) < 1e-6)).toBe(true);
  expect(final.audio.samples.slice(20992).every(sample => sample === 0)).toBe(true);
  await expect(page.locator('#speech')).toContainText('1 Silero VAD utterance(s) accepted; 1 completed');
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  expect((await decodes(page)).filter(m => m.final)).toHaveLength(1);
});

test('continuous speech forces 12-second finals without losing or repeating boundary audio', async ({ page }) => {
  await setup(page); await page.locator('#start').click();
  await feed(page, 12800, 0);
  await feed(page, 12 * 16000, 0.05);
  await expect(page.locator('#final')).toHaveText('日本語204800\n');
  await feed(page, 12 * 16000, 0.06);
  await expect(page.locator('#final')).toHaveText('日本語204800\n日本語192000\n');
  await feed(page, 37, 0.07); await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Stopped');
  const finals = (await decodes(page)).filter(m => m.final);
  expect(finals.map(m => m.audio.length)).toEqual([204800, 192000, 37]);
  expect(finals[0].audio.samples.slice(0,12800).every(sample => sample === 0)).toBe(true);
  for (const [index, value] of [[0, 0.05], [1, 0.06], [2, 0.07]]) {
    const speech = finals[index].audio.samples.slice(index === 0 ? 12800 : 0);
    expect(speech.every(sample => Math.abs(sample - value) < 1e-6)).toBe(true);
  }
});

test('slow inference coalesces previews, ignores ended previews and drains utterances on Stop', async ({ page }) => {
  await setup(page, { hold: true }); await page.locator('#start').click();
  await feed(page, 8192);
  await expect.poll(async () => (await decodes(page)).length).toBe(1);
  for (let i = 0; i < 8; i++) await feed(page, 8192);
  expect(await decodes(page)).toHaveLength(1);
  await finish(page);
  await expect.poll(async () => (await decodes(page)).length).toBe(2);
  expect((await decodes(page))[1].audio.length).toBe(9 * 8192);
  await feed(page, 5632, 0); await feed(page, 8192, 0.06);
  // Ensure VAD has observed the endpoint before releasing its stale preview.
  await expect(page.locator('#speech')).toContainText('2 Silero VAD utterance(s) accepted; 1 completed');
  await finish(page);
  await expect.poll(async () => (await decodes(page)).length).toBe(3);
  await expect(page.locator('#partial')).toHaveText('日本語8192');
  expect((await decodes(page))[2].final).toBe(true);
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeDisabled();
  await finish(page);
  await expect(page.locator('#final')).toHaveText('日本語79328\n');
  await expect.poll(async () => (await decodes(page)).length).toBe(4);
  expect((await decodes(page))[3].final).toBe(true);
  await finish(page); await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('日本語79328\n日本語8224\n');
  await expect(page.locator('#partial')).toBeEmpty();
});

test('buffer limit fails visibly and terminates a stalled decode', async ({ page }) => {
  await setup(page, { hold: true }); await page.locator('#start').click();
  await feed(page, 8192);
  for (let i = 0; i < 29; i++) await feed(page, 16000);
  await feed(page, 7808);
  expect(await decodes(page)).toHaveLength(1);
  await expect(page.locator('#errors')).toBeEmpty();
  await feed(page, 1);
  await expect(page.locator('#errors')).toContainText('over 30 seconds behind');
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => window.terminated)).toEqual([0]);
  expect(await page.evaluate(() => window.captureStops)).toBe(1);
});

for (const stopping of [false, true]) {
  test(`Cancel ${stopping ? 'during Stop' : 'during recording'}, reload and backend switching reject stale results`, async ({ page }) => {
    await setup(page, { hold: true }); await page.locator('#start').click(); await feed(page, 8192);
    await expect.poll(async () => (await decodes(page)).length).toBe(1);
    if (stopping) await page.locator('#stop').click();
    await page.evaluate(() => { window.oldCallback = window.testWorkers[0].onmessage; });
    await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
    await expect(page.locator('#final')).toBeEmpty();
    await page.locator('#load').click(); await page.locator('#start').click(); await feed(page, 8192);
    await expect.poll(async () => (await decodes(page)).length).toBe(2);
    const session = (await decodes(page))[1].session;
    await page.evaluate((session) => {
      for (const type of ['partial', 'final', 'decoded', 'stopped', 'error', 'vad', 'vad-stopped']) {
        window.oldCallback({data:{type, text:'古い結果', message:'Old error', session}});
        window.testWorkers[1].onmessage({data:{type, text:'古い結果', message:'Old error', session:session - 1}});
      }
    }, session);
    await expect(page.locator('#final')).toBeEmpty();
    await expect(page.locator('#errors')).toBeEmpty();
    await expect(page.locator('#status')).toContainText('Listening');
    await finish(page); await expect(page.locator('#partial')).toHaveText('日本語8192');
    await page.locator('#stop').click();
    await expect.poll(async () => (await decodes(page)).length).toBe(3);
    await finish(page);
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('#final')).toHaveText('日本語8192\n');
    await page.locator('#start').click();
    await page.evaluate((session) => {
      window.testWorkers[1].onmessage({data:{type:'final',text:'古い結果',session}});
    }, session);
    await expect(page.locator('#final')).toBeEmpty();
    await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
    await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
    await page.evaluate(() => { window.oldCallback = window.testWorkers.at(-1).onmessage; });
    await page.locator('#backend').selectOption('sherpa'); await expect(page.locator('#load')).toBeEnabled();
    await page.evaluate(() => window.oldCallback({data:{type:'final',text:'古い結果'}}));
    await expect(page.locator('#partial')).toContainText('Unsupported');
    await expect(page.locator('#final')).toBeEmpty();
    expect(await page.evaluate(() => window.terminated)).toEqual([0, 1, 2]);
  });
}

test('empty Stop, empty recognition and decode errors release correctly', async ({ page }) => {
  await setup(page); await page.locator('#start').click();
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  expect(await decodes(page)).toHaveLength(0);
  await page.locator('#start').click(); await feed(page, 8192, 0.01);
  await expect.poll(async () => (await decodes(page)).length).toBe(1);
  await expect(page.locator('#partial')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#start').click(); await feed(page, 8192, -1);
  await expect(page.locator('#errors')).toContainText('Controlled decode failure');
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => window.terminated)).toEqual([0]);
});

test('offline ReazonSpeech keeps pause/20-second segmentation and no previews', async ({ page }) => {
  await setup(page);
  await page.locator('#backend').selectOption('sherpa'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await feed(page, 16000);
  await expect(page.locator('#final')).toBeEmpty(); await expect(page.locator('#partial')).toContainText('Unsupported');
  await feed(page, 12800, 0); await expect(page.locator('#final')).toHaveText('日本語28800\n');
  await feed(page, 320000); await expect(page.locator('#final')).toHaveText('日本語28800\n日本語320000\n');
  await feed(page, 123); await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('日本語28800\n日本語320000\n日本語123\n');
  expect(await decodes(page)).toHaveLength(0);
});
