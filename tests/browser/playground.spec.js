import { test, expect } from '@playwright/test';

// Exercise the real page/capture lifecycle without downloading models in CI.
// Real model inference is covered separately by the opt-in smoke test.
async function fakeBackend(page) {
  await page.context().route('**/model-worker.js', (route) => route.fulfill({ contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: `
    self.onmessage = ({data}) => {
      if (data.type === 'load') postMessage({type:'ready'});
      if (data.type === 'audio') postMessage({type:'ack',samples:data.audio.length});
      if (data.type === 'stop') {
        postMessage({type:'final',text:'日本語のテスト'}); postMessage({type:'stopped'});
      }
    };
  ` }));
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

test('Pages isolation activates; selection keeps the repeatable utterance', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#load')).toBeEnabled();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.locator('#utterance').fill('今日は東京でテストします。');
  await page.locator('#backend').selectOption('sherpa');
  await expect(page.locator('#description')).toContainText('ReazonSpeech');
  await expect(page.locator('#partial')).toContainText('Unsupported');
  await page.locator('#backend').selectOption('whisper');
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
  await expect(page.locator('#backend')).toBeDisabled();
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
  expect(await page.evaluate(() => window.workerMessages.filter((message) => message.id === 2 && message.type === 'stop'))).toEqual([]);
  await expect(page.locator('#status')).toContainText('Listening');
  await expect(page.locator('#final')).toBeEmpty();
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => window.flushReady?.())).toBe(true);
  await page.evaluate(() => window.finishFlush());
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toContainText('日本語のテスト');
  expect(await page.evaluate(() => window.trackStops)).toBe(2);
});

test('Moonshine language and sensitivity changes release the model and reach the worker', async ({ page }) => {
  await fakeBackend(page);
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.loads = []; window.terminated = 0;
    window.Worker = class extends Worker {
      postMessage(message, ...args) {
        if (message.type === 'load') window.loads.push(message);
        super.postMessage(message, ...args);
      }
      terminate() { window.terminated++; super.terminate(); }
    };
  });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#description')).toContainText('max_tokens_per_second=13');
  await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#language').selectOption('en');
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => window.terminated)).toBe(1);
  await page.locator('#vad-threshold').selectOption('0.2');
  await expect(page.locator('#description')).toContainText('English Small Streaming');
  await expect(page.locator('#description')).toContainText('max_tokens_per_second=upstream default');
  await expect(page.locator('#description')).toContainText('quantized_26_08_21');
  await expect(page.locator('#description')).toContainText('threshold 0.2');
  await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
  expect(await page.evaluate(() => window.loads)).toEqual([
    { type: 'load', backend: 'moonshine', language: 'ja', vadThreshold: '0.5' },
    { type: 'load', backend: 'moonshine', language: 'en', vadThreshold: '0.2' },
  ]);
  await page.locator('#backend').selectOption('whisper');
  await expect(page.locator('#moonshine-options')).toBeHidden();
  await expect(page.locator('#speech')).toContainText('all captured audio is retained');
});

for (const outcome of ['rejected', 'accepted without text', 'transcribed']) {
  test(`quiet microphone signal can be distinguished from VAD ${outcome}`, async ({ page }) => {
    await page.context().route('**/model-worker.js', (route) => route.fulfill({
      contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
      body: `self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready'});
        if (data.type === 'audio') postMessage({type:'ack',samples:data.audio.length});
        if (data.type === 'stop') {
          if (${JSON.stringify(outcome)} !== 'rejected') {
            postMessage({type:'speech',event:'started',id:'1'});
            postMessage({type:'speech',event:'completed',id:'1'});
          }
          if (${JSON.stringify(outcome)} === 'transcribed') {
            postMessage({type:'partial',text:'静かな声'});
            postMessage({type:'final',text:'静かな声'});
          }
          postMessage({type:'stopped'});
        }
      };`,
    }));
    await fakeMicrophone(page, 0.0001);
    await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
    await page.locator('#load').click(); await page.locator('#start').click();
    await expect(page.locator('#status')).toContainText('Listening');
    await expect(page.locator('#language')).toBeDisabled();
    await expect(page.locator('#vad-threshold')).toBeDisabled();
    await expect(page.locator('#signal')).toContainText('Nonzero microphone signal');
    await expect(page.locator('#signal')).toContainText('dBFS');
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('#speech')).toContainText(outcome === 'rejected' ? '0 native VAD' : '1 native VAD');
    await expect(page.locator('#asr-events')).toHaveText(outcome === 'transcribed'
      ? '1 nonempty partial(s); 1 nonempty final(s).' : '0 nonempty partial(s); 0 nonempty final(s).');
    // Evidence survives Stop but resets for a repeat.
    await expect(page.locator('#signal')).toContainText('session peak RMS');
    await page.locator('#start').click();
    await expect(page.locator('#status')).toContainText('Listening');
    await expect(page.locator('#signal')).toContainText('Nonzero microphone signal');
    await expect(page.locator('#errors')).toBeEmpty();
    await expect(page.locator('#speech')).toContainText('0 native VAD');
    await expect(page.locator('#asr-events')).toContainText('0 nonempty partial');
    await expect(page.locator('#final')).toBeEmpty();
    await page.locator('#cancel').click();
    await expect(page.locator('#status')).toContainText('Canceled');
    expect(await page.evaluate(() => window.trackStops)).toBe(2);
  });
}

