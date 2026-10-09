import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observePipeline, graphTypes } from '../browser/pipeline-observer.js';

const bundle = path.resolve('dist/chrome-extension');
const test = base.extend({
  extension: async ({}, use) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'local-asr-extension-'));
    const root = path.join(temporary, 'extension');
    await cp(bundle, root, { recursive: true, filter: source => !source.includes(`${path.sep}vendor`) });
    for (const role of ['sherpa', 'silero']) {
      await writeFile(path.join(root, 'web', `${role}-worker.js`), `
        self.onmessage = ({data}) => {
          if (data.type === 'load') postMessage({type:'ready'});
          if (data.type === 'fixture-error') postMessage({type:'error',message:'Controlled worker failure'});
          if (data.type === 'fixture-progress') postMessage({type:'progress',message:'Loading fixture models…'});
          if (data.type === 'vad-audio') postMessage({type:'vad',session:data.session,frames:[{audio:data.audio,speaking:true}]});
          if (data.type === 'vad-stop') postMessage({type:'vad-stopped',session:data.session});
          if (data.type === 'decode') {
            postMessage({type:data.final ? 'final' : 'partial',text:data.final ? ' ' : 'extension transcript',id:data.id,session:data.session});
            postMessage({type:'decoded',session:data.session});
          }
        };`);
    }
    const context = await chromium.launchPersistentContext(path.join(temporary, 'profile'), {
      channel: 'chromium', headless: true,
      // Playwright's default mute flag also silences native tabCapture input.
      ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
      args: ['--enable-unsafe-extension-debugging'],
    });
    try {
      const cdp = await context.browser().newBrowserCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: root });
      // These legacy capture/lifecycle cases intentionally use a migrated
      // transcription-only preference. Fresh-install graph behavior is covered
      // by graph.spec.js.
      await context.addInitScript(() => localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: 'ja-en' })));
      await use({ context, cdp, id, url: `chrome-extension://${id}/extension/recorder.html` });
    } finally { await context.close(); await rm(temporary, { recursive: true, force: true }); }
  },
});

async function setup(extension, { mode = 'audio', fallback = false } = {}) {
  const { context, url } = extension;
  await context.addInitScript(({ mode, fallback }) => {
    const NativeContext = window.AudioContext, NativeWorker = window.Worker;
    window.contexts = []; window.streams = []; window.inputs = []; window.terminated = 0; window.requests = [];
    window.workers = []; window.holdLoad = mode === 'loading';
    window.AudioContext = class extends NativeContext {
      constructor(...args) {
        super(...args); window.contexts.push(this);
        if (fallback) Object.defineProperty(this, 'audioWorklet', { value: null });
      }
    };
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); window.workers.push(this); }
      postMessage(data, ...rest) {
        if (data.type === 'load' && window.holdLoad) return;
        if (data.audio) window.inputs.push({ float32: data.audio instanceof Float32Array,
          length: data.audio.length, last: data.audio.at(-1), type: data.type });
        super.postMessage(data, ...rest);
      }
      terminate() { window.terminated++; super.terminate(); }
    };
    chrome.tabCapture.getMediaStreamId = async options => {
      window.requests.push(options);
      if (mode === 'api-error') throw new Error('Chrome denied tab capture');
      return 'fixture-id';
    };
    navigator.mediaDevices.getDisplayMedia = () => { throw new Error('Unexpected sharing picker'); };
    const makeStream = () => {
      if (mode === 'no-audio') {
        const stream = new MediaStream(); window.streams.push({ stops: 0, stream }); return stream;
      }
      const context = new NativeContext(), merger = context.createChannelMerger(2);
      const left = context.createConstantSource(), right = context.createConstantSource();
      left.offset.value = mode === 'silence' ? 0 : 0.02;
      right.offset.value = mode === 'silence' ? 0 : 0.08;
      left.connect(merger, 0, 0); right.connect(merger, 0, 1);
      const destination = context.createMediaStreamDestination();
      merger.connect(destination); left.start(); right.start(); void context.resume();
      const stream = destination.stream, track = stream.getAudioTracks()[0], stop = track.stop.bind(track);
      const record = { context, stream, stops: 0 }; window.streams.push(record);
      track.stop = () => { record.stops++; stop(); left.stop(); right.stop(); void context.close(); };
      return stream;
    };
    navigator.mediaDevices.getUserMedia = options => {
      window.mediaOptions = options;
      if (mode === 'media-error') return Promise.reject(new Error('Tab media unavailable'));
      if (mode === 'pending') return new Promise(resolve => { window.grant = () => resolve(makeStream()); });
      return Promise.resolve(makeStream());
    };
    for (const [api, name] of [[chrome.tabs.onRemoved, 'removed'], [chrome.tabs.onUpdated, 'updated'],
      [chrome.runtime.onMessage, 'invoke']]) {
      const original = api.addListener.bind(api);
      api.addListener = callback => { window[name] = callback; original(callback); };
    }
  }, { mode, fallback });
  const page = await context.newPage();
  await page.goto(url);
  await observePipeline(page, new URL('../web/', url).href);
  await page.evaluate(() => window.invoke({ type: 'invoke', tabId: 42 }, { id: chrome.runtime.id }));
  return page;
}

