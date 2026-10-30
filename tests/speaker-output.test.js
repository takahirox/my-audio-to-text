import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { SpeakerOutputNode, SPEAKER_LIMITS } from '../web/speaker-output.js';
import { speakerContext } from './fixtures/speaker-context.js';
import { GRAPH_VERSION, graphNode, edge, saveGraph, readGraph, assertGraph, NODE_TYPES } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { TabSession } from '../extension/session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const clip = (value, length = 24, sampleRate = 24000) => ({ samples: new Float32Array(length).fill(value), sampleRate, channels: 1 });
function fixture(options) {
  const audio = speakerContext(options), states = [];
  const node = new SpeakerOutputNode({ contextFactory: () => audio, onState: state => states.push(state) });
  const context = { signal: new AbortController().signal };
  node.enable(); node.start(context);
  return { audio, states, node, receive: value => node.receive('audio', value, context) };
}

test('Speaker serializes arrivals, snapshots native-rate PCM, drains Stop and releases every source', async () => {
  const f = fixture();
  const first = clip(.25), second = clip(.5, 44, 44100);
  f.receive(first); f.receive(second); f.receive(clip(.75));
  second.samples.fill(-1);
  assert.deepEqual(f.audio.played, [.25]);
  assert.equal(f.node.queue.length, 3);
  let stopped = false;
  const stopping = Promise.resolve(f.node.stop()).then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  f.audio.sources[0].end();
  assert.deepEqual(f.audio.played, [.25, .5]);
  assert.equal(f.audio.sources[1].buffer.sampleRate, 44100);
  f.audio.sources[0].end(); // Repeated end and later emissions never replay old clips.
  assert.deepEqual(f.audio.played, [.25, .5]);
  f.audio.sources[1].end(); f.audio.sources[2].end(); await stopping;
  assert.equal(f.node.bytes, 0); assert.equal(f.node.queue.length, 0);
  assert.ok(f.audio.sources.every(source => source.disconnects === 1 && source.buffer === null));
  await f.node.dispose(); await f.node.dispose(); assert.equal(f.audio.closes, 1);
});

test('Pipeline Stop accepts upstream final audio before draining Speaker; Cancel interrupts a drain', async () => {
  const audio = speakerContext(), speaker = new SpeakerOutputNode({ contextFactory: () => audio });
  let emitter;
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: { audio: SYNTHESIZED_AUDIO }, start(context) { emitter = context; },
      stop() { emitter.emit('audio', clip(.75)); } }, speaker,
  }, connections: [{ from: ['source', 'audio'], to: ['speaker', 'audio'] }] });
  await pipeline.start(); emitter.emit('audio', clip(.25)); emitter.emit('audio', clip(.5));
  const stopping = pipeline.stop(); await tick();
  assert.equal(speaker.queue.length, 3);
  audio.sources[0].end(); audio.sources[1].end(); audio.sources[2].end();
  await stopping; assert.equal(pipeline.state, 'stopped'); await pipeline.dispose();
  assert.deepEqual(audio.played, [.25, .5, .75]);

  const f = fixture(); f.receive(clip(.5)); f.receive(clip(.75));
  const lateEnd = f.audio.sources[0].onended, draining = f.node.stop();
  await f.node.cancel(); await draining;
  lateEnd(); f.receive(clip(1)); f.node.enable();
  assert.deepEqual(f.audio.played, [.5]); assert.equal(f.node.queue.length, 0);
  assert.equal(f.audio.sources[0].stops, 1); assert.equal(f.audio.closes, 1);
});

test('autoplay pending/rejection is actionable, retains accepted clips and recovers during Stop', async () => {
  const f = fixture({ state: 'suspended', holdResume: true });
  f.receive(clip(.25)); f.receive(clip(.5));
  assert.equal(f.states.at(-1).needsActivation, true);
  assert.match(f.states.at(-1).message, /Enable speaker/);
  assert.deepEqual(f.audio.played, []);
  const stopping = f.node.stop();
  f.audio.resume = function() { this.state = 'running'; this.onstatechange(); return Promise.resolve(); };
  f.node.enable(); f.audio.sources[0].end(); f.audio.sources[1].end(); await stopping;
  assert.deepEqual(f.audio.played, [.25, .5]); assert.equal(f.states.at(-1).needsActivation, false);
  await f.node.dispose(); f.audio.finishResume(); await tick(); assert.equal(f.audio.closes, 1);

  const denied = fixture({ state: 'suspended', resumeError: 'NotAllowedError' });
  await tick(); assert.match(denied.states.at(-1).message, /NotAllowedError.*Enable speaker/);
  denied.audio.onstatechange();
  assert.match(denied.states.at(-1).message, /NotAllowedError.*Enable speaker/);
  assert.equal(denied.states.at(-1).needsActivation, true); await denied.node.dispose();
});

test('missing output and buffer failures are visible and queued audio survives retry', async () => {
  const states = [], context = { signal: new AbortController().signal };
  let available = false;
  const audio = speakerContext();
  const node = new SpeakerOutputNode({ contextFactory: () => {
    if (!available) throw Error('No audio output device'); return audio;
  }, onState: state => states.push(state) });
  node.enable(); node.start(context); node.receive('audio', clip(.5), context);
  assert.match(states.at(-1).message, /No audio output device.*Enable speaker/);
  available = true; node.enable(); assert.deepEqual(audio.played, [.5]);
  audio.sources[0].end(); await node.dispose();

  const broken = fixture({ outputError: 'Output disconnected' });
  broken.receive(clip(.25)); assert.equal(broken.node.queue.length, 1);
  assert.match(broken.states.at(-1).message, /Output disconnected.*Enable speaker/);
  broken.audio.state = 'closed'; broken.audio.onstatechange();
  assert.match(broken.states.at(-1).message, /Cancel playback.*Start again/);
  assert.equal(broken.states.at(-1).needsActivation, false);
  await broken.node.dispose();
});

