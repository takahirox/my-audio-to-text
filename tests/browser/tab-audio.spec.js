import { test, expect } from '@playwright/test';

for (const fallback of [false, true]) {
  test(`composable tab pipeline uses native ${fallback ? 'fallback' : 'worklet'} capture and the real ASR boundary`, async ({ page }) => {
    await setup(page, { fallback, emptyFinal: true });
    // The playground supplies isolation; the example owns a separate graph/core.
    await page.locator('#cancel').click();
    await expect(page.locator('#load')).toBeEnabled();
    await page.evaluate(async () => {
      const { createTabTranscriptionPipeline } = await import('/transcription-nodes.js');
      window.pipelineValues = []; window.pipelineErrors = [];
      window.flow = createTabTranscriptionPipeline({
        onTranscript: async (port, value) => {
          await Promise.resolve(); window.pipelineValues.push({ port, ...value });
        },
        onError: error => window.pipelineErrors.push(error.message),
      });
      await window.flow.speech.load();
      await window.flow.pipeline.start();
    });
    await expect.poll(() => page.evaluate(() => window.pipelineValues.filter(v => v.port === 'provisional').length)).toBeGreaterThan(0);
    await page.evaluate(async () => { await window.flow.pipeline.stop(); });
    expect(await page.evaluate(() => window.pipelineValues.filter(v => v.port === 'final'))).toEqual([
      { port: 'final', text: 'tab transcript', id: 1 },
    ]);
    expect(await page.evaluate(() => window.flow.pipeline.state)).toBe('stopped');
    await released(page);
    await page.evaluate(async () => { await window.flow.pipeline.dispose(); });
    expect(await page.evaluate(() => window.terminated)).toBe(4);
    expect(await page.evaluate(() => window.pipelineErrors)).toEqual([]);
    const pcm = await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-audio'));
    expect(pcm.length).toBeGreaterThan(0);
    expect(pcm.every(m => m.float32)).toBe(true);
    expect(pcm.some(m => Math.abs(m.last - 0.05) < 1e-5)).toBe(true);
    expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-stop'))).toHaveLength(1);
  });
}

test('composable tab pipeline cancels a pending native capture grant and releases late tracks', async ({ page }) => {
  await setup(page, { mode: 'pending' });
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await page.evaluate(async () => {
    const { createTabTranscriptionPipeline } = await import('/transcription-nodes.js');
    window.pipelineValues = [];
    window.flow = createTabTranscriptionPipeline({
      onTranscript: (port, value) => window.pipelineValues.push(value),
    });
    await window.flow.speech.load();
    window.flowStarting = window.flow.pipeline.start().catch(error => error.name);
  });
  await expect.poll(() => page.evaluate(() => !!window.grantTab)).toBe(true);
  await page.evaluate(async () => { await window.flow.pipeline.dispose(); });
  expect(await page.evaluate(() => window.flowStarting)).toBe('AbortError');
  await page.evaluate(() => window.grantTab()); await released(page);
  expect(await page.evaluate(() => window.terminated)).toBe(4);
  expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-audio'))).toEqual([]);
  expect(await page.evaluate(() => window.pipelineValues)).toEqual([]);
  expect(await page.evaluate(() => window.flow.pipeline.state)).toBe('disposed');
});

