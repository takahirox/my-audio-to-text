import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setup(page, { hold = false, realWorker = false } = {}) {
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
          length: message.audio.length, first: message.audio[0], last: message.audio.at(-1),
        } : undefined });
        super.postMessage(message, ...args);
      }
      terminate() { window.terminated.push(this.id); super.terminate(); }
    };
  });
  const controlledWorker = `let pending;
    const finish = () => {
      const {audio, final, session} = pending; pending = null;
      postMessage({type:final ? 'final' : 'partial', text:'日本語' + audio.length, session});
      postMessage({type:'decoded', session});
    };
    self.onmessage = ({data}) => {
      if (data.type === 'load') postMessage({type:'ready'});
      if (data.type === 'decode') {
        if (pending) throw new Error('Overlapping decode');
        pending = data; if (!${hold}) finish();
      }
      if (data.type === 'test-finish') finish();
    };`;
  // Keep the real worker's message/recognition/segmentation paths, replacing only
  // heavyweight WASM initialization. Works in WebKit without importScripts routes.
  const actualWorker = readFileSync(new URL('../../web/sherpa-worker.js', import.meta.url), 'utf8') + `
    load = async () => {
      recognizer = {
        createStream() { return {
          acceptWaveform(rate, audio) { this.audio = audio; postMessage({type:'test-rate', rate, length:audio.length}); },
          free() { postMessage({type:'test-freed'}); },
        }; },
        decode(stream) { if (stream.audio[0] === -1) throw new Error('Controlled decode failure'); },
        getResult(stream) { return {text:stream.audio[0] === 0 ? '' : ' 日本語' + stream.audio.length + ' '}; },
      };
    };`;
  await page.context().route('**/sherpa-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: realWorker ? actualWorker : controlledWorker,
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

test('distinct ReazonSpeech options; cumulative provisional text before Stop and final worklet tail', async ({ page }) => {
  await setup(page, { realWorker: true });
  await expect(page.locator('#backend option[value=sherpa]')).toHaveText('sherpa-onnx — Japanese ReazonSpeech');
  await expect(page.locator('#backend option[value=sherpa-simulated]')).toContainText('(simulated streaming)');
  await expect(page.locator('#description')).toContainText('not native streaming');
  await expect(page.locator('#description')).toContainText('1 second');
  await expect(page.locator('#moonshine-options')).toBeHidden();
  await page.locator('#start').click();
  await feed(page, 15999); expect(await decodes(page)).toHaveLength(0);
  await feed(page, 1); await expect(page.locator('#partial')).toHaveText('日本語16000');
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#stop')).toBeEnabled();
  await expect(page.locator('#first-partial')).not.toHaveText('—');
  await feed(page, 16000); await expect(page.locator('#partial')).toHaveText('日本語32000');
  await page.evaluate(() => { window.flushSamples = 37; });
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('日本語32037\n');
  await expect(page.locator('#partial')).toBeEmpty();
  await expect(page.locator('#audio')).toHaveText('2.0 s / 0.0 s');
  expect((await decodes(page)).map(m => [m.audio.length, m.final])).toEqual([[16000, false], [32000, false], [32037, true]]);
  expect(await page.evaluate(() => window.captureStops)).toBe(1);
  expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-rate').map(e => e.rate))).toEqual([16000, 16000, 16000]);
  expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-freed').length)).toBe(3);
  await page.evaluate(() => { window.flushSamples = 0; });
  await page.locator('#start').click();
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#partial')).toHaveText('Waiting for speech…');
  await feed(page, 16000); await expect(page.locator('#partial')).toHaveText('日本語16000');
  await page.locator('#stop').click(); await expect(page.locator('#final')).toHaveText('日本語16000\n');
});

test('committed windows clear their preview and the next window replaces provisional text', async ({ page }) => {
  await setup(page, { realWorker: true }); await page.locator('#start').click();
  await feed(page, 16000); await expect(page.locator('#partial')).toHaveText('日本語16000');
  await feed(page, 9 * 16000);
  await expect(page.locator('#final')).toHaveText('日本語160000\n');
  await expect(page.locator('#partial')).toBeEmpty();
  await feed(page, 16000); await expect(page.locator('#partial')).toHaveText('日本語16000');
  await feed(page, 16000); await expect(page.locator('#partial')).toHaveText('日本語32000');
  await expect(page.locator('#final')).toHaveText('日本語160000\n');
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#partial')).toBeEmpty();
  await expect(page.locator('#final')).toHaveText('日本語160000\n日本語32000\n');
});

test('slow inference coalesces previews, commits disjoint windows and drains Stop', async ({ page }) => {
  await setup(page, { hold: true }); await page.locator('#start').click();
  await feed(page, 16000);
  await expect.poll(async () => (await decodes(page)).length).toBe(1);
  for (let i = 0; i < 8; i++) await feed(page, 16000);
  expect(await decodes(page)).toHaveLength(1);
  await finish(page);
  await expect.poll(async () => (await decodes(page)).length).toBe(2);
  expect((await decodes(page))[1].audio.length).toBe(9 * 16000);
  await feed(page, 16000); await feed(page, 16000, 0.01);
  expect(await decodes(page)).toHaveLength(2);
  await page.locator('#stop').click();
  await expect(page.locator('#start')).toBeDisabled();
  await finish(page);
  await expect.poll(async () => (await decodes(page)).length).toBe(3);
  expect((await decodes(page))[2].final).toBe(true);
  await finish(page);
  await expect(page.locator('#final')).toHaveText('日本語160000\n');
  await expect(page.locator('#partial')).toBeEmpty();
  await expect.poll(async () => (await decodes(page)).length).toBe(4);
  expect((await decodes(page))[3].audio.first).toBeCloseTo(0.01);
  await finish(page); await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('日本語160000\n日本語16000\n');
  await expect(page.locator('#audio')).toHaveText('11.0 s / 0.0 s');
  expect((await decodes(page)).map(m => [m.audio.length, m.final])).toEqual([
    [16000, false], [144000, false], [160000, true], [16000, true],
  ]);
});

test('buffer limit fails visibly and terminates a stalled decode', async ({ page }) => {
  await setup(page, { hold: true }); await page.locator('#start').click();
  await feed(page, 16000);
  for (let i = 0; i < 29; i++) await feed(page, 16000);
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
    await setup(page, { hold: true }); await page.locator('#start').click(); await feed(page, 16000);
    await expect.poll(async () => (await decodes(page)).length).toBe(1);
    if (stopping) await page.locator('#stop').click();
    await page.evaluate(() => { window.oldCallback = window.testWorkers[0].onmessage; });
    await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
    await expect(page.locator('#final')).toBeEmpty();
    await page.locator('#load').click(); await page.locator('#start').click(); await feed(page, 16000);
    const session = (await decodes(page))[1].session;
    await page.evaluate((session) => {
      for (const type of ['partial', 'final', 'decoded', 'stopped', 'error']) {
        window.oldCallback({data:{type, text:'古い結果', message:'Old error', session}});
        window.testWorkers[1].onmessage({data:{type, text:'古い結果', message:'Old error', session:session - 1}});
      }
    }, session);
    await expect(page.locator('#final')).toBeEmpty();
    await expect(page.locator('#errors')).toBeEmpty();
    await expect(page.locator('#status')).toContainText('Listening');
    await finish(page); await expect(page.locator('#partial')).toHaveText('日本語16000');
    await page.locator('#stop').click(); await finish(page);
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('#final')).toHaveText('日本語16000\n');
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
  await setup(page, { realWorker: true }); await page.locator('#start').click();
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  expect(await decodes(page)).toHaveLength(0);
  await page.locator('#start').click(); await feed(page, 16000, 0);
  await expect.poll(async () => (await decodes(page)).length).toBe(1);
  await expect(page.locator('#partial')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#start').click(); await feed(page, 16000, -1);
  await expect(page.locator('#errors')).toContainText('Controlled decode failure');
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => window.terminated)).toEqual([0]);
});

test('offline ReazonSpeech keeps pause/20-second segmentation and no previews', async ({ page }) => {
  await setup(page, { realWorker: true });
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