async function released(page, count = 1) {
  await expect.poll(() => page.evaluate(() => window.streams.map(s => s.stops))).toEqual(Array(count).fill(1));
  expect(await page.evaluate(() => window.contexts.every(c => c.state === 'closed'))).toBe(true);
  expect(await page.evaluate(() => window.streams.every(s => s.context.state === 'closed'))).toBe(true);
}

for (const fallback of [false, true]) {
  test(`loadable MV3 extension uses real ${fallback ? 'fallback' : 'worklet'} audio, pipeline, provisional/final fallback, Stop and repeat`, async ({ extension }) => {
    const page = await setup(extension, { fallback });
    await expect(page.locator('#status')).toHaveText('Transcription active');
    await expect(page.locator('#partial')).toHaveText('extension transcript');
    expect(await graphTypes(page)).toEqual(['ExtensionTabAudioNode', 'SpeechToTextNode', 'TranscriptOutputNode']);
    expect(await page.evaluate(() => window.requests)).toEqual([{ targetTabId: 42 }]);
    expect(await page.evaluate(() => window.mediaOptions.audio.mandatory)).toEqual({ chromeMediaSource: 'tab', chromeMediaSourceId: 'fixture-id' });
    expect(await page.evaluate(() => window.mediaOptions.video)).toBe(false);
    await expect(page.locator('#signal')).toHaveText('Tab audio signal detected.');
    const inputs = await page.evaluate(() => window.inputs.filter(m => m.type === 'vad-audio'));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every(m => m.float32 && m.length <= 2048)).toBe(true);
    expect(inputs.some(m => Math.abs(m.last - 0.05) < 1e-5)).toBe(true);
    await page.locator('#stop').click();
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('#final')).toHaveText('extension transcript\n');
    await expect(page.locator('#partial')).toBeEmpty(); await released(page);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    await page.locator('#start').click();
    await expect(page.locator('#final')).toBeEmpty();
    await expect(page.locator('#partial')).toHaveText('extension transcript');
    await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
    await released(page, 2); expect(await page.evaluate(() => window.terminated)).toBe(4);
    await expect(page.locator('#errors')).toBeEmpty();
    expect(await page.evaluate(() => window.pipelineCalls)).toEqual([
      { hook: 'start', id: 0 }, { hook: 'stop', id: 0 }, { hook: 'dispose', id: 0 },
      { hook: 'start', id: 1 }, { hook: 'stop', id: 1 }, { hook: 'dispose', id: 1 },
    ]);
  });
}

test('Stop waits for the final transcript port before completion and disposal', async ({ extension }) => {
  const page = await setup(extension);
  await expect(page.locator('#partial')).toHaveText('extension transcript');
  await page.evaluate(() => { window.holdTranscript = true; });
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => window.heldTranscript?.text)).toBe('extension transcript');
  await expect(page.locator('#status')).toHaveText('Finalizing transcript…');
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => window.terminated)).toBe(0);
  await page.evaluate(() => window.releaseTranscript());
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('#final')).toHaveText('extension transcript\n');
  await released(page);
  expect(await page.evaluate(() => window.terminated)).toBe(2);
});

test('teardown while the transcript sink drains discards held output and workers', async ({ extension }) => {
  const page = await setup(extension);
  await expect(page.locator('#partial')).toHaveText('extension transcript');
  await page.evaluate(() => { window.holdTranscript = true; });
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => !!window.releaseTranscript)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.terminated)).toBe(2);
  await page.evaluate(() => window.releaseTranscript());
  await released(page);
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#errors')).toBeEmpty();
});

