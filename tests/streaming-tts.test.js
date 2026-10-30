import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/translation-nodes.js';
import { AUDIO_STREAM, validateAudioStream } from '../web/audio-stream.js';
import { Qwen3TtsNode, QWEN3_TTS_LIMITS } from '../web/qwen3-tts-node.js';
import { StreamingSpeakerOutputNode, STREAM_SPEAKER_LIMITS } from '../web/speaker-output.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { GRAPH_VERSION, NODE_TYPES, graphNode, edge, saveGraph, readGraph, assertGraph, executableGraph } from '../extension/graph.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { TabSession } from '../extension/session.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const begin = (id = 1, sampleRate = 24000) => ({ type: 'start', id, sampleRate, channels: 1 });
const chunk = (sequence = 0, id = 1, length = 2400) => ({ type: 'chunk', id, sequence, samples: new Float32Array(length).fill(.25) });
const end = (sequence = 1, id = 1) => ({ type: 'end', id, sequence });

function fixture({ suspended = false } = {}) {
  const sources = [], states = [], controller = new AbortController();
  const audio = { currentTime: 1, state: suspended ? 'suspended' : 'running', destination: {}, closes: 0,
    resume() { return Promise.resolve(); },
    createBuffer(channels, length, sampleRate) {
      return { channels, length, sampleRate, duration: length / sampleRate, copyToChannel(samples) { this.samples = samples.slice(); } };
    },
    createBufferSource() {
      const source = { stops: 0, disconnects: 0, connect() {}, start(at) { this.at = at; },
        stop() { this.stops++; }, disconnect() { this.disconnects++; }, end() { this.onended?.(); } };
      sources.push(source); return source;
    },
    close() { this.state = 'closed'; this.closes++; return Promise.resolve(); },
  };
  const node = new StreamingSpeakerOutputNode({ contextFactory: () => audio, onState: state => states.push(state) });
  node.enable(); node.start({ signal: controller.signal });
  return { node, audio, sources, states, controller, send: event => node.receive('stream', event, { signal: controller.signal }) };
}

test('stream contract rejects malformed PCM, rates, boundaries and mixing with completed clips', () => {
  for (const value of [null, begin(0), begin(1, 0), { ...begin(), channels: 2 }, { ...chunk(), sequence: -1 },
    { ...chunk(), samples: new Float32Array() }, { ...chunk(), samples: new Float32Array([NaN]) },
    { ...chunk(), samples: [1] }, { ...end(), type: 'unknown' }, { ...end(), type: 'abort' }]) assert.throws(() => validateAudioStream(value));
  assert.equal(validateAudioStream(begin()).sampleRate, 24000);
  assert.notEqual(AUDIO_STREAM, SYNTHESIZED_AUDIO);
  assert.throws(() => new Pipeline({ nodes: { source: { outputs: { audio: SYNTHESIZED_AUDIO } }, sink: new StreamingSpeakerOutputNode() },
    connections: [{ from: ['source', 'audio'], to: ['sink', 'stream'] }] }), /Incompatible/);
});

test('streaming speaker schedules gapless ordered native-rate chunks before end, snapshots PCM and drains Stop', async () => {
  const f = fixture(); f.send(begin()); const pcm = chunk(); f.send(pcm); pcm.samples.fill(-1);
  assert.equal(f.sources.length, 1); assert.equal(f.node.active.id, 1);
  f.send(chunk(1)); f.send(end(2)); f.send(begin(2, 48000)); f.send(chunk(0, 2, 4800)); f.send(end(1, 2));
  assert.deepEqual(f.sources.map(source => source.at), [1.04, 1.1400000000000001, 1.2400000000000002]);
  assert.equal(f.sources[0].buffer.samples[0], .25); assert.equal(f.sources[2].buffer.sampleRate, 48000);
  let stopped = false; const stop = Promise.resolve(f.node.stop()).then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  for (const source of f.sources) source.end(); await stop;
  assert.equal(f.node.bytes, 0); assert.equal(f.node.queue.length, 0);
  assert.ok(f.sources.every(source => source.disconnects === 1 && source.buffer === null));
  await f.node.dispose(); assert.equal(f.audio.closes, 1);
});

