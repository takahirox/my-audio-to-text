import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

async function setup(page, { hold = false, holdReady = null } = {}) {
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.testWorkers = []; window.requests = []; window.terminated = []; window.workerEvents = [];
    window.Worker = class extends Worker {
      constructor(...args) {
        super(...args); this.url = args[0]; this.id = window.testWorkers.length; window.testWorkers.push(this);
        this.addEventListener('message', ({data}) => window.workerEvents.push({ ...data, workerId: this.id }));
      }
      postMessage(message, ...args) {
        window.requests.push({ ...message, workerId: this.id, audio: message.audio ? {
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
    const originalHandle = handle;
    let unblock;
    handle = async (data) => {
      if (data.type === 'decode' && ${hold}) {
        postMessage({type:'test-decode-held'});
        await new Promise(resolve => { unblock = resolve; });
        unblock = null;
      }
      if (data.type === 'test-asr-ping') postMessage({type:'test-asr-pong'});
      else await originalHandle(data);
    };
    const originalOnmessage = self.onmessage;
    self.onmessage = event => {
      // Only this test control bypasses the serialized production message path.
      if (event.data.type === 'test-finish') unblock();
      else originalOnmessage(event);
    };`;
  const actualVadWorker = readFileSync(new URL('../../web/silero-worker.js', import.meta.url), 'utf8') + `
    self.importScripts = () => self.Module.onRuntimeInitialized();
    self.createVad = (module, config) => {
      postMessage({type:'test-vad-config', config});
      return { handle:1,
        reset() { postMessage({type:'test-vad-reset'}); },
        acceptWaveform(frame) { this.speech = frame.some(sample => sample !== 0); },
        isDetected() { return this.speech; }, flush() {}, clear() {},
      };
    };`;
  const gateReady = (body, role) => body + `
    if (${JSON.stringify(holdReady)} === ${JSON.stringify(role)}) {
      const originalPost = self.postMessage.bind(self), originalReceive = self.onmessage;
      let ready;
      self.postMessage = (message, ...args) => {
        if (message.type === 'ready') { ready = message; originalPost({type:'test-ready-held'}); }
        else originalPost(message, ...args);
      };
      self.onmessage = event => {
        if (event.data.type === 'test-ready') originalPost(ready);
        else originalReceive(event);
      };
    }`;
  await page.context().route('**/silero-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: gateReady(actualVadWorker, 'vad'),
  }));
  await page.context().route('**/sherpa-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: gateReady(actualWorker, 'asr'),
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
  await page.locator('#load').click();
  if (holdReady) await expect.poll(() => page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-ready-held').length)).toBe(1);
  else await expect(page.locator('#start')).toBeEnabled();
}

const feed = (page, length, value = 0.05) => page.evaluate(({ length, value }) => window.feed(length, value), { length, value });
const decodes = page => page.evaluate(() => window.requests.filter(m => m.type === 'decode'));
const finish = async page => {
  // Wait for the decode to enter the actual worker handler, not just be posted.
  await expect.poll(() => page.evaluate(() => {
    const id = window.testWorkers.filter(w => w.url === './sherpa-worker.js').at(-1).id;
    const events = window.workerEvents.filter(e => e.workerId === id);
    return events.filter(e => e.type === 'test-decode-held').length - events.filter(e => e.type === 'test-freed').length;
  })).toBe(1);
  await page.evaluate(() => window.testWorkers.filter(w => w.url === './sherpa-worker.js').at(-1).postMessage({ type: 'test-finish' }));
};
const classified = page => page.evaluate(() => window.workerEvents.filter(e => e.type === 'vad')
  .reduce((sum, e) => sum + e.frames.reduce((count, f) => count + f.audio.length, 0), 0));

test.describe('Japanese ReazonSpeech baseline', () => {
    for (const role of ['asr', 'vad']) {
      test(`simulated recording waits for the ${role} worker to become ready`, async ({ page }) => {
        await setup(page, { holdReady: role });
        await expect.poll(() => page.evaluate(() => window.workerEvents.filter(e => e.type === 'ready').length)).toBe(1);
        await expect(page.locator('#start')).toBeDisabled();
        await expect(page.locator('#status')).toContainText('Loading');
        await page.evaluate(role => window.testWorkers[role === 'asr' ? 0 : 1].postMessage({type:'test-ready'}), role);
        await expect(page.locator('#start')).toBeEnabled();
      });
    }

    test('VAD errors and page teardown release both workers and capture', async ({ page }) => {
      await setup(page); await page.locator('#start').click();
      await page.evaluate(() => window.testWorkers[1].onerror({preventDefault() {}, message:'Controlled VAD failure'}));
      await expect(page.locator('#errors')).toContainText('Controlled VAD failure');
      await expect(page.locator('#load')).toBeEnabled();
      expect(await page.evaluate(() => window.terminated)).toEqual([0, 1]);
      expect(await page.evaluate(() => window.captureStops)).toBe(1);
      await page.locator('#load').click(); await page.locator('#start').click(); await feed(page, 8192);
      await expect(page.locator('#partial')).toHaveText('日本語8192');
      await page.evaluate(() => {
        const callbacks = window.testWorkers.slice(-2).map(w => w.onmessage);
        window.dispatchEvent(new Event('pagehide'));
        for (const callback of callbacks) callback({data:{type:'final',text:'古い結果'}});
      });
      expect(await page.evaluate(() => window.terminated)).toEqual([0, 1, 2, 3]);
      expect(await page.evaluate(() => window.captureStops)).toBe(2);
      await expect(page.locator('#final')).toBeEmpty();
    });

    test('half-second provisional text, final worklet tail and repeat use the real worker paths', async ({ page }) => {
      await setup(page);
      await expect(page.locator('select')).toHaveCount(0);
      await expect(page.locator('#description')).toContainText('not native streaming');
      await expect(page.locator('#description')).toContainText('Silero');
      await expect(page.locator('#partial-heading')).toContainText('unstable');
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
      expect(await page.evaluate(() => window.workerEvents.find(e => e.type === 'test-vad-config').config)).toEqual({
        sileroVad: {model:'./silero_vad.onnx', threshold:0.5, windowSize:512,
          minSpeechDuration:1 / 16000, minSilenceDuration:1 / 16000, maxSpeechDuration:12},
        sampleRate:16000, numThreads:1, provider:'cpu', debug:0, bufferSizeInSeconds:2,
      });
      await page.evaluate(() => { window.flushSamples = 0; });
      await page.locator('#start').click();
      await expect(page.locator('#final')).toBeEmpty();
      await expect(page.locator('#partial')).toHaveText('Waiting for speech…');
      await feed(page, 8192); await expect(page.locator('#partial')).toHaveText('日本語8192');
      await page.locator('#stop').click(); await expect(page.locator('#final')).toHaveText('日本語8192\n');
      expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-vad-reset').length)).toBe(4);
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

    test('VAD classifies during a blocked ASR decode, coalesces previews and retains endpoints for Stop', async ({ page }) => {
      await setup(page, { hold: true }); await page.locator('#start').click();
      await feed(page, 8192);
      await expect.poll(() => page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-decode-held').length)).toBe(1);
      await page.evaluate(() => window.testWorkers[0].postMessage({type:'test-asr-ping'}));
      for (let i = 0; i < 8; i++) await feed(page, 8192);
      await expect.poll(() => classified(page)).toBe(9 * 8192);
      expect(await decodes(page)).toHaveLength(1);
      expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-asr-pong'))).toHaveLength(0);
      expect(await page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-freed'))).toHaveLength(0);
      expect(await page.evaluate(() => window.requests.filter(m => m.type === 'vad-audio').every(m => m.workerId === 1))).toBe(true);
      expect((await decodes(page))[0].workerId).toBe(0);
      await finish(page);
      await expect.poll(() => page.evaluate(() => window.workerEvents.filter(e => e.type === 'test-asr-pong').length)).toBe(1);
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
      expect(await page.evaluate(() => window.terminated)).toEqual([0, 1]);
      expect(await page.evaluate(() => window.captureStops)).toBe(1);
    });

    for (const stopping of [false, true]) {
      test(`Cancel ${stopping ? 'during Stop' : 'during recording'}, reload and repeat reject stale results`, async ({ page }) => {
        await setup(page, { hold: true }); await page.locator('#start').click(); await feed(page, 8192);
        await expect.poll(async () => (await decodes(page)).length).toBe(1);
        if (stopping) await page.locator('#stop').click();
        await page.evaluate(() => { window.oldCallbacks = window.testWorkers.map(w => w.onmessage); });
        await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
        await expect(page.locator('#final')).toBeEmpty();
        await page.locator('#load').click(); await page.locator('#start').click(); await feed(page, 8192);
        await expect.poll(async () => (await decodes(page)).length).toBe(2);
        const session = (await decodes(page))[1].session;
        await page.evaluate((session) => {
          for (const type of ['partial', 'final', 'decoded', 'stopped', 'error', 'vad', 'vad-stopped']) {
            for (const callback of window.oldCallbacks) callback({data:{type, text:'古い結果', message:'Old error', session}});
            for (const worker of window.testWorkers.slice(-2)) worker.onmessage({data:{type, text:'古い結果', message:'Old error', session:session - 1}});
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
          for (const worker of window.testWorkers.slice(-2)) {
            for (const type of ['final', 'decoded', 'vad', 'vad-stopped', 'error']) {
              worker.onmessage({data:{type, text:'古い結果', message:'Old error', session}});
            }
          }
        }, session);
        await expect(page.locator('#final')).toBeEmpty();
        await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
        await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
        await page.evaluate(() => { window.oldCallbacks = window.testWorkers.slice(-2).map(w => w.onmessage); });
        await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
        await page.evaluate(() => window.oldCallbacks.forEach(callback => callback({data:{type:'final',text:'古い結果'}})));
        await expect(page.locator('#partial')).toHaveText('Waiting for speech…');
        await expect(page.locator('#final')).toBeEmpty();
        expect(await page.evaluate(() => window.terminated)).toEqual([0, 1, 2, 3, 4, 5]);
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
      await expect(page.locator('#signal')).toContainText('Nonzero microphone signal');
      await expect(page.locator('#speech')).toContainText('1 Silero VAD utterance(s) accepted; 1 completed');
      await expect(page.locator('#asr-events')).toHaveText('0 nonempty partial(s); 0 nonempty final(s).');
      await page.locator('#start').click(); await feed(page, 8192, -1);
      await expect(page.locator('#errors')).toContainText('Controlled decode failure');
      await expect(page.locator('#load')).toBeEnabled();
      expect(await page.evaluate(() => window.terminated)).toEqual([0, 1]);
    });

});