test('model preload progress and cancellation leave capture unrequested and retry available', async ({ extension }) => {
  const page = await setup(extension, { mode: 'loading' });
  await expect(page.locator('#status')).toContainText('Loading ReazonSpeech');
  await page.evaluate(() => window.workers[0].postMessage({ type: 'fixture-progress' }));
  await expect(page.locator('#status')).toHaveText('Loading fixture models…');
  expect(await page.evaluate(() => window.requests)).toEqual([]);
  await page.locator('#stop').click();
  await expect(page.locator('#status')).toHaveText('Stopped before capture started.');
  expect(await page.evaluate(() => window.terminated)).toBe(2);
  expect(await page.evaluate(() => window.requests)).toEqual([]);
  expect(await page.evaluate(() => window.pipelineCalls)).toEqual([{ hook: 'dispose', id: 0 }]);
  await page.evaluate(() => { window.holdLoad = false; });
  await page.locator('#start').click();
  await expect(page.locator('#partial')).toHaveText('extension transcript');
  await page.locator('#stop').click();
  await expect(page.locator('#final')).toHaveText('extension transcript\n');
  await released(page);
  await expect(page.locator('#errors')).toBeEmpty();
});

for (const phase of ['loading', 'running']) {
  test(`worker failure during ${phase} disposes the pipeline and permits retry`, async ({ extension }) => {
    const page = await setup(extension, { mode: phase === 'loading' ? 'loading' : 'audio' });
    await expect.poll(() => page.evaluate(() => window.workers.length)).toBe(2);
    if (phase === 'running') await expect(page.locator('#partial')).toHaveText('extension transcript');
    await page.evaluate(() => window.workers[0].postMessage({ type: 'fixture-error' }));
    await expect(page.locator('#errors')).toContainText('Controlled worker failure');
    await expect(page.locator('#start')).toBeEnabled();
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    if (phase === 'running') await released(page);
    else expect(await page.evaluate(() => window.requests)).toEqual([]);
    await page.evaluate(() => { window.holdLoad = false; });
    await page.locator('#start').click();
    await expect(page.locator('#partial')).toHaveText('extension transcript');
    await expect(page.locator('#errors')).toBeEmpty();
    await page.locator('#stop').click();
    await expect(page.locator('#status')).toContainText('Stopped');
    await released(page, phase === 'running' ? 2 : 1);
  });
}

for (const mode of ['api-error', 'media-error', 'no-audio']) {
  test(`${mode} produces a visible error and releases extension resources`, async ({ extension }) => {
    const page = await setup(extension, { mode });
    await expect(page.locator('#errors')).toContainText(mode === 'no-audio' ? 'No tab audio' : mode === 'api-error' ? 'denied' : 'unavailable');
    await expect(page.locator('#start')).toBeEnabled();
    await expect(page.locator('#stop')).toBeDisabled();
    expect(await page.evaluate(() => window.contexts.every(c => c.state === 'closed'))).toBe(true);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    expect(await page.evaluate(() => window.inputs)).toEqual([]);
  });
}

for (const reason of ['track', 'removed', 'updated']) {
  test(`${reason} ending the tab finalizes and releases the extension`, async ({ extension }) => {
    const page = await setup(extension);
    await expect(page.locator('#partial')).toHaveText('extension transcript');
    await page.evaluate(reason => {
      if (reason === 'track') window.streams[0].stream.getAudioTracks()[0].onended();
      else if (reason === 'removed') window.removed(42);
      else window.updated(42, { status: 'loading' });
    }, reason);
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('#final')).toHaveText('extension transcript\n'); await released(page);
    await expect(page.locator('#errors')).toBeEmpty();
  });
}

test('silent tab provides clear signal status and releases on Stop', async ({ extension }) => {
  const page = await setup(extension, { mode: 'silence' });
  await expect(page.locator('#status')).toHaveText('Transcription active');
  await expect(page.locator('#signal')).toContainText('No audio signal yet');
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await released(page); await expect(page.locator('#errors')).toBeEmpty();
});