test('streaming speaker rejects replay, missing end, wrong utterance, skips and repeated chunks', async () => {
  for (const events of [[chunk()], [begin(), begin(2)], [begin(), chunk(1)], [begin(), chunk(0, 2)],
    [begin(), chunk(), chunk()], [begin(), end(0), begin()], [begin(), end(0), end(0)]]) {
    const f = fixture(); for (const event of events.slice(0, -1)) f.send(event);
    assert.throws(() => f.send(events.at(-1)), /stream|sequence/i); await f.node.dispose();
  }
  const f = fixture(); f.send(begin()); assert.throws(() => f.node.stop(), /without an end/); await f.node.dispose();
});

test('streaming autoplay pause retains accepted PCM, resumes during Stop, and reports underruns only after starvation', async () => {
  const f = fixture({ suspended: true }); f.send(begin()); f.send(chunk()); f.send(chunk(1)); f.send(end(2));
  assert.equal(f.sources.length, 0); assert.equal(f.states.at(-1).needsActivation, true);
  const stop = f.node.stop(); f.audio.state = 'running'; f.audio.onstatechange();
  assert.equal(f.sources.length, 2); for (const source of f.sources) source.end(); await stop;
  await f.node.dispose();
  const live = fixture(); live.send(begin()); live.send(chunk()); live.audio.currentTime = 3; live.sources[0].end();
  live.send(chunk(1)); assert.equal(live.node.underruns, 1); assert.equal(live.sources[1].at, 3.04);
  await live.node.dispose();
});

test('streaming queue limits reject further audio visibly while Stop drains every accepted chunk', async () => {
  for (const size of [24000, 24]) {
    const f = fixture({ suspended: true }); f.send(begin());
    for (let i = 0; i < STREAM_SPEAKER_LIMITS.chunks + 2; i++) f.send(chunk(i, 1, size));
    assert.equal(f.node.queue.length, size === 24000 ? STREAM_SPEAKER_LIMITS.seconds : STREAM_SPEAKER_LIMITS.chunks);
    assert.equal(f.node.rejected, 1); assert.match(f.states.at(-1).message, /queue full.*Stop drains/i);
    const stop = f.node.stop(); f.audio.state = 'running'; f.node.enable();
    const count = f.sources.length; for (const source of f.sources) source.end(); await stop;
    assert.equal(count, size === 24000 ? 8 : 64); assert.equal(f.node.bytes, 0); await f.node.dispose();
  }
});

test('abort removes only the current utterance; Cancel stops scheduled audio and late callbacks cannot restart it', async () => {
  const f = fixture(); f.send(begin()); f.send(chunk()); f.send(end());
  f.send(begin(2)); f.send(chunk(0, 2)); f.send(chunk(1, 2));
  f.send({ type: 'abort', id: 2, sequence: 2, message: 'GPU lost' });
  assert.deepEqual(f.sources.map(source => source.stops), [0, 1, 1]); assert.equal(f.node.queue.length, 1);
  f.send(begin(3)); f.send(chunk(0, 3)); f.send(end(1, 3));
  assert.equal(f.sources[3].at, f.sources[0].at + .1);
  const late = f.sources[3].onended, stop = f.node.stop();
  f.controller.abort(); await stop; late(); f.send(begin(4)); f.node.enable();
  assert.equal(f.sources.length, 4); assert.equal(f.audio.closes, 1); assert.equal(f.node.bytes, 0);
});