test('queue bounds report rejected clips explicitly and preserve accepted playback', async () => {
  const f = fixture();
  for (let i = 0; i < SPEAKER_LIMITS.clips + 2; i++) f.receive(clip(.5));
  assert.equal(f.node.queue.length, SPEAKER_LIMITS.clips);
  assert.match(f.states.at(-1).message, /2 clip\(s\) rejected.*Stop to drain/);
  for (let i = 0; i < SPEAKER_LIMITS.clips; i++) f.audio.sources[i].end();
  assert.equal(f.audio.played.length, SPEAKER_LIMITS.clips);
  assert.equal(f.node.bytes, 0); assert.equal(f.states.at(-1).overflow, true);
  f.receive(clip(.75)); assert.equal(f.node.rejected, 3); await f.node.dispose();
  for (const oversized of [clip(.5, SPEAKER_LIMITS.seconds + 1, 1), clip(.5, SPEAKER_LIMITS.bytes / 4 + 1, 192000)]) {
    const bounded = fixture(); bounded.receive(oversized);
    assert.equal(bounded.node.queue.length, 0); assert.equal(bounded.node.rejected, 1);
    assert.equal(bounded.node.bytes, 0); await bounded.node.dispose();
  }
});

function speakerGraph(type) {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode(type, 'tts'), graphNode('SpeakerOutput', 'speaker')],
    edges: [edge('text', 'value', 'tts', 'text'), edge('tts', 'audio', 'speaker', 'audio')] };
  graph.nodes[0].settings.value = 'Hello'; return graph;
}
for (const type of ['Supertonic3', 'Kokoro']) {
  test(`${type} connects to Speaker, validates and round-trips without altering existing AudioOutput graphs`, async () => {
    const graph = speakerGraph(type), store = new Map();
    const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) };
    saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
    assert.deepEqual(Object.keys(NODE_TYPES.SpeakerOutput.inputs), ['audio']);
    assert.deepEqual(NODE_TYPES.SpeakerOutput.outputs, {});
    const built = buildGraph(readGraph(storage), {});
    assert.ok(built.pipeline.entries.get('speaker').node instanceof SpeakerOutputNode);
    await built.pipeline.dispose();
    graph.nodes[2] = graphNode('AudioOutput', 'speaker');
    saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
    assert.equal(NODE_TYPES.AudioOutput.label, 'Audio player / WAV');
    graph.edges[1] = edge('text', 'value', 'speaker', 'audio');
    assert.throws(() => assertGraph(graph), /Incompatible/);
  });
}

test('Live requires Start for Speaker, unlocks before model awaits and owns fresh audio each session', async () => {
  const contexts = [];
  let inGesture = false;
  const session = new TabSession(() => {}, { graph: speakerGraph('Kokoro'),
    speakerContextFactory: () => { assert.equal(inGesture, true); const audio = speakerContext(); contexts.push(audio); return audio; },
    prepareTts: async () => {},
    ttsWorkerFactory: () => ({
      postMessage(data) { queueMicrotask(() => this.onmessage?.({ data: { id: data.id,
        type: { load: 'ready', generate: 'result', drain: 'drained' }[data.type], audio: clip(.5) } })); }, terminate() {},
    }),
  });
  await session.start(); assert.equal(session.session, undefined);
  assert.match(session.view.status, /Press Start/); assert.equal(contexts.length, 0);
  inGesture = true; const starting = session.start(undefined, { speakerGesture: true }); inGesture = false;
  assert.equal(contexts.length, 1); await starting; await tick();
  assert.deepEqual(contexts[0].played, [.5]);
  const stopping = session.stop(); await tick();
  assert.equal(session.view.state, 'stopping'); contexts[0].sources[0].end(); await stopping;
  assert.equal(contexts[0].closes, 1); assert.equal(session.view.state, 'idle');
  inGesture = true; const next = session.start(undefined, { speakerGesture: true }); inGesture = false;
  await next; await tick(); const old = session.session.speakers.get('speaker');
  await session.cancel(); assert.equal(contexts[1].closes, 1);
  old.receive('audio', clip(.75), { signal: new AbortController().signal });
  assert.deepEqual(contexts[1].played, [.5]);
});

test('Cancel during microphone permission releases the already unlocked speaker and ignores a late grant', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let grant, tracksStopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: {
    getUserMedia: () => new Promise(resolve => { grant = resolve; }),
  } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; });
  const graph = speakerGraph('Kokoro');
  graph.nodes.push(graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextReazonSpeech', 'asr'));
  graph.edges[0] = edge('asr', 'final', 'tts', 'text'); graph.edges.push(edge('mic', 'audio', 'asr', 'audio'));
  const audio = speakerContext();
  const session = new TabSession(() => {}, { graph, speakerContextFactory: () => audio });
  const starting = session.start(undefined, { microphoneGesture: true, speakerGesture: true });
  assert.equal(audio.resumes, 1); assert.equal(session.session.pipeline, undefined);
  await session.cancel(); assert.equal(audio.closes, 1);
  grant({ getTracks: () => [{ stop() { tracksStopped++; } }] }); await starting;
  assert.equal(tracksStopped, 1); assert.equal(session.session, null);
});