async function setup(page, { mode = 'audio', fallback = false, holdModule = false, emptyFinal = false } = {}) {
  for (const role of ['sherpa', 'silero']) {
    await page.context().route(`**/${role}-worker.js`, route => route.fulfill({
      contentType: 'text/javascript', headers: { 'Cross-Origin-Embedder-Policy': 'require-corp' },
      body: `self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready'});
        if (data.type === 'vad-audio') postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking:true}]});
        if (data.type === 'vad-stop') postMessage({type:'vad-stopped',session:data.session});
        if (data.type === 'decode') {
          postMessage({type:data.final ? 'final' : 'partial',text:data.final && ${emptyFinal} ? ' \t ' : 'tab transcript',id:data.id,session:data.session});
          postMessage({type:'decoded',session:data.session});
        }
      };`,
    }));
  }
  await page.addInitScript(({ mode, fallback, holdModule }) => {
    const NativeContext = window.AudioContext, NativeWorker = window.Worker;
    window.captureContexts = []; window.workerMessages = []; window.terminated = 0;
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args); window.captureContexts.push(this);
        if (fallback) Object.defineProperty(this, 'audioWorklet', { value: null });
        if (holdModule) Object.defineProperty(this, 'audioWorklet', { value: {
          addModule: () => new Promise(resolve => { window.finishModule = resolve; }),
        } });
      }
    };
    window.Worker = class extends NativeWorker {
      postMessage(data, ...args) {
        window.workerMessages.push({ type: data.type, length: data.audio?.length,
          float32: data.audio instanceof Float32Array, final: data.final,
          first: data.audio?.[0], last: data.audio?.at(-1) });
        super.postMessage(data, ...args);
      }
      terminate() { window.terminated++; super.terminate(); }
    };
    if (mode === 'flush-error') {
      const NativeWorklet = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeWorklet {
        constructor(...args) {
          super(...args); const post = this.port.postMessage.bind(this.port);
          this.port.postMessage = message => {
            if (message === 'flush') throw new Error('controlled flush failure');
            post(message);
          };
        }
      };
    }
    const devices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { value: devices });
    window.displayRequests = []; window.tabStreams = [];
    devices.getUserMedia = () => { throw new Error('Unexpected microphone request'); };
    function stream() {
      // Real stereo Web Audio stream; only the unconsumed video track is a fixture.
      const context = new NativeContext(), merger = context.createChannelMerger(2);
      const left = context.createConstantSource(), right = context.createConstantSource();
      left.offset.value = 0.02; right.offset.value = 0.08;
      left.connect(merger, 0, 0); right.connect(merger, 0, 1);
      const destination = context.createMediaStreamDestination();
      merger.connect(destination); left.start(); right.start(); void context.resume().catch(() => {});
      const media = destination.stream, audio = media.getAudioTracks()[0], originalStop = audio.stop.bind(audio);
      audio.stops = 0;
      audio.stop = () => { audio.stops++; originalStop(); };
      const video = { kind: 'video', readyState: 'live', stops: 0, onended: null,
        stop() { this.stops++; this.readyState = 'ended'; left.stop(); right.stop(); if (mode === 'no-audio') originalStop(); void context.close(); },
      };
      const tracks = mode === 'no-audio' ? [video] : [audio, video];
      media.getTracks = () => tracks;
      media.getAudioTracks = () => mode === 'no-audio' ? [] : [audio];
      window.tabStreams.push({ media, tracks, context }); return media;
    }
    if (mode === 'unsupported') devices.getDisplayMedia = undefined;
    else devices.getDisplayMedia = options => {
      window.displayRequests.push({ options, active: navigator.userActivation.isActive });
      if (mode === 'denied' || mode === 'aborted') {
        return Promise.reject(new DOMException('picker rejected', mode === 'denied' ? 'NotAllowedError' : 'AbortError'));
      }
      if (mode === 'pending') return new Promise(resolve => { window.grantTab = () => resolve(stream()); });
      return Promise.resolve(stream());
    };
  }, { mode, fallback, holdModule });
  await page.goto('/'); await expect(page.locator('#load')).toBeEnabled();
  await expect(page.locator('#source')).toHaveValue('microphone');
  await page.locator('#source').selectOption('tab');
  await page.locator('#load').click(); await expect(page.locator('#start')).toBeEnabled();
}