test('abort after overflow removes the failed utterance while retaining earlier audio', async () => {
  for (const suspended of [false, true]) {
    for (const earlier of [false, true]) {
      const f = fixture({ suspended });
      if (earlier) { f.send(begin()); f.send(chunk(0, 1, 24000)); f.send(end()); }
      const id = earlier ? 2 : 1;
      f.send(begin(id));
      for (let sequence = 0; sequence < 9; sequence++) f.send(chunk(sequence, id, 24000));
      assert.equal(f.node.rejected, 1); assert.equal(f.node.seconds, 8);
      const late = f.sources.at(-1)?.onended;
      f.send({ type: 'abort', id, sequence: 9, message: 'GPU lost after overflow' });
      assert.equal(f.node.active, null);
      assert.equal(f.node.queue.length, earlier ? 1 : 0);
      assert.equal(f.node.seconds, earlier ? 1 : 0);
      assert.equal(f.node.bytes, earlier ? 24000 * 4 : 0);
      assert.ok(f.node.queue.every(item => item.id === 1));
      assert.ok(f.sources.slice(earlier ? 1 : 0).every(source =>
        source.stops === 1 && source.disconnects === 1 && source.buffer === null));
      if (earlier && !suspended) assert.equal(f.sources[0].stops, 0);
      late?.(); // A retired callback must not replay removed chunks.
      f.send(begin(id + 1)); f.send(chunk(0, id + 1));
      assert.equal(f.node.queue.length, earlier ? 1 : 0);
      const stop = f.node.stop();
      f.audio.state = 'running'; f.node.enable();
      for (const source of f.sources) source.end();
      await stop;
      assert.equal(f.sources.length, suspended ? Number(earlier) : 8);
      assert.equal(f.node.bytes, 0); assert.equal(f.node.seconds, 0);
      await f.node.dispose();
    }
  }
});

function workerFixture() {
  const messages = [], events = [], emitted = [], failures = [], controller = new AbortController();
  const worker = { postMessage(message) { messages.push(message); }, terminate() { this.terminated = true; } };
  const node = new Qwen3TtsNode({ workerFactory: () => worker, onEvent: event => events.push(event) });
  const context = { signal: controller.signal, emit(port, value) { emitted.push([port, value]); }, fail(error) { failures.push(error); } };
  const start = node.start(context); worker.onmessage({ data: { type: 'ready' } });
  return { node, worker, messages, events, emitted, failures, controller, context, start,
    reply(data) { worker.onmessage({ data }); }, receive(text) { node.receive('text', text, context); } };
}

test('Qwen Worker ownership serializes repeated committed utterances, acknowledges chunks, and Stop waits for final boundaries', async () => {
  const f = workerFixture(); await f.start; f.receive('Same text'); f.receive('Same text');
  assert.deepEqual(f.messages.map(message => message.type), ['load', 'generate']);
  f.reply(begin()); f.reply(chunk()); assert.equal(f.emitted.length, 2);
  assert.deepEqual(f.messages.at(-1), { type: 'ack', id: 1, sequence: 0 });
  let done = false; const stop = f.node.stop().then(() => { done = true; }); await tick(); assert.equal(done, false);
  f.reply(end()); assert.equal(f.messages.at(-1).id, 2); assert.equal(f.messages.at(-1).text, 'Same text');
  f.reply(chunk(0, 1)); assert.equal(f.emitted.length, 3); // late retired reply is ignored
  f.reply({ type: 'error', id: 1, message: 'Retired failure' }); assert.equal(f.failures.length, 0);
  f.reply(begin(2)); f.reply(chunk(0, 2)); f.reply(end(1, 2)); await stop;
  assert.equal(f.node.characters, 0); assert.equal(f.failures.length, 0); f.node.dispose();
});

test('Qwen text queue is bounded, provisional text is rejected and oversize input never reaches the Worker', async () => {
  const f = workerFixture(); await f.start;
  for (const provisional of [true, false]) {
    const invalid = workerFixture(); await invalid.start; invalid.receive('In progress'); invalid.reply(begin()); invalid.reply(chunk());
    assert.throws(() => invalid.node.receive('text', provisional ? 'revision' : 'x'.repeat(301), { ...invalid.context, provisional }), provisional ? /committed/ : /300/);
    assert.equal(invalid.worker.terminated, true); assert.equal(invalid.emitted.at(-1)[1].type, 'abort');
  }
  for (let i = 0; i < QWEN3_TTS_LIMITS.utterances + 2; i++) f.receive('Accepted speech');
  assert.equal(f.node.queue.length + !!f.node.current, 16); assert.equal(f.node.rejected, true);
  assert.match(f.events.at(-1).message, /queue full.*Stop drains/);
  f.reply(begin()); f.reply(chunk()); assert.match(f.events.at(-1).message, /Text queue full.*Stop to drain/); f.node.dispose();
});

