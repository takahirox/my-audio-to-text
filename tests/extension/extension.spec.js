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
    await cp('extension', path.join(root, 'extension'), { recursive: true });
    await cp('web', path.join(root, 'web'), { recursive: true, filter: source => !/\/(vendor|tts-assets|correction-assets)(\/|$)/.test(source) });
    await cp('extension/manifest.json', path.join(root, 'manifest.json'));
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
      // loadUnpacked may return before the service worker registers onClicked.
      const worker = context.serviceWorkers().find(worker => worker.url().includes(id)) || await context.waitForEvent('serviceworker');
      await expect.poll(() => worker.evaluate(() => chrome.action.onClicked.hasListeners())).toBe(true);
      // These legacy capture/lifecycle cases intentionally use a migrated
      // transcription-only preference. Fresh-install graph behavior is covered
      // by graph.spec.js.
      await context.addInitScript(() => localStorage.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: 'ja-en' })));
      await use({ context, cdp, id, root, url: `chrome-extension://${id}/extension/recorder.html` });
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
  await page.goto(`${url}?tab=42`);
  await observePipeline(page, new URL('../web/', url).href);
  await page.evaluate(async () => {
    // Delay the current graph's committed TEXT path, not the retired accumulator.
    const { KeyedTextCoalesceNode } = await import('../web/keyed-text-coalesce-node.js');
    const receiveInputs = KeyedTextCoalesceNode.prototype.receiveInputs;
    KeyedTextCoalesceNode.prototype.receiveInputs = async function(values, context) {
      if (Object.hasOwn(values, 'input1') && window.holdTranscript) {
        window.heldTranscript = values.input1;
        await new Promise(resolve => { window.releaseTranscript = resolve; });
      }
      if (!context.signal.aborted) return receiveInputs.call(this, values, context);
    };
  });
  if (mode !== 'loading') {
    await expect(page.locator('#model-status')).toHaveText('Ready');
    expect(await page.evaluate(() => window.requests)).toEqual([]);
    await page.locator('#start').click();
  }
  return page;
}

async function released(page, count = 1, ready = true) {
  await expect.poll(() => page.evaluate(() => window.streams.map(s => s.stops))).toEqual(Array(count).fill(1));
  await expect.poll(() => page.evaluate(() => window.contexts.every(c => c.state === 'closed'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.streams.every(s => s.context.state === 'closed'))).toBe(true);
  if (ready) {
    await expect(page.locator('#model-status')).toHaveText('Ready');
    expect(await page.evaluate(() => window.workers.length - window.terminated)).toBe(2);
  } else expect(await page.evaluate(() => window.workers.length - window.terminated)).toBe(0);
}

for (const fallback of [false, true]) {
  test(`loadable MV3 extension uses real ${fallback ? 'fallback' : 'worklet'} audio, pipeline, provisional/final fallback, Stop and repeat`, async ({ extension }) => {
    const page = await setup(extension, { fallback });
    await expect(page.locator('#status')).toHaveText('Transcription active');
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
    expect(await graphTypes(page)).toEqual(['ExtensionTabAudioNode', 'SpeechToTextNode', 'KeyedTextCoalesceNode', 'KeyedTextPairNode', 'KeyedPairedTextAccumulatorNode', 'DisplayNode']);
    expect(await page.evaluate(() => window.requests)).toEqual([{ targetTabId: 42 }]);
    expect(await page.evaluate(() => window.mediaOptions.audio.mandatory)).toEqual({ chromeMediaSource: 'tab', chromeMediaSourceId: 'fixture-id' });
    expect(await page.evaluate(() => window.mediaOptions.video)).toBe(false);
    await expect(page.locator('#signal')).toHaveText('audio: Audio signal detected.');
    const inputs = await page.evaluate(() => window.inputs.filter(m => m.type === 'vad-audio'));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every(m => m.float32 && m.length <= 2048)).toBe(true);
    expect(inputs.some(m => Math.abs(m.last - 0.05) < 1e-5)).toBe(true);
    await page.locator('#stop').click();
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
     await released(page);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    await page.locator('#start').click();
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
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
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await page.evaluate(() => { window.holdTranscript = true; });
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => window.heldTranscript)).toBe('extension transcript');
  await expect(page.locator('#status')).toHaveText('Finalizing graph outputs…');
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => window.terminated)).toBe(0);
  await page.evaluate(() => window.releaseTranscript());
  await expect(page.locator('#status')).toContainText('Stopped');
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await released(page);
  expect(await page.evaluate(() => window.terminated)).toBe(2);
});