async function released(page, count = 1) {
  await expect.poll(() => page.evaluate(() => window.tabStreams.map(s => s.tracks.map(t => t.stops))))
    .toEqual(Array.from({ length: count }, () => [1, 1]));
  expect(await page.evaluate(() => window.captureContexts.every(c => c.state === 'closed'))).toBe(true);
  expect(await page.evaluate(() => window.tabStreams.every(s => s.context.state === 'closed'))).toBe(true);
}

for (const fallback of [false, true]) {
  for (const emptyFinal of [false, true]) {
    test(`tab audio uses the picker API and real ${fallback ? 'fallback' : 'worklet'} capture, then Stop/repeat${emptyFinal ? ' with empty final decoding' : ''}`, async ({ page }) => {
      await setup(page, { fallback, emptyFinal }); await page.locator('#start').click();
      await expect(page.locator('#status')).toContainText('Listening to tab audio');
      await expect(page.locator('#partial')).toHaveText('tab transcript');
      const request = await page.evaluate(() => window.displayRequests[0]);
      expect(request.active).toBe(true);
      expect(request.options).toEqual({ video: { displaySurface: 'browser' }, audio: true,
        systemAudio: 'exclude', windowAudio: 'exclude' });
      await expect(page.locator('#signal')).toContainText('Nonzero tab audio signal');
      const input = await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-audio'));
      expect(input.length).toBeGreaterThan(0);
      expect(input.every(m => m.float32 && m.length < 2048)).toBe(true);
      expect(input.some(m => Math.abs(m.last - 0.05) < 1e-5)).toBe(true);
      await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
      await expect(page.locator('#final')).toHaveText('tab transcript\n');
      await expect(page.locator('#partial')).toBeEmpty();
      await released(page);
      const messages = await page.evaluate(() => window.workerMessages);
      expect(messages.filter(m => m.type === 'vad-stop')).toHaveLength(1);
      expect(messages.filter(m => m.type === 'decode' && m.final)).toHaveLength(1);
      await page.locator('#start').click(); await expect(page.locator('#partial')).toHaveText('tab transcript');
      await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
      await released(page, 2); await expect(page.locator('#final')).toBeEmpty();
      expect(await page.evaluate(() => window.terminated)).toBe(2);
      await expect(page.locator('#errors')).toBeEmpty();
    });
  }
}

for (const mode of ['denied', 'aborted', 'no-audio', 'unsupported']) {
  test(`${mode} tab capture fails visibly and releases the ASR session and capture resources`, async ({ page }) => {
    await setup(page, { mode }); await page.locator('#start').click();
    const message = mode === 'unsupported' ? 'unavailable' : mode === 'no-audio' ? 'No audio was shared' : 'denied or canceled';
    await expect(page.locator('#errors')).toContainText(message);
    await expect(page.locator('#load')).toBeEnabled(); await expect(page.locator('#stop')).toBeDisabled();
    expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-audio'))).toEqual([]);
    expect(await page.evaluate(() => window.captureContexts.every(c => c.state === 'closed'))).toBe(true);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    if (mode === 'no-audio') {
      expect(await page.evaluate(() => window.tabStreams[0].tracks.map(t => t.stops))).toEqual([1]);
      expect(await page.evaluate(() => window.tabStreams[0].context.state)).toBe('closed');
    }
  });
}

for (const kind of ['audio', 'video']) {
  test(`${kind} track ending finalizes once and releases both tracks`, async ({ page }) => {
    await setup(page); await page.locator('#start').click();
    await expect(page.locator('#partial')).toHaveText('tab transcript');
    await page.evaluate(kind => {
      const track = window.tabStreams[0].tracks.find(t => t.kind === kind);
      track.onended(new Event('ended'));
    }, kind);
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('#final')).toHaveText('tab transcript\n');
    await released(page);
    expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-stop'))).toHaveLength(1);
  });
}