test('Cancel during Qwen model loading rejects startup and ignores late ready/data', async () => {
  const controller = new AbortController(), events = [];
  const worker = { postMessage() {}, terminate() { this.terminated = true; } };
  const node = new Qwen3TtsNode({ workerFactory: () => worker, onEvent: event => events.push(event) });
  const start = node.start({ signal: controller.signal, emit() { assert.fail('Late audio'); }, fail() {} });
  const late = worker.onmessage; controller.abort(); await assert.rejects(start, /canceled/);
  late({ data: { type: 'ready' } }); late({ data: begin() }); late({ data: chunk() });
  assert.equal(worker.terminated, true); assert.deepEqual(events, []);
});

test('Qwen failure emits an abort, cancels queued work, and late Worker replies after Cancel are inert', async () => {
  const f = workerFixture(); await f.start; f.receive('One'); f.receive('Two'); f.reply(begin()); f.reply(chunk());
  const late = f.worker.onmessage; f.reply({ type: 'error', id: 1, message: 'GPU device lost' });
  assert.equal(f.emitted.at(-1)[1].type, 'abort'); assert.equal(f.emitted.at(-1)[1].sequence, 1);
  assert.equal(f.worker.terminated, true); assert.equal(f.failures.length, 1); assert.equal(f.node.queue.length, 0);
  late({ data: begin(2) }); late({ data: chunk(0, 2) }); assert.equal(f.emitted.length, 3);
  const canceled = workerFixture(); await canceled.start; canceled.receive('One'); canceled.reply(begin()); canceled.reply(chunk());
  const reply = canceled.worker.onmessage; const stop = canceled.node.stop(); canceled.controller.abort(); await stop;
  reply({ data: chunk(1) }); canceled.node.receive('text', 'Late', canceled.context);
  assert.equal(canceled.emitted.length, 2); assert.equal(canceled.worker.terminated, true);
});

test('streaming graph saves without migration, prepares shared model once, and accepts alternate AUDIO_STREAM producers', () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Qwen3TtsStreaming', 'tts'), graphNode('StreamingSpeakerOutput', 'speaker')],
    edges: [edge('text', 'value', 'tts', 'text'), edge('tts', 'stream', 'speaker', 'stream')] };
  const storage = { value: '', setItem(key, value) { this.value = value; }, getItem() { return this.value; }, removeItem() {} };
  saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph); assert.equal(executableGraph(graph).nodes.length, 3);
  assert.deepEqual(NODE_TYPES.StreamingSpeakerOutput.inputs, { stream: AUDIO_STREAM });
  assert.equal(graphModelRequirements({ nodes: [graph.nodes[1], { ...graphNode('Qwen3TtsStreaming', 'other'), settings: { language: 'english', voice: 'ryan' } }] }).length, 1);
  assert.equal(Object.keys(NODE_TYPES).some(type => /cosy/i.test(type)), false);
  const bad = structuredClone(graph); bad.nodes[2] = graphNode('AudioOutput', 'speaker'); bad.edges[1].to[1] = 'audio';
  assert.throws(() => assertGraph(bad), /contract|Incompatible/i);
  assert.doesNotThrow(() => new Pipeline({ nodes: { alternate: { outputs: { pcm: AUDIO_STREAM } }, speaker: new StreamingSpeakerOutputNode() },
    connections: [{ from: ['alternate', 'pcm'], to: ['speaker', 'stream'] }] }));
});

test('streaming Speaker needs Start gesture and audio activation happens before model initialization', async () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Qwen3TtsStreaming', 'tts'), graphNode('StreamingSpeakerOutput', 'speaker')],
    edges: [edge('text', 'value', 'tts', 'text'), edge('tts', 'stream', 'speaker', 'stream')] };
  const f = fixture(), order = []; await f.node.dispose();
  const session = new TabSession(() => {}, { graph,
    speakerContextFactory: () => { order.push('audio'); return { ...f.audio, state: 'running', resume() { return Promise.resolve(); } }; },
    ttsWorkerFactory: () => { order.push('worker'); const worker = { postMessage() { queueMicrotask(() => worker.onmessage({ data: { type: 'ready' } })); }, terminate() {} }; return worker; },
  });
  await session.start(42); assert.deepEqual(order, []); assert.match(session.view.status, /Press Start/);
  await session.start(42, { speakerGesture: true }); assert.deepEqual(order, ['audio', 'worker']); await session.cancel();
});