test('teardown while the transcript sink drains suppresses late output and releases workers', async ({ extension }) => {
  const page = await setup(extension);
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await page.evaluate(() => { window.holdTranscript = true; });
  await page.locator('#stop').click();
  await expect.poll(() => page.evaluate(() => !!window.releaseTranscript)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect(await page.evaluate(() => window.terminated)).toBe(2);
  await page.evaluate(() => window.releaseTranscript());
  await released(page, 1, false);
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await expect(page.locator('#errors')).toBeEmpty();
});

for (const action of ['navigate', 'close']) {
  test(`Live ${action} cancels held summary work and releases capture through pagehide`, async ({ extension }) => {
    await writeFile(path.join(extension.root, 'web/text-summary-worker.js'), `
      self.onmessage = ({data}) => {
        if (data.type === 'load') postMessage({type:'ready', id:data.id});
        // Deliberately never complete summarization: teardown must not drain it.
      };`);
    const observer = await extension.context.newPage(); await observer.goto(extension.url);
    await observer.evaluate(async () => {
      const { defaultGraph, graphNode, edge } = await import('./graph.js'); const { saveLiveGraphData } = await import('./graph-library.js');
      const graph = defaultGraph(), text = graphNode('Text', 'text'); text.settings.value = 'Held summary';
      graph.nodes.push(text, graphNode('TextSummaryLfm2', 'summary'), graphNode('Display', 'notes'));
      graph.edges.push(edge('text', 'value', 'summary', 'text'), edge('summary', 'summary', 'notes', 'input1'));
      await saveLiveGraphData(localStorage, graph);
    });
    const page = await setup(extension);
    await expect(page.locator('#cancel-session')).toHaveCount(0);
    await expect(page.locator('#status')).toHaveText('Transcription active');
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
    await expect(page.locator('#summary-status')).toContainText('summarizing text');
    await page.evaluate(() => {
      // Registered after the production pagehide handler: capture its effects
      // synchronously, before the document and its JS state disappear.
      addEventListener('pagehide', () => localStorage.setItem('live-teardown', JSON.stringify({
        terminated: window.terminated, stops: window.streams.map(s => s.stops),
        ended: window.streams.every(s => s.stream.getTracks().every(track => track.readyState === 'ended')),
        hooks: window.pipelineCalls.map(call => call.hook),
      })));
    });
    if (action === 'navigate') await page.goto(extension.url.replace('recorder.html', 'model-cache.html'));
    else await page.close();
    await expect.poll(() => observer.evaluate(() => JSON.parse(localStorage.getItem('live-teardown')))).toEqual({
      terminated: 3, stops: [1], ended: true, hooks: ['start', 'dispose'],
    });
  });
}

test('model preload progress and cancellation leave capture unrequested and retry available', async ({ extension }) => {
  const page = await setup(extension, { mode: 'loading' });
  await expect(page.locator('#model-status')).toContainText('Preparing models…');
  await expect(page.locator('#start')).toBeDisabled();
  await page.evaluate(() => window.workers[0].postMessage({ type: 'fixture-progress' }));
  await expect(page.locator('#model-status')).toContainText('Preparing models…');
  await expect(page.locator('#start')).toBeDisabled();
  expect(await page.evaluate(() => window.requests)).toEqual([]);
  await page.locator('#stop').click();
  await expect(page.locator('#model-status')).toContainText('Preparation canceled');
  expect(await page.evaluate(() => window.terminated)).toBe(2);
  expect(await page.evaluate(() => window.requests)).toEqual([]);
  expect(await page.evaluate(() => window.pipelineCalls)).toEqual([{ hook: 'dispose', id: 0 }]);
  await page.evaluate(() => { window.holdLoad = false; });
  await page.locator('#retry-models').click();
  await expect(page.locator('#model-status')).toHaveText('Ready');
  await page.locator('#start').click();
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await page.locator('#stop').click();
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await released(page);
  await expect(page.locator('#errors')).toBeEmpty();
});

for (const phase of ['loading', 'running']) {
  test(`worker failure during ${phase} reports locally and permits retry`, async ({ extension }) => {
    const page = await setup(extension, { mode: phase === 'loading' ? 'loading' : 'audio' });
    await expect.poll(() => page.evaluate(() => window.workers.length)).toBe(2);
    if (phase === 'running') await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
    await page.evaluate(() => window.workers[0].postMessage({ type: 'fixture-error' }));
    await expect(page.locator('#errors')).toContainText('Controlled worker failure');
    if (phase === 'running') {
      await expect(page.locator('#status')).toHaveText('Transcription active');
      await page.locator('#stop').click();
    }
    if (phase === 'running') await released(page);
    else {
      await expect(page.locator('#start')).toBeDisabled();
      expect(await page.evaluate(() => window.requests)).toEqual([]);
    }
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    await page.evaluate(() => { window.holdLoad = false; });
    if (phase === 'loading') await page.locator('#retry-models').click();
    await expect(page.locator('#start')).toBeEnabled();
    await page.locator('#start').click();
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
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
    await expect.poll(() => page.evaluate(() => window.contexts.every(c => c.state === 'closed'))).toBe(true);
    expect(await page.evaluate(() => window.terminated)).toBe(2);
    expect(await page.evaluate(() => window.inputs)).toEqual([]);
  });
}

for (const reason of ['track', 'removed', 'updated']) {
  test(`${reason} ending the tab finalizes and releases the extension`, async ({ extension }) => {
    const page = await setup(extension);
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
    await page.evaluate(reason => {
      if (reason === 'track') window.streams[0].stream.getAudioTracks()[0].onended();
      else if (reason === 'removed') window.removed(42);
      else window.updated(42, { status: 'loading' });
    }, reason);
    await expect(page.locator('#status')).toContainText('Stopped');
    await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript'); await released(page);
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
  await page.evaluate(() => window.grant()); await released(page, 1, false);
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
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await page.evaluate(() => window.oldGrant());
  await expect.poll(() => page.evaluate(() => window.streams.map(s => s.stops))).toEqual([0, 1]);
  await expect(page.locator('#status')).toHaveText('Transcription active');
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
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
  await expect(recorder.locator('#start')).toBeEnabled();
  await recorder.locator('#start').click();
  await expect(recorder.locator('#status')).toContainText('Transcription failed');
  await expect(recorder.locator('#errors')).toContainText(/invoked|permission|capture/i);
  await expect(recorder.locator('#start')).toBeEnabled();
  expect(await recorder.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).length)).toBe(0);
});

