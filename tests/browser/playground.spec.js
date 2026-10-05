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

// Controlled workers keep the real page, microphone, resampler and transfer
// paths, but make both transcripts and the second-pass completion deterministic.
async function twoPassFixtures(page, { holdReady = false, holdFinal = false } = {}) {
  await fakeMicrophone(page);
  await page.addInitScript(() => {
    const Worker = window.Worker;
    window.asrWorkers = []; window.asrMessages = []; window.asrTerminated = [];
    window.Worker = class extends Worker {
      constructor(url, options) {
        super(url, options);
        this.testId = window.asrWorkers.length;
        window.asrWorkers.push(this);
      }
      postMessage(message, ...args) {
        window.asrMessages.push({ id: this.testId, ...message,
          audio: message.audio ? Array.from(message.audio) : undefined });
        super.postMessage(message, ...args);
      }
      terminate() { window.asrTerminated.push(this.testId); super.terminate(); }
    };
  });
  await page.context().route('**/model-worker.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: `let session, previousSession;
      self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready'});
        if (data.type === 'start') { previousSession = session; session = data.session; }
        if (data.type === 'audio') {
          postMessage({type:'partial', text:'話しています', session});
          postMessage({type:'ack', samples:data.audio.length, session});
        }
        if (data.type === 'stop') {
          postMessage({type:'final', text:'月の第一パス', session});
          postMessage({type:'stopped', session});
        }
        if (data.type === 'test-late') {
          postMessage({type:'partial', text:'古い途中結果', session:previousSession});
          postMessage({type:'final', text:'古い第一パス', session:previousSession});
          postMessage({type:'stopped', session:previousSession});
          postMessage({type:'error', message:'Old stream error', session:previousSession});
        }
        if (data.type === 'test-line') postMessage({type:'final', text:'途中で完了した行', session});
      };`,
  }));
  await page.context().route('**/sherpa-worker.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: `let session;
      const finish = () => {
        postMessage({type:'final', text:'日本語の最終結果', session});
        postMessage({type:'stopped', session});
      };
      self.onmessage = ({data}) => {
        if (data.type === 'test-ready' || (data.type === 'load' && !${holdReady})) postMessage({type:'ready'});
        if (data.type === 'utterance') { session = data.session; if (!${holdFinal}) finish(); }
        if (data.type === 'test-finish') finish();
        if (data.type === 'test-late') {
          postMessage({type:'final', text:'古い第二パス', session});
          postMessage({type:'stopped', session});
        }
      };`,
  }));
}

async function loadTwoPass(page) {
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#language').selectOption('en');
  await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#backend').selectOption('two-pass');
  await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#language')).toHaveValue('ja');
  await expect(page.locator('#language')).toBeDisabled();
  await expect(page.locator('#description')).toContainText('max_tokens_per_second=13');
  await expect(page.locator('#partial-heading')).toHaveText('Moonshine streaming transcript (first pass)');
  await expect(page.locator('#final-heading')).toHaveText('ReazonSpeech final transcript (second pass)');
  await page.locator('#load').click();
}

test('two-pass loads both Japanese models and waits for both to be ready', async ({ page }) => {
  await twoPassFixtures(page, { holdReady: true });
  await loadTwoPass(page);
  await expect.poll(() => page.evaluate(() => window.asrMessages.filter(m => m.type === 'load').length)).toBe(2);
  await expect(page.locator('#start')).toBeDisabled();
  await page.evaluate(() => window.asrWorkers[1].postMessage({ type: 'test-ready' }));
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#progress')).toHaveText('Both models loaded.');
  const loads = await page.evaluate(() => window.asrMessages.filter(m => m.type === 'load'));
  expect(loads[0]).toEqual({ id: 1, type: 'load' });
  expect(loads[1]).toEqual({ id: 0, type: 'load', backend: 'moonshine', language: 'ja', vadThreshold: '0.5' });
  await page.locator('#cancel').click();
  expect(await page.evaluate(() => window.asrTerminated)).toEqual([0, 1]);
});

test('two-pass streams before Stop and sends exactly the retained recording after Stop', async ({ page }) => {
  await twoPassFixtures(page, { holdFinal: true });
  await loadTwoPass(page); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click();
  await expect(page.locator('#partial')).toHaveText('話しています');
  await expect(page.locator('#final')).toBeEmpty();
  expect(await page.evaluate(() => window.asrMessages.filter(m => m.id === 1 && m.type !== 'load'))).toEqual([]);
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Decoding ReazonSpeech');
  await expect(page.locator('#first-pass-lines')).toContainText('月の第一パス');
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#start')).toBeDisabled();
  const recording = await page.evaluate(() => {
    const first = window.asrMessages.filter(m => m.id === 0 && m.type === 'audio');
    const second = window.asrMessages.filter(m => m.id === 1 && m.type === 'utterance');
    return { first: first.flatMap(m => m.audio), second };
  });
  expect(recording.first.length).toBeGreaterThan(0);
  expect(recording.second).toHaveLength(1);
  expect(recording.second[0].audio).toEqual(recording.first);
  expect(await page.evaluate(() => window.trackStops)).toBe(1);
  await page.evaluate(() => window.asrWorkers[1].postMessage({ type: 'test-finish' }));
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('日本語の最終結果\n');
  await expect(page.locator('#latency')).not.toHaveText('—');
  await page.locator('#start').click();
  await expect(page.locator('#partial')).toHaveText('話しています');
  await expect(page.locator('#first-pass-lines')).toBeEmpty();
  await expect(page.locator('#final')).toBeEmpty();
  // Delayed callbacks from either completed pass cannot finalize this recording.
  await page.evaluate(() => {
    window.asrWorkers[0].postMessage({ type: 'test-late' });
    window.asrWorkers[1].postMessage({ type: 'test-late' });
  });
  await expect(page.locator('#status')).toContainText('Listening');
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toContainText('Decoding ReazonSpeech');
  const repeat = await page.evaluate(() => {
    const second = window.asrMessages.filter(m => m.type === 'utterance');
    const first = window.asrMessages.filter(m => m.type === 'audio' && m.session === second[1].session);
    return { first: first.flatMap(m => m.audio), second };
  });
  expect(repeat.second).toHaveLength(2);
  expect(repeat.second[1].audio).toEqual(repeat.first);
  await expect(page.locator('#first-pass-lines')).toHaveText('月の第一パス\n');
  await expect(page.locator('#final')).toBeEmpty();
  await page.evaluate(() => window.asrWorkers[1].postMessage({ type: 'test-finish' }));
  await expect(page.locator('#final')).toHaveText('日本語の最終結果\n');
  expect(await page.evaluate(() => window.trackStops)).toBe(2);
  await page.locator('#cancel').click();
  expect(await page.evaluate(() => window.asrTerminated)).toEqual([0, 1]);
});

test('two-pass preserves completed Moonshine lines during recording without a second-pass result', async ({ page }) => {
  await twoPassFixtures(page);
  await loadTwoPass(page); await expect(page.locator('#start')).toBeEnabled();
  await page.locator('#start').click();
  await expect(page.locator('#partial')).toHaveText('話しています');
  await page.evaluate(() => window.asrWorkers[0].postMessage({ type: 'test-line' }));
  await expect(page.locator('#first-pass-lines')).toHaveText('途中で完了した行\n');
  await expect(page.locator('#partial')).toHaveText('話しています');
  await expect(page.locator('#final')).toBeEmpty();
  expect(await page.evaluate(() => window.asrMessages.filter(m => m.id === 1 && m.type !== 'load'))).toEqual([]);
  await page.locator('#cancel').click();
  await expect(page.locator('#first-pass-lines')).toBeEmpty();
});

for (const duringSecondPass of [false, true]) {
  test(`two-pass Cancel ${duringSecondPass ? 'during final decode' : 'while recording'} and switching discard both passes`, async ({ page }) => {
    await twoPassFixtures(page, { holdFinal: true });
    await loadTwoPass(page); await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#start').click();
    await expect(page.locator('#partial')).toHaveText('話しています');
    if (duringSecondPass) {
      await page.locator('#stop').click();
      await expect(page.locator('#status')).toContainText('Decoding ReazonSpeech');
    }
    // Save callbacks to emulate messages already dispatched before termination.
    await page.evaluate(() => { window.oldAsrCallbacks = window.asrWorkers.map(w => w.onmessage); });
    await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
    expect(await page.evaluate(() => window.asrTerminated)).toEqual([0, 1]);
    expect(await page.evaluate(() => window.trackStops)).toBe(1);
    expect(await page.evaluate(() => window.asrMessages.filter(m => m.type === 'utterance').length)).toBe(duringSecondPass ? 1 : 0);
    await expect(page.locator('#first-pass-lines')).toBeEmpty();
    await expect(page.locator('#final')).toBeEmpty();
    await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#start').click();
    await expect(page.locator('#partial')).toHaveText('話しています');
    await page.evaluate(() => {
      for (const callback of window.oldAsrCallbacks) {
        callback({ data: { type: 'partial', text: '古い途中結果' } });
        callback({ data: { type: 'final', text: '古い最終結果' } });
        callback({ data: { type: 'stopped' } });
      }
    });
    await expect(page.locator('#partial')).toHaveText('話しています');
    await expect(page.locator('#final')).toBeEmpty();
    await expect(page.locator('#status')).toContainText('Listening');
    await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
    await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#backend').selectOption('whisper');
    await expect(page.locator('#load')).toBeEnabled();
    await expect(page.locator('#first-pass-lines')).toBeHidden();
    await expect(page.locator('#final')).toBeEmpty();
    expect(await page.evaluate(() => window.asrTerminated)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(await page.evaluate(() => window.trackStops)).toBe(2);
  });
}

for (const backend of ['moonshine', 'sherpa', 'sherpa-simulated', 'whisper']) {
  test(`${backend}-only still loads, captures, stops and repeats`, async ({ page }) => {
    await fakeBackend(page); await fakeMicrophone(page);
    await page.context().route('**/sherpa-worker.js', (route) => route.fulfill({
      contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
      body: `self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready'});
        if (data.type === 'audio') postMessage({type:'ack',samples:data.audio.length});
        if (data.type === 'vad-start') self.session = data.session;
        if (data.type === 'vad-audio') postMessage({type:'vad',session:self.session,frames:[{audio:data.audio,speaking:true}]});
        if (data.type === 'vad-stop') postMessage({type:'vad-stopped',session:self.session});
        if (data.type === 'decode') {
          postMessage({type:data.final ? 'final' : 'partial',text:data.final ? '日本語のテスト' : '日本語の途中',session:data.session,id:data.id});
          postMessage({type:'decoded',session:data.session});
        }
        if (data.type === 'stop') { postMessage({type:'final',text:'日本語のテスト'}); postMessage({type:'stopped'}); }
      };`,
    }));
    await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
    await page.locator('#backend').selectOption(backend); await expect(page.locator('#load')).toBeEnabled();
    await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
    for (let i = 0; i < 2; i++) {
      await page.locator('#start').click(); await expect(page.locator('#status')).toContainText('Listening');
      await expect(page.locator('#audio')).not.toHaveText('—');
      if (backend === 'sherpa-simulated') await expect(page.locator('#partial')).toHaveText('日本語の途中');
      await expect(page.locator('#final')).toBeEmpty();
      await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
      await expect(page.locator('#final')).toHaveText('日本語のテスト\n');
    }
    await expect(page.locator('#errors')).toBeEmpty();
    expect(await page.evaluate(() => window.trackStops)).toBe(2);
  });
}

test('ReazonSpeech whole-utterance worker path reuses the recognizer and frees streams', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit bypasses interception for importScripts; controlled two-pass workers are tested on both browsers.');
  // Stub only the upstream runtime: exercise the actual sherpa-worker.js path.
  await page.context().route('**/vendor/sherpa/sherpa-onnx-asr.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: `self.OfflineRecognizer = class {
      constructor(config) { this.handle = 1; postMessage({type:'test-config', config}); }
      createStream() {
        return {
          acceptWaveform(rate, audio) { this.audio = audio; postMessage({type:'test-waveform', rate, audio:Array.from(audio)}); },
          free() { postMessage({type:'test-freed'}); },
        };
      }
      decode(stream) { if (stream.audio[0] === -1) throw new Error('Test decode failure'); }
      getResult() { return {text:' 日本語の最終結果 '}; }
    };`,
  }));
  await page.context().route('**/vendor/sherpa/sherpa-onnx-wasm-main-vad-asr.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: 'self.Module.onRuntimeInitialized();',
  }));
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  const events = await page.evaluate(async () => {
    const worker = new Worker('./sherpa-worker.js'), events = [];
    let resolveNext;
    worker.onmessage = ({ data }) => {
      events.push(data);
      if (['ready', 'stopped', 'error'].includes(data.type)) resolveNext(data);
    };
    const request = (message) => new Promise((resolve) => { resolveNext = resolve; worker.postMessage(message); });
    try {
      await request({ type: 'load' });
      await request({ type: 'utterance', audio: new Float32Array([0.001, 0, 0.05]), session: 1 });
      await request({ type: 'utterance', audio: new Float32Array([0.02, 0.01]), session: 2 });
      await request({ type: 'utterance', audio: new Float32Array(), session: 3 });
      await request({ type: 'utterance', audio: new Float32Array([-1]), session: 4 });
      return events;
    } finally { worker.terminate(); }
  });
  const config = events.filter(e => e.type === 'test-config');
  expect(config).toHaveLength(1);
  expect(config[0].config.featConfig.sampleRate).toBe(16000);
  expect(config[0].config.modelConfig.transducer.encoder).toBe('./transducer-encoder.onnx');
  expect(events.filter(e => e.type === 'test-waveform').map(e => [e.rate, e.audio])).toEqual([
    [16000, Array.from(new Float32Array([0.001, 0, 0.05]))],
    [16000, Array.from(new Float32Array([0.02, 0.01]))],
    [16000, [-1]],
  ]);
  expect(events.filter(e => e.type === 'test-freed')).toHaveLength(3);
  expect(events.filter(e => e.type === 'final')).toEqual([
    { type: 'final', session: 1, text: '日本語の最終結果' },
    { type: 'final', session: 2, text: '日本語の最終結果' },
  ]);
  expect(events.filter(e => e.type === 'stopped').map(e => e.session)).toEqual([1, 2, 3]);
  expect(events.filter(e => e.type === 'error')).toEqual([{ type: 'error', session: 4, message: 'Test decode failure' }]);
});

test('Moonshine stream callbacks retain their recording session and Stop closes each stream', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit bypasses interception for imported worker bindings; controlled two-pass workers are tested on both browsers.');
  await page.context().route('**/vendor/moonshine/index.js', (route) => route.fulfill({
    contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
    body: `export const ModelArch = {SmallStreaming:4};
      const listeners = [];
      export const Transcriber = { loadFromUrls: async () => ({
        createStream() {
          const index = listeners.length;
          return {
            addListener(listener) { listeners.push(listener); },
            start() { listeners[index].onLineStarted({line:{id:index}}); },
            addAudio() {},
            transcribe() {
              if (index) {
                listeners[0].onLineTextChanged({line:{text:'古い途中結果'}});
                listeners[0].onError({error:new Error('Old stream error')});
              }
              listeners[index].onLineTextChanged({line:{text:'話しています'}});
            },
            stop() { listeners[index].onLineCompleted({line:{id:index, text:'月の第一パス'}}); },
            close() { postMessage({type:'test-closed'}); },
          };
        },
      }) };`,
  }));
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  const events = await page.evaluate(async () => {
    const worker = new Worker('./model-worker.js', {type:'module'}), events = [];
    let resolveNext, expected;
    worker.onmessage = ({data}) => { events.push(data); if (data.type === expected) resolveNext(); };
    const request = (message, type) => new Promise((resolve) => {
      expected = type; resolveNext = resolve; worker.postMessage(message);
    });
    try {
      await request({type:'load', backend:'moonshine', language:'ja'}, 'ready');
      for (const session of [1, 2]) {
        await request({type:'start', session}, 'started');
        await request({type:'audio', audio:new Float32Array([0.05]), session}, 'ack');
        await request({type:'stop', session}, 'stopped');
      }
      return events;
    } finally { worker.terminate(); }
  });
  expect(events.filter(e => e.type === 'test-closed')).toHaveLength(2);
  expect(events.filter(e => e.type === 'partial').map(e => [e.session, e.text])).toEqual([
    [1, '話しています'], [1, '古い途中結果'], [2, '話しています'],
  ]);
  expect(events.filter(e => e.type === 'final').map(e => [e.session, e.text])).toEqual([
    [1, '月の第一パス'], [2, '月の第一パス'],
  ]);
  expect(events.filter(e => e.type === 'error')).toEqual([{type:'error', session:1, message:'Old stream error'}]);
});
