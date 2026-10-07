import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { BrowserTab, Microphone, Resampler, joinAudio } from '../web/audio.js';
import { LocalAsrCore } from '../web/local-asr-core.js';
import { ExtensionTab } from '../extension/tab-source.js';
import { Pipeline } from '../web/pipeline.js';
import { createTabTranscriptionPipeline, MicrophoneAudioNode, SpeechToTextNode, TranscriptOutputNode } from '../web/transcription-nodes.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Run the production capture processor against controlled browser API fixtures.
function browser(t, { rate = 48000, worklet = true, permission, module } = {}) {
  const tracks = ['audio', 'video'].map(kind => ({
    kind, readyState: 'live', stops: 0, onended: null,
    stop() { this.stops++; this.readyState = 'ended'; },
    getSettings: () => ({ channelCount: 2 }),
  }));
  const media = { getTracks: () => tracks, getAudioTracks: () => tracks.filter(t => t.kind === 'audio') };
  const requests = [], contexts = [];
  const node = () => ({ connections: [], connect(target) { this.connections.push(target); }, disconnect() { this.disconnected = true; } });
  let Processor;
  runInNewContext(readFileSync(new URL('../web/capture-worklet.js', import.meta.url), 'utf8'), {
    Float32Array,
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor(name, cls) { assert.equal(name, 'capture'); Processor = cls; },
  });
  const globals = {
    navigator: { mediaDevices: Object.fromEntries(['getDisplayMedia', 'getUserMedia'].map(api => [api, options => {
      requests.push({ api, options }); return permission || Promise.resolve(media);
    }])) },
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    AudioContext: class {
      constructor() {
        this.sampleRate = rate; this.state = 'running'; this.destination = {};
        this.audioWorklet = worklet ? { addModule: () => module || Promise.resolve() } : null;
        contexts.push(this);
      }
      resume() { return Promise.resolve(); }
      close() { this.state = 'closed'; this.closes = (this.closes || 0) + 1; return Promise.resolve(); }
      createMediaStreamSource(stream) { this.stream = stream; return node(); }
      createGain() { return { ...node(), gain: { value: 1 } }; }
      createScriptProcessor() { return node(); }
    },
    AudioWorkletNode: class {
      constructor() {
        Object.assign(this, node()); this.processor = new Processor();
        this.port = { postMessage: data => this.processor.port.onmessage({ data }) };
        this.processor.port.postMessage = data => this.port.onmessage?.({ data });
      }
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true });
    t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  }
  return { tracks, media, requests, contexts };
}