test('window teardown during capture setup releases late media without stale output', async ({ extension }) => {
  const page = await setup(extension, { mode: 'pending' });
  await expect.poll(() => page.evaluate(() => !!window.grant)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.evaluate(() => window.grant()); await released(page);
  expect(await page.evaluate(() => window.inputs)).toEqual([]);
  expect(await page.evaluate(() => window.terminated)).toBe(2);
  await expect(page.locator('#errors')).toBeEmpty();
});

test('a late capture grant cannot feed or end a replacement session', async ({ extension }) => {
  const page = await setup(extension, { mode: 'pending' });
  await expect.poll(() => page.evaluate(() => !!window.grant)).toBe(true);
  await page.evaluate(() => { window.oldGrant = window.grant; });
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await page.locator('#start').click();
  await expect.poll(() => page.evaluate(() => window.grant !== window.oldGrant)).toBe(true);
  await page.evaluate(() => window.grant());
  await expect(page.locator('#partial')).toHaveText('extension transcript');
  await page.evaluate(() => window.oldGrant());
  await expect.poll(() => page.evaluate(() => window.streams.map(s => s.stops))).toEqual([0, 1]);
  await expect(page.locator('#status')).toHaveText('Transcription active');
  await expect(page.locator('#final')).toBeEmpty();
  await expect(page.locator('#errors')).toBeEmpty();
  await page.locator('#stop').click(); await expect(page.locator('#status')).toContainText('Stopped');
  await released(page, 2);
  expect(await page.evaluate(() => window.terminated)).toBe(4);
});

test('native tab capture requires the user-invoked tab grant', async ({ extension }) => {
  const { context, url } = extension;
  await context.route('https://meeting.test/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Uninvoked meeting tab</p>' }));
  const meeting = await context.newPage(); await meeting.goto('https://meeting.test/');
  const recorder = await context.newPage(); await recorder.goto(url);
  await meeting.bringToFront();
  const tabId = await recorder.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id);
  await recorder.goto(`${url}?tab=${tabId}`);
  await expect(recorder.locator('#status')).toContainText('Transcription failed');
  await expect(recorder.locator('#errors')).toContainText(/invoked|permission|capture/i);
  await expect(recorder.locator('#start')).toBeEnabled();
  expect(await recorder.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).length)).toBe(0);
});

