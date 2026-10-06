import { test, expect } from '@playwright/test';

// Exercise the real page/capture lifecycle without downloading models in CI.
// Real model inference is covered separately by the opt-in smoke test.
async function fakeBackend(page) {
  await page.context().route('**/sherpa-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `
      self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready'});
        if (data.type === 'decode') {
          postMessage({type:data.final ? 'final' : 'partial',text:'日本語のテスト',id:data.id,session:data.session});
          postMessage({type:'decoded',session:data.session});
        }
      };`,
  }));
  await page.context().route('**/silero-worker.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `
      self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready'});
        if (data.type === 'vad-audio') postMessage({type:'vad',frames:[{audio:data.audio,speaking:true}],session:data.session});
        if (data.type === 'vad-stop') postMessage({type:'vad-stopped',session:data.session});
      };`,
  }));
}

async function fakeMicrophone(page, gain = 1) {
  await page.addInitScript((gain) => {
    // Retain the MediaDevices wrapper: WebKit can collect it and lose an
    // instance-level getUserMedia override between captures.
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices });
    window.trackStops = 0;
    mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const source = context.createOscillator(), volume = context.createGain();
      const destination = context.createMediaStreamDestination();
      volume.gain.value = gain;
      source.connect(volume); volume.connect(destination); source.start();
      const stream = destination.stream, tracks = stream.getTracks();
      // Retain the instrumented track wrappers across getTracks calls in WebKit.
      stream.getTracks = () => tracks;
      const track = tracks[0], stop = track.stop.bind(track);
      track.stop = () => {
        window.trackStops++; stop(); source.stop(); void context.close();
      };
      return stream;
    };
  }, gain);
}

test('Pages isolation activates and only the current baseline is exposed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator('select')).toHaveCount(0);
  await expect(page.locator('#description')).toContainText('Japanese ReazonSpeech');
  await expect(page.locator('main')).toContainText('Current development baseline');
  await page.locator('#utterance').fill('今日は東京でテストします。');
  await expect(page.locator('#utterance')).toHaveValue('今日は東京でテストします。');
});

test('microphone denial is visible and leaves retry available', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#errors')).toContainText('Permission denied');
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#stop')).toBeDisabled();
});

test('capture, Stop, repeat, and release on a mobile-sized page', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await fakeBackend(page);
  await fakeMicrophone(page);
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#audio')).not.toHaveText('—');
  await page.locator('#stop').click();
  await expect(page.locator('#final')).toContainText('日本語のテスト');
  await expect(page.locator('#latency')).not.toHaveText('—');
  expect(await page.evaluate(() => window.trackStops)).toBe(1);
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#audio')).not.toHaveText('—');
  await expect(page.locator('#errors')).toBeEmpty();
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => window.trackStops)).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

test('canceling pending microphone permission releases a late-granted track', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => {
      window.grant = () => resolve({ getTracks: () => [{ stop: () => { window.lateTrackStopped = true; } }] });
    });
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Requesting');
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await page.evaluate(() => window.grant());
  await expect.poll(() => page.evaluate(() => window.lateTrackStopped)).toBe(true);
  await expect(page.locator('#status')).toContainText('Canceled');
});

test('Stop then Cancel/reload discards the old capture flush and Stop', async ({ page }) => {
  await fakeBackend(page);
  await fakeMicrophone(page);
  await page.addInitScript(() => {
    // Hold actual worklet replies until the replacement worker is ready or recording.
    // Extend the flush fallback so UI/test scheduling cannot win the race.
    const timeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => timeout(callback, delay === 500 ? 10000 : delay, ...args);
    const Worklet = window.AudioWorkletNode;
    const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    window.AudioWorkletNode = class extends Worklet {
      constructor(...args) {
        super(...args);
        const port = this.port, post = port.postMessage.bind(port), events = [];
        let holding = false, handler;
        onmessage.set.call(port, (event) => {
          if (holding) events.push(event);
          else handler?.(event);
        });
        Object.defineProperty(port, 'onmessage', { get: () => handler, set: (value) => { handler = value; } });
        port.postMessage = (message) => {
          if (message === 'flush') {
            holding = true;
            window.flushReady = () => events.some((event) => event.data === 'flushed')
              && events.some((event) => event.data instanceof Float32Array);
            window.finishFlush = () => {
              holding = false; window.releasingOldFlush = true;
              for (const event of events.splice(0)) handler?.(event);
              window.releasingOldFlush = false;
            };
          }
          post(message);
        };
      }
    };
    const Worker = window.Worker;
    window.workerMessages = []; window.workerCount = 0;
    window.Worker = class extends Worker {
      constructor(...args) { super(...args); this.testId = ++window.workerCount; }
      postMessage(message, ...args) {
        window.workerMessages.push({ id: this.testId, type: message.type, oldFlush: !!window.releasingOldFlush });
        super.postMessage(message, ...args);
      }
    };
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#audio')).not.toHaveText('—');
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => window.flushReady?.())).toBe(true);
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await expect(page.locator('#status')).toContainText('Ready');
  await page.locator('#start').click();
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#audio')).not.toHaveText('—');
  await expect(page.locator('#errors')).toBeEmpty();
  await page.evaluate(() => window.finishFlush());
  await expect.poll(() => page.evaluate(() => window.trackStops)).toBe(1);
  expect(await page.evaluate(() => window.workerMessages.filter((message) => message.oldFlush))).toEqual([]);
  expect(await page.evaluate(() => window.workerMessages.filter((message) => message.id <= 2 && message.type === 'vad-stop'))).toEqual([]);
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => window.flushReady?.())).toBe(true);
  await page.evaluate(() => window.finishFlush());
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toContainText('日本語のテスト');
  expect(await page.evaluate(() => window.trackStops)).toBe(2);
});