test('Moonshine forwards the Japanese token rate to the runtime and preserves English defaults', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit cannot reliably intercept imported module-worker bindings; real model loading is tested separately.');
  await page.context().route('**/vendor/moonshine/index.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: `export const ModelArch = { SmallStreaming: 4 };
      export const Transcriber = {
        loadFromUrls: async (files, config) => {
          postMessage({ type: 'runtime-config', files, modelArch: config.modelArch, options: config.options });
          return {};
        },
      };`,
  }));
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  const loads = [
    {}, // The worker's default language is Japanese.
    { language: 'ja', vadThreshold: '0.5' },
    { language: 'ja', vadThreshold: '0.2' },
    { language: 'en', vadThreshold: '0.5' },
    { language: 'en', vadThreshold: '0.2' },
  ];
  for (const load of loads) {
    const config = await page.evaluate(async (load) => {
      const worker = new Worker('./model-worker.js', { type: 'module' });
      try {
        return await new Promise((resolve, reject) => {
          let config;
          worker.onerror = (event) => reject(new Error(event.message));
          worker.onmessage = ({ data }) => {
            if (data.type === 'runtime-config') config = data;
            if (data.type === 'error') reject(new Error(data.message));
            if (data.type === 'ready') resolve(config);
          };
          worker.postMessage({ type: 'load', backend: 'moonshine', ...load });
        });
      } finally { worker.terminate(); }
    }, load);
    const language = load.language ?? 'ja';
    expect(config.options).toEqual(language === 'ja'
      ? { max_tokens_per_second: '13', vad_threshold: load.vadThreshold ?? '0.5' }
      : { vad_threshold: load.vadThreshold });
    expect(config.modelArch).toBe(4);
    expect(Object.keys(config.files)).toEqual(['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort',
      'encoder.ort', 'frontend.model.ort', 'frontend.weights.ort', 'streaming_config.json', 'tokenizer.bin']);
    const release = language === 'ja' ? 'quantized_26_08_23' : 'quantized_26_08_21';
    for (const [file, url] of Object.entries(config.files)) {
      expect(url).toBe(`https://download.moonshine.ai/model/small-streaming-${language}/${release}/${file}`);
    }
  }
});

test('an incompatible Moonshine runtime reports the intended model and never falls back', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit cannot reliably intercept imported module-worker bindings; real model loading is tested separately.');
  const binding = `export const ModelArch = { SmallStreaming: 4 };
      export const Transcriber = {
        loadFromUrls: async (files, options) => {
          if (options.modelArch !== 4 || options.options.vad_threshold !== '0.5'
            || options.options.max_tokens_per_second !== '13'
            || Object.keys(files).length !== 8
            || !Object.values(files).every(url => url.includes('/small-streaming-ja/quantized_26_08_23/'))) {
            throw new Error('Wrong model configuration');
          }
          throw new Error('Streaming model unsupported by test runtime');
        },
        load: async () => { throw new Error('Unexpected fallback attempt'); },
      };`;
  await page.context().route('**/vendor/moonshine/index.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' }, body: binding,
  }));
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click();
  await expect(page.locator('#errors')).toContainText('Japanese Small Streaming');
  await expect(page.locator('#errors')).toContainText('No fallback is used. Streaming model unsupported');
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#start')).toBeDisabled();
});