for (const kind of ['tab', 'microphone']) for (const rate of [16000, 44100, 48000]) {
  test(`Node pipeline composes real ${kind} capture/resampling, ASR and async output at ${rate} Hz`, async t => {
    const b = browser(t, { rate }), values = [], workers = [], pcm = [];
    const options = {
      onTranscript: async (port, value) => { await Promise.resolve(); values.push([port, value]); },
      workerFactory(path) {
        const worker = { terminated: false,
          postMessage(message, transfer = []) {
            const data = structuredClone(message, { transfer });
            queueMicrotask(() => {
              if (data.type === 'load') this.onmessage({ data: { type: 'ready' } });
              if (data.type === 'vad-audio') {
                pcm.push(data.audio);
                this.onmessage({ data: { type: 'vad', session: data.session,
                  frames: [{ audio: data.audio, speaking: true }] } });
              }
              if (data.type === 'vad-stop') this.onmessage({ data: { type: 'vad-stopped', session: data.session } });
              if (data.type === 'decode') {
                this.onmessage({ data: { type: data.final ? 'final' : 'partial', session: data.session,
                  id: data.id, text: data.final ? 'committed' : 'provisional' } });
                this.onmessage({ data: { type: 'decoded', session: data.session } });
              }
            });
          },
          terminate() { this.terminated = true; },
        };
        workers.push(worker); return worker;
      },
    };
    let flow;
    if (kind === 'tab') flow = createTabTranscriptionPipeline(options);
    else {
      const source = new MicrophoneAudioNode();
      const speech = new SpeechToTextNode(options), transcript = new TranscriptOutputNode(options.onTranscript);
      flow = { source, speech, transcript, pipeline: new Pipeline({ nodes: { source, speech, transcript }, connections: [
        { from: ['source', 'audio'], to: ['speech', 'audio'] },
        { from: ['speech', 'provisional'], to: ['transcript', 'provisional'] },
        { from: ['speech', 'final'], to: ['transcript', 'final'] },
      ] }) };
    }
    await flow.pipeline.start();
    assert.equal(b.requests[0].api, kind === 'tab' ? 'getDisplayMedia' : 'getUserMedia');
    for (let offset = 0; offset < rate + 37; offset += 128) {
      const count = Math.min(128, rate + 37 - offset);
      (flow.source || flow.tab).source.node.processor.process([[new Float32Array(count).fill(0.02), new Float32Array(count).fill(0.08)]]);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(values.some(([port]) => port === 'provisional'));
    await flow.pipeline.stop();
    const actual = joinAudio(pcm), resampler = new Resampler(rate);
    const expected = joinAudio([resampler.push(new Float32Array(rate + 37).fill(0.05)), resampler.flush()]);
    assert.equal(actual.length, expected.length);
    assert.ok(actual.every((sample, i) => Math.abs(sample - expected[i]) < 1e-6));
    assert.deepEqual(values.filter(([port]) => port === 'final'), [['final', { text: 'committed', id: 1 }]]);
    assert.ok(b.tracks.every(track => track.stops === 1));
    assert.equal(b.contexts[0].state, 'closed');
    await flow.pipeline.dispose(); assert.ok(workers.every(worker => worker.terminated));
  });
}

for (const rate of [16000, 44100, 48000]) {
  test(`tab stereo PCM at ${rate} Hz produces provisional/final events and flushes every tail sample`, async t => {
    const b = browser(t, { rate }), events = [], messages = [], workers = [];
    const core = new LocalAsrCore(event => events.push(event), { workerFactory() {
      const worker = {
        postMessage(message, transfer = []) { messages.push({ worker, ...structuredClone(message, { transfer }) }); },
        terminate() {}, reply(data) { this.onmessage({ data }); },
      };
      workers.push(worker); return worker;
    } });
    core.load(); const [asr, vad] = workers;
    asr.reply({ type: 'ready' }); vad.reply({ type: 'ready' }); core.start();
    let classified = 0;
    const classify = () => {
      const inputs = messages.filter(m => m.type === 'vad-audio');
      for (const message of inputs.slice(classified)) {
        vad.reply({ type: 'vad', session: message.session, frames: [{ audio: message.audio, speaking: true }] });
      }
      classified = inputs.length;
    };
    const source = new BrowserTab(pcm => { core.push(pcm); classify(); });
    await source.start();
    assert.equal(b.requests[0].api, 'getDisplayMedia');
    assert.equal(b.requests[0].options.audio, true);
    assert.deepEqual(b.contexts[0].stream.tracks, [b.tracks[0]]);
    assert.equal(source.gain.gain.value, 0);
    const length = rate + 1;
    for (let offset = 0; offset < length; offset += 128) {
      const count = Math.min(128, length - offset);
      source.node.processor.process([[new Float32Array(count).fill(0.02), new Float32Array(count).fill(0.08)]]);
    }
    const reply = message => {
      asr.reply({ type: message.final ? 'final' : 'partial', text: 'controlled transcript', id: message.id, session: message.session });
      asr.reply({ type: 'decoded', session: message.session });
    };
    let decoded = 0;
    while (messages.filter(m => m.type === 'decode').length > decoded) reply(messages.filter(m => m.type === 'decode')[decoded++]);
    assert.ok(events.some(e => e.type === 'partial'));
    await source.stop();
    const actual = joinAudio(messages.filter(m => m.type === 'vad-audio').map(m => m.audio));
    assert.ok(Math.abs(actual.length - length * 16000 / rate) <= 1);
    assert.ok(actual.every(sample => Math.abs(sample - 0.05) < 1e-6), 'stereo channels must be averaged');
    const resampler = new Resampler(rate);
    const expected = joinAudio([resampler.push(new Float32Array(length).fill(0.05)), resampler.flush()]);
    assert.equal(actual.length, expected.length);
    assert.ok(actual.every((sample, i) => Math.abs(sample - expected[i]) < 1e-6));
    assert.equal(resampler.flush().length, 0);
    core.stop(); vad.reply({ type: 'vad-stopped', session: core.session });
    while (messages.filter(m => m.type === 'decode').length > decoded) reply(messages.filter(m => m.type === 'decode')[decoded++]);
    const final = messages.find(m => m.type === 'decode' && m.final);
    assert.deepEqual(final.audio, actual);
    assert.equal(events.filter(e => e.type === 'final').length, 1);
    assert.equal(events.filter(e => e.type === 'stopped').length, 1);
    assert.ok(b.tracks.every(track => track.stops === 1 && track.onended === null));
    assert.equal(b.contexts[0].state, 'closed');
    core.release();
  });
}

test('ScriptProcessor fallback averages stereo and microphone retains its permission constraints', async t => {
  const b = browser(t, { rate: 16000, worklet: false }), chunks = [];
  const source = new Microphone(chunk => chunks.push(chunk)); await source.start();
  assert.deepEqual(b.requests[0], { api: 'getUserMedia', options: { audio: {
    channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  } } });
  source.node.onaudioprocess({ inputBuffer: { length: 37, numberOfChannels: 2,
    getChannelData: channel => new Float32Array(37).fill(channel ? 0.08 : 0.02),
  } });
  await source.stop();
  const actual = joinAudio(chunks);
  assert.equal(actual.length, 37);
  assert.ok(actual.every(sample => Math.abs(sample - 0.05) < 1e-6));
  assert.equal(source.node.onaudioprocess, null);
  assert.equal(b.contexts[0].closes, 1);
});

for (const phase of ['permission', 'module']) {
  test(`Cancel during ${phase} setup closes context and stops late tracks without creating nodes`, async t => {
    const gate = deferred(), b = browser(t, { [phase]: gate.promise });
    const source = new BrowserTab(() => assert.fail('canceled audio'));
    const starting = source.start();
    // Let permission resolve before blocking worklet initialization.
    await Promise.resolve(); await Promise.resolve();
    await source.stop(false);
    gate.resolve(phase === 'permission' ? b.media : undefined);
    await assert.rejects(starting, { name: 'AbortError' });
    assert.ok(b.tracks.every(track => track.stops === 1));
    assert.equal(source.node, undefined);
    assert.equal(b.contexts[0].closes, 1);
  });
}

test('sharing end during setup cleans up without completing capture', async t => {
  const gate = deferred(), b = browser(t, { module: gate.promise });
  const source = new BrowserTab(() => assert.fail('ended audio'), () => { void source.stop(); });
  const starting = source.start();
  await Promise.resolve(); await Promise.resolve();
  b.tracks[1].onended(); gate.resolve();
  await assert.rejects(starting, { name: 'AbortError' });
  assert.ok(b.tracks.every(track => track.stops === 1));
  assert.equal(b.contexts[0].state, 'closed');
  assert.equal(source.node, undefined);
});

test('Cancel during a held Stop discards tail and disconnects immediately', async t => {
  const b = browser(t), chunks = [], source = new BrowserTab(chunk => chunks.push(chunk));
  await source.start();
  source.node.processor.process([[new Float32Array(37).fill(0.05)]]);
  // Simulate a worklet that has not delivered the flush acknowledgment yet.
  source.node.port.postMessage = () => {};
  const stopping = source.stop();
  await source.stop(false); await stopping;
  assert.equal(chunks.length, 0);
  assert.equal(source.node.port.onmessage, null);
  assert.ok(source.node.disconnected && source.source.disconnected && source.gain.disconnected);
  assert.equal(b.contexts[0].closes, 1);
  assert.ok(b.tracks.every(track => track.stops === 1));
});

test('worklet setup errors release all allocated capture resources', async t => {
  const b = browser(t, { module: Promise.reject(new Error('worklet failed')) });
  const source = new BrowserTab(() => assert.fail('failed audio'));
  await assert.rejects(source.start(), /worklet failed/);
  assert.ok(b.tracks.every(track => track.stops === 1));
  assert.equal(b.contexts[0].state, 'closed');
  assert.ok(source.source.disconnected);
});

for (const rate of [16000, 44100, 48000]) {
  test(`extension capture at ${rate} Hz shares mono resampling and restores playback once`, async t => {
    const b = browser(t, { rate }), chunks = [], ids = [];
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { tabCapture: {
      getMediaStreamId: async options => { ids.push(options); return 'single-use-id'; },
    } } });
    t.after(() => delete globalThis.chrome);
    const source = new ExtensionTab(42, chunk => chunks.push(chunk));
    await source.start();
    assert.deepEqual(ids, [{ targetTabId: 42 }]);
    assert.deepEqual(b.requests, [{ api: 'getUserMedia', options: { audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'single-use-id' },
    }, video: false } }]);
    assert.ok(source.workletURL.endsWith('/web/capture-worklet.js'));
    assert.deepEqual(source.source.connections, [source.node, source.context.destination]);
    assert.equal(source.gain.gain.value, 0);
    for (let offset = 0; offset < rate; offset += 128) {
      const length = Math.min(128, rate - offset);
      source.node.processor.process([[new Float32Array(length).fill(0.02), new Float32Array(length).fill(0.08)]]);
    }
    await source.stop();
    const audio = joinAudio(chunks);
    assert.ok(Math.abs(audio.length - 16000) <= 1);
    assert.ok(audio.every(sample => Math.abs(sample - 0.05) < 1e-6));
    assert.ok(source.source.disconnected && source.node.disconnected);
    assert.ok(b.tracks.every(track => track.stops === 1));
    assert.equal(b.contexts[0].state, 'closed');
  });
}

for (const mode of ['api-error', 'no-audio', 'unavailable']) {
  test(`extension ${mode} fails clearly and releases resources`, async t => {
    const b = browser(t);
    if (mode === 'no-audio') b.media.getAudioTracks = () => [];
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: mode === 'unavailable' ? {} : {
      tabCapture: { getMediaStreamId: async () => {
        if (mode === 'api-error') throw new Error('Cannot capture this tab');
        return 'id';
      } },
    } });
    t.after(() => delete globalThis.chrome);
    const source = new ExtensionTab(42, () => assert.fail('failed audio'));
    await assert.rejects(source.start(), mode === 'api-error' ? /Cannot capture/ : mode === 'no-audio' ? /No tab audio/ : /unavailable/);
    assert.equal(b.contexts[0].state, 'closed');
    if (mode === 'no-audio') assert.ok(b.tracks.every(track => track.stops === 1));
    else assert.equal(b.requests.length, 0);
  });
}