test('real toolbar actions open independent windows with simultaneous native tab captures and scoped cleanup', async ({ extension }) => {
  const { context, cdp, id } = extension;
  await context.route('https://meeting.test/**', route => route.fulfill({ contentType: 'text/html', body: `
    <button id="play">Play controlled tab audio</button>
    <script>document.querySelector('#play').onclick = () => {
      const audio = new AudioContext(), oscillator = audio.createOscillator(), gain = audio.createGain();
      oscillator.frequency.value = 440; gain.gain.value = 0.05;
      oscillator.connect(gain); gain.connect(audio.destination); oscillator.start(); audio.resume();
    };</script>` }));
  const worker = context.serviceWorkers().find(worker => worker.url().includes(id));
  const captured = () => worker.evaluate(async () => (await chrome.tabCapture.getCapturedTabs()).filter(tab => tab.status === 'active').map(tab => tab.tabId));
  const launch = async tab => {
    await tab.bringToFront();
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }] });
    const opened = context.waitForEvent('page', { predicate: page => page.url().includes('recorder.html') });
    await cdp.send('Extensions.triggerAction', { id, targetId: targetInfos.find(info => info.url === tab.url()).targetId });
    const live = await opened;
    await expect(live.locator('#start')).toBeEnabled();
    await expect(live.locator('#session-state')).toHaveText('Idle');
    return live;
  };
  const tabs = [], windows = [];
  for (let index = 0; index < 3; index++) {
    const tab = await context.newPage(); await tab.goto(`https://meeting.test/${index}`); await tab.locator('#play').click(); tabs.push(tab);
    const live = await launch(tab); windows.push(live);
    expect(await captured()).toHaveLength(index);
    await live.locator('#start').click();
    await expect(live.locator('#status')).toHaveText('Transcription active');
    await expect(live.locator('#signal')).toHaveText('audio: Audio signal detected.');
  }
  expect(await captured()).toHaveLength(3);
  const windowIds = await Promise.all(windows.map(page => page.evaluate(async () => (await chrome.windows.getCurrent()).id)));
  expect(new Set(windowIds).size).toBe(3);
  await windows[1].locator('#stop').click(); await expect.poll(async () => (await captured()).length).toBe(2);
  await expect(windows[0].locator('#status')).toHaveText('Transcription active');
  await expect(windows[2].locator('#status')).toHaveText('Transcription active');
  await windows[0].close(); await expect.poll(async () => (await captured()).length).toBe(1);
  await expect(windows[2].locator('#status')).toHaveText('Transcription active');
  await tabs[2].goto('https://meeting.test/navigated');
  await expect(windows[2].locator('#status')).toContainText('Stopped');
  await expect.poll(async () => (await captured()).length).toBe(0);
  const repeated = await launch(tabs[1]);
  expect(context.pages().filter(page => page.url().includes('recorder.html'))).toHaveLength(3);
  await repeated.locator('#start').click(); await expect(repeated.locator('#status')).toHaveText('Transcription active');
  await tabs[1].close(); await expect(repeated.locator('#status')).toContainText('Stopped');
  await expect.poll(async () => (await captured()).length).toBe(0);
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
    await page.goto(`chrome-extension://${id}/extension/model-cache.html`);
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
        await session.prepareModels();
        if (session.view.modelState !== 'ready') throw Error(session.view.error);
        const warm = session.prepared.pipeline;
        await session.start(42);
        if (session.session.pipeline !== warm) throw Error('Start replaced the prepared graph');
        const graph = session.session?.pipeline;
        await session.stop();
        return { events, error: session.view.error || undefined,
          stopped: graph?.state === 'disposed' && session.view.state === 'idle' && session.view.modelState === 'ready' };
      } finally { await session.close(); SpeechToTextNode.prototype.receiveEvent = receiveEvent; }
    });
    expect(result.error).toBeUndefined(); expect(result.stopped).toBe(true);
    expect(result.events).toContainEqual({ type: 'configuration', model: 'ja-en', modelName: 'ReazonSpeech ja-en', numThreads: 1 });
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('Live navigation opens separate extension pages without stopping or retargeting active native audio', async ({ extension }) => {
  const page = await setup(extension);
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await page.setViewportSize({ width: 440, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const [name, file] of [['Graph', 'graph-editor.html'], ['Models', 'model-cache.html']]) {
    const [opened] = await Promise.all([extension.context.waitForEvent('page'), page.getByRole('link', { name, exact: true }).click()]);
    await opened.waitForURL(url => url.pathname === `/extension/${file}`);
    if (name === 'Graph') {
      expect(new URL(opened.url()).searchParams.get('id')).toBe('default-live');
      await expect(opened.getByRole('heading', { name: 'Graph Editor Live transcription', exact: true })).toBeVisible();
    } else await expect(opened.getByRole('heading', { name, exact: true })).toBeVisible();
    await opened.getByRole('button', { name: 'Live' }).click();
    await expect(page.locator('#status')).toHaveText('Transcription active');
    expect(await page.evaluate(() => window.requests)).toEqual([{ targetTabId: 42 }]);
    expect(await page.evaluate(() => window.streams.map(s => s.stops))).toEqual([0]);
    expect(await page.evaluate(() => window.contexts.every(c => c.state === 'running'))).toBe(true);
    await opened.close();
  }
  await page.locator('#stop').click(); await expect(page.locator('#start')).toBeEnabled(); await released(page);
  await expect(page.locator('[data-display="transcript"] .display-content')).toHaveText('extension transcript');
  await expect(page.locator('.live-text-region h2, .live-text-region button, .live-text-region [role="status"]')).toHaveCount(0);
});