test('real toolbar invocation captures the current tab without a picker, repeats, retargets and releases on navigation/close', async ({ extension }) => {
  const { context, cdp, id } = extension;
  await context.route('https://meeting.test/**', route => route.fulfill({ contentType: 'text/html', body: `
    <button id="play">Play controlled tab audio</button>
    <script>
      document.querySelector('#play').onclick = () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator(); oscillator.frequency.value = 440;
        const gain = context.createGain(); gain.gain.value = 0.05;
        oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
        context.resume();
      };
    </script>` }));
  const meeting = await context.newPage(); await meeting.goto('https://meeting.test/');
  await meeting.locator('#play').click();
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const target = targetInfos.find(target => target.url === meeting.url());
  expect(target).toBeDefined();
  const [recorder] = await Promise.all([
    context.waitForEvent('page'),
    cdp.send('Extensions.triggerAction', { id, targetId: target.targetId }),
  ]);
  await expect(recorder.locator('#status')).not.toBeEmpty();
  await expect(recorder.locator('#errors')).toHaveText('');
  await expect(recorder.locator('#status')).toHaveText('Transcription active');
  await expect(recorder.locator('#signal')).toHaveText('Tab audio signal detected.');
  await expect(recorder.locator('#partial')).toHaveText('extension transcript');
  await expect(recorder.locator('#errors')).toBeEmpty();
  // Another toolbar invocation during capture focuses the existing window and
  // retains the original native tab grant and stream.
  const worker = context.serviceWorkers().find(worker => worker.url().includes(id));
  const captured = () => worker.evaluate(async () =>
    (await chrome.tabCapture.getCapturedTabs()).filter(tab => tab.status === 'active').map(tab => tab.tabId));
  const originalTabs = await captured(); expect(originalTabs).toHaveLength(1);
  await recorder.evaluate(() => {
    window.invocations = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message.type === 'invoke') window.invocations.push(message.tabId);
    });
  });
  const second = await context.newPage(); await second.goto('https://meeting.test/second');
  const invocationTargets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await cdp.send('Extensions.triggerAction', { id,
    targetId: invocationTargets.targetInfos.find(target => target.url === second.url()).targetId });
  await expect.poll(() => recorder.evaluate(() => window.invocations.length)).toBe(1);
  await expect(recorder.locator('#status')).toHaveText('Transcription active');
  expect(await captured()).toEqual(originalTabs);
  expect(context.pages().filter(page => page.url().includes('/extension/recorder.html'))).toHaveLength(1);
  await recorder.locator('#stop').click();
  await expect(recorder.locator('#status')).toContainText('Stopped');
  await expect(recorder.locator('#final')).toHaveText('extension transcript\n');
  await recorder.locator('#start').click();
  await expect(recorder.locator('#status')).toHaveText('Transcription active');
  await expect(recorder.locator('#partial')).toHaveText('extension transcript');
  await expect(recorder.locator('#final')).toBeEmpty();
  // Returning focus to the meeting must leave the capture/window alive.
  await meeting.bringToFront();
  await expect(recorder.locator('#status')).toHaveText('Transcription active');
  await meeting.goto('https://meeting.test/next');
  await expect(recorder.locator('#status')).toContainText('Stopped');
  await expect(recorder.locator('#final')).toHaveText('extension transcript\n');
  await expect(recorder.locator('#errors')).toBeEmpty();
  // Toolbar invocation on a new tab reuses the same window after Stop.
  await second.bringToFront();
  await second.locator('#play').click();
  const targets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  const next = targets.targetInfos.find(target => target.url === second.url());
  await cdp.send('Extensions.triggerAction', { id, targetId: next.targetId });
  await expect(recorder.locator('#status')).toHaveText('Transcription active');
  await expect(recorder.locator('#partial')).toHaveText('extension transcript');
  await expect(recorder.locator('#final')).toBeEmpty();
  const retargetedTabs = await captured();
  expect(retargetedTabs).toEqual([await recorder.evaluate(() => window.invocations.at(-1))]);
  expect(retargetedTabs).not.toEqual(originalTabs);
  expect(context.pages().filter(page => page.url().includes('/extension/recorder.html'))).toHaveLength(1);
  await second.close();
  await expect(recorder.locator('#status')).toContainText('Stopped');
  await expect(recorder.locator('#final')).toHaveText('extension transcript\n');
  await expect(recorder.locator('#errors')).toBeEmpty();
  // Closing the transcript window releases an active native capture too.
  await meeting.bringToFront();
  await meeting.locator('#play').click();
  const finalTargets = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
  await cdp.send('Extensions.triggerAction', { id,
    targetId: finalTargets.targetInfos.find(target => target.url === meeting.url()).targetId });
  await expect(recorder.locator('#partial')).toHaveText('extension transcript');
  await recorder.close();
  await expect.poll(async () => worker.evaluate(async () =>
    (await chrome.tabCapture.getCapturedTabs()).filter(tab => tab.status === 'active').length)).toBe(0);
});

base('packaged extension initializes the real pinned ReazonSpeech/Silero workers under MV3 CSP', async () => {
  base.setTimeout(180000);
  const profile = await mkdtemp(path.join(tmpdir(), 'local-asr-model-'));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'] });
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: bundle });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/extension/recorder.html`);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    const result = await page.evaluate(async () => {
      const { TabSession } = await import('./session.js');
      const { SpeechToTextNode } = await import('../web/transcription-nodes.js');
      const events = [], receiveEvent = SpeechToTextNode.prototype.receiveEvent;
      SpeechToTextNode.prototype.receiveEvent = function (event) {
        if (event.type === 'configuration') events.push(event);
        return receiveEvent.call(this, event);
      };
      const session = new TabSession(() => {}, { sourceFactory: (tabId, audio) => ({
        start() { audio(new Float32Array(16037)); }, stop() {},
      }) });
      try {
        await session.start(42);
        const graph = session.session?.pipeline;
        await session.stop();
        return { events, error: session.view.error || undefined,
          stopped: graph?.state === 'disposed' && session.view.state === 'idle' };
      } finally { session.cancel(); SpeechToTextNode.prototype.receiveEvent = receiveEvent; }
    });
    expect(result.error).toBeUndefined(); expect(result.stopped).toBe(true);
    expect(result.events).toContainEqual({ type: 'configuration', model: 'ja-en', modelName: 'ReazonSpeech ja-en', numThreads: 1 });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});