for (const action of ['cancel', 'switch', 'pagehide']) {
  test(`${action} during the tab picker discards a late-granted stream`, async ({ page }) => {
    await setup(page, { mode: 'pending' }); await page.locator('#start').click();
    await expect(page.locator('#status')).toContainText('Choose a browser tab');
    if (action === 'switch') await page.locator('#source').selectOption('microphone');
    else if (action === 'cancel') await page.locator('#cancel').click();
    else await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    if (action !== 'pagehide') await expect(page.locator('#load')).toBeEnabled();
    await page.evaluate(() => window.grantTab()); await released(page);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-audio'))).toEqual([]);
    await expect(page.locator('#errors')).toBeEmpty();
  });
}

for (const action of ['switch', 'pagehide', 'error']) {
  test(`${action} during tab capture releases tracks, context and workers`, async ({ page }) => {
    await setup(page); await page.locator('#start').click();
    await expect(page.locator('#partial')).toHaveText('tab transcript');
    if (action === 'switch') await page.locator('#source').selectOption('microphone');
    else if (action === 'pagehide') await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    else await page.evaluate(() => window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
      promise: Promise.resolve(), reason: new Error('controlled capture failure'),
    })));
    if (action !== 'pagehide') await expect(page.locator('#load')).toBeEnabled();
    await released(page);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-stop'))).toEqual([]);
    if (action === 'switch') await expect(page.locator('#partial')).toHaveText('Waiting for speech…');
    if (action === 'error') await expect(page.locator('#errors')).toContainText('controlled capture failure');
  });
}

test('backgrounding the playground preserves active tab capture', async ({ page }) => {
  await setup(page); await page.locator('#start').click();
  await expect(page.locator('#partial')).toHaveText('tab transcript');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#status')).toContainText('Listening to tab audio');
  expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-stop'))).toEqual([]);
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await released(page);
});

test('sharing ending during worklet initialization finalizes an empty session without reviving capture', async ({ page }) => {
  await setup(page, { holdModule: true }); await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => !!window.finishModule)).toBe(true);
  await page.evaluate(() => window.tabStreams[0].tracks[1].onended(new Event('ended')));
  await expect(page.locator('#status')).toContainText('Stopped');
  await released(page);
  await page.evaluate(() => window.finishModule());
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#start')).toBeEnabled();
  await expect(page.locator('#errors')).toBeEmpty();
  expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-audio'))).toEqual([]);
  expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-stop'))).toHaveLength(1);
});

test('a canceled picker grant cannot feed or end a replacement tab session', async ({ page }) => {
  await setup(page, { mode: 'pending' }); await page.locator('#start').click();
  await page.evaluate(() => { window.oldGrant = window.grantTab; });
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await page.locator('#load').click(); await page.locator('#start').click();
  await page.evaluate(() => window.grantTab());
  await expect(page.locator('#partial')).toHaveText('tab transcript');
  await page.evaluate(() => window.oldGrant());
  await expect.poll(() => page.evaluate(() => window.tabStreams[1].tracks.map(t => t.stops))).toEqual([1, 1]);
  expect(await page.evaluate(() => window.tabStreams[0].tracks.map(t => t.stops))).toEqual([0, 0]);
  await expect(page.locator('#status')).toContainText('Listening to tab audio');
  await expect(page.locator('#errors')).toBeEmpty();
  await page.locator('#cancel').click(); await expect(page.locator('#load')).toBeEnabled();
  await released(page, 2);
  expect(await page.evaluate(() => window.terminated)).toBe(4);
});

test('a worklet flush error releases capture and workers and leaves retry available', async ({ page }) => {
  await setup(page, { mode: 'flush-error' }); await page.locator('#start').click();
  await expect(page.locator('#partial')).toHaveText('tab transcript');
  await page.locator('#stop').click();
  await expect(page.locator('#errors')).toContainText('controlled flush failure');
  await expect(page.locator('#load')).toBeEnabled();
  await released(page);
  expect(await page.evaluate(() => window.terminated)).toBe(2);
  expect(await page.evaluate(() => window.workerMessages.filter(m => m.type === 'vad-stop'))).toEqual([]);
});
