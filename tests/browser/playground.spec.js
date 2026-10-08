import { test, expect } from '@playwright/test';
import { observePipeline, graphTypes } from './pipeline-observer.js';

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
    window.trackStops = 0; window.microphoneRequests = [];
    mediaDevices.getUserMedia = async () => {
      window.microphoneRequests.push({ active: navigator.userActivation.isActive });
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
  await page.goto('./');
  await expect(page).toHaveTitle('Node Playground');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Node Playground');
  await expect(page.locator('select, button, script')).toHaveCount(0);
  await page.getByRole('link', { name: 'Speech-to-Text (ReazonSpeech ja-en)', exact: true }).click();
  await expect(page).toHaveURL(/\/nodes\/speech-to-text\/$/);
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await expect(page.locator('select:not(#source)')).toHaveCount(0);
  await expect(page.locator('#description')).toContainText('ReazonSpeech ja-en');
  for (const id of ['partial', 'final']) await expect(page.locator(`#${id}`)).toHaveAttribute('lang', '');
  await expect(page.locator('main')).toContainText('Current development baseline');
  await page.locator('#utterance').fill('今日は東京でテストします。');
  await expect(page.locator('#utterance')).toHaveValue('今日は東京でテストします。');
  await page.getByRole('link', { name: 'Node Playground', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Node Playground');
});

test('Pages repository prefix preserves navigation, isolation, assets and the production pipeline', async ({ page }) => {
  test.skip(!!process.env.ASR_BASE_URL || !!process.env.ASR_BENCHMARK, 'Repository-prefix alias is provided by the local test server.');
  await fakeBackend(page);
  await fakeMicrophone(page);
  await page.addInitScript(() => {
    const NativeContext = window.AudioContext, NativeWorker = window.Worker;
    window.workletURLs = []; window.workerURLs = [];
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args);
        const addModule = this.audioWorklet.addModule.bind(this.audioWorklet);
        this.audioWorklet.addModule = url => {
          window.workletURLs.push(url);
          return addModule(url);
        };
      }
    };
    window.Worker = class extends NativeWorker {
      constructor(url, ...args) { super(url, ...args); window.workerURLs.push(url); }
    };
  });
  const failures = [], assets = new Set();
  page.on('pageerror', error => failures.push(error.message));
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    assets.add(path);
    if (response.status() >= 400) failures.push(`${response.status()} ${path}`);
  });
  await page.goto('./my-audio-to-text/');
  await page.getByRole('link', { name: 'Speech-to-Text (ReazonSpeech ja-en)', exact: true }).click();
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page).toHaveURL(/\/my-audio-to-text\/nodes\/speech-to-text\/$/);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope))
    .toBe(new URL('/my-audio-to-text/', page.url()).href);
  await observePipeline(page);
  await page.locator('#load').click();
  await page.locator('#start').click();
  await expect(page.locator('#partial')).toContainText('日本語のテスト');
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toContainText('日本語のテスト');
  expect(await graphTypes(page)).toEqual(['MicrophoneAudioNode', 'SpeechToTextNode', 'TranscriptOutputNode']);
  for (const name of ['style.css', 'pipeline.js', 'transcription-nodes.js', 'local-asr-core.js', 'audio.js']) {
    expect(assets.has(`/my-audio-to-text/${name}`), name).toBe(true);
  }
  expect(await page.evaluate(() => window.workletURLs)).toEqual([
    new URL('/my-audio-to-text/capture-worklet.js', page.url()).href,
  ]);
  expect(await page.evaluate(() => window.workerURLs)).toEqual([
    new URL('/my-audio-to-text/sherpa-worker.js', page.url()).href,
    new URL('/my-audio-to-text/silero-worker.js', page.url()).href,
  ]);
  expect((await page.request.get(new URL('../../capture-worklet.js', page.url()).href)).status()).toBe(200);
  expect(await page.evaluate(() => window.trackStops)).toBe(1);
  await page.locator('#cancel').click();
  await page.getByRole('link', { name: 'Runtime and model notices' }).click();
  await expect(page).toHaveURL(/\/my-audio-to-text\/third-party-notices\.txt$/);
  expect(failures).toEqual([]);
});

test('microphone denial is visible and leaves retry available', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
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
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
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
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
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
  // A real worklet can have no buffered tail at Stop. This lifecycle fixture
  // always replies with PCM before the acknowledgment so both stale replies
  // are exercised, independent of audio-render/UI scheduling.
  await page.context().route('**/capture-worklet.js', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `
      class Capture extends AudioWorkletProcessor {
        constructor() {
          super();
          this.port.onmessage = () => {
            this.stopped = true;
            const tail = new Float32Array(128).fill(0.01);
            this.port.postMessage(tail, [tail.buffer]);
            this.port.postMessage('flushed');
          };
        }
        process(inputs) {
          if (!this.stopped && inputs[0]?.[0]?.length) {
            const audio = inputs[0][0].slice();
            this.port.postMessage(audio, [audio.buffer]);
          }
          return true;
        }
      }
      registerProcessor('capture', Capture);`,
  }));
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
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
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

for (const action of ['drain', 'cancel']) {
  test(`microphone pipeline ${action} while final transcript output is pending`, async ({ page }) => {
    await fakeBackend(page); await fakeMicrophone(page);
    await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
    await observePipeline(page);
    await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(() => window.microphoneRequests)).toEqual([]);
    await page.locator('#start').click();
    await expect(page.locator('#partial')).toHaveText('日本語のテスト');
    expect(await graphTypes(page)).toEqual(['MicrophoneAudioNode', 'SpeechToTextNode', 'TranscriptOutputNode']);
    expect(await page.evaluate(() => window.microphoneRequests)).toEqual([{ active: true }]);
    await page.evaluate(() => { window.holdTranscript = true; });
    // Microphone visibility handling uses the same graceful pipeline stop.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => !!window.heldTranscript)).toBe(true);
    await expect(page.locator('#status')).toHaveText('Finalizing…');
    await expect(page.locator('#start')).toBeDisabled();
    await expect(page.locator('#final')).toBeEmpty();
    if (action === 'cancel') {
      await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
      await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
      await page.evaluate(() => window.releaseTranscript());
      await expect(page.locator('#final')).toBeEmpty();
      await expect(page.locator('#status')).toContainText('Ready');
    } else {
      await page.evaluate(() => window.releaseTranscript());
      await expect(page.locator('#status')).toContainText('Stopped');
      await expect(page.locator('#final')).toHaveText('日本語のテスト\n');
      await expect(page.locator('#start')).toBeEnabled();
    }
    expect(await page.evaluate(() => window.pipelineCalls.filter(c => c.id === 0).map(c => c.hook)))
      .toEqual(['start', 'stop', 'dispose']);
    await expect(page.locator('#errors')).toBeEmpty();
  });
}

test('hiding while microphone permission is pending drains and discards the late grant', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      window.grant = () => resolve({ getTracks: () => [{ stop: () => { window.lateTrackStopped = true; } }] });
    });
  });
  await page.goto('./nodes/speech-to-text/'); await expect(page.locator('#load')).toBeEnabled();
  await observePipeline(page);
  await page.locator('#load').click(); await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => !!window.grant)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#start')).toBeEnabled();
  await page.evaluate(() => window.grant());
  await expect.poll(() => page.evaluate(() => window.lateTrackStopped)).toBe(true);
  await expect(page.locator('#errors')).toBeEmpty();
  await expect(page.locator('#final')).toBeEmpty();
  expect(await page.evaluate(() => window.pipelineCalls.filter(c => c.id === 0).map(c => c.hook)))
    .toEqual(['start', 'stop', 'dispose']);
});
