import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZipformerSegments } from '../web/zipformer-segments.js';
import { ZIPFORMER as C } from '../web/zipformer-config.js';
import { SpeechToTextZipformerEnNode } from '../web/zipformer-node.js';
import { MONO_16KHZ_PCM, TEXT } from '../web/transcription-nodes.js';
import { defaultGraph, graphNode, edge, validateGraph, migrateGraph, readGraph, GRAPH_KEY, ASR_TYPES, NODE_TYPES, withTranslation } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { Pipeline } from '../web/pipeline.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function recognizer() {
  const streams = [];
  return { streams, createStream() {
    const s = { samples: [], ready: false, decodes: 0, ended: false, freed: false,
      acceptWaveform(rate, audio) { assert.equal(rate, 16000); this.samples.push(...audio); this.ready = true; },
      inputFinished() { this.ended = true; }, free() { this.freed = true; } };
    streams.push(s); return s;
  }, isReady: s => s.ready, decode(s) { s.decodes++; s.ready = false; },
  getResult: s => ({ text: s.samples.some(n => n > 0) ? `english ${s.decodes}` : '' }) };
}
function fixture({ hold, failure } = {}) {
  const workers = [], events = [], finals = [], previews = [], errors = [], accepted = [];
  const speech = new SpeechToTextZipformerEnNode({ onEvent: e => events.push(e), workerFactory: path => {
    const r = recognizer(); let segments, session;
    const w = { path, messages: [], terminated: false, terminate() { this.terminated = true; }, postMessage(data, transfer) {
      const m = structuredClone(data, { transfer: transfer || [] }); this.messages.push(m);
      queueMicrotask(() => {
        if (this.terminated || m.type === hold) return;
        const send = e => this.onmessage?.({ data: { session, ...e } });
        if (m.type === failure) return send({ type: 'error', message: 'Fixture failure' });
        if (m.type === 'load') send({ type: 'ready' });
        if (m.type === 'start') { session = m.session; segments = new ZipformerSegments(r, send); }
        if (m.type === 'audio') { accepted.push(...m.audio); segments.push(m.audio); send({ type: 'consumed', sequence: m.sequence }); }
        if (m.type === 'stop') { segments.finish(); send({ type: 'stopped' }); }
      });
    } }; workers.push(w); return w;
  } });
  const source = { inputs: {}, outputs: { audio: MONO_16KHZ_PCM } };
  const sink = { inputs: { preview: TEXT, text: TEXT }, outputs: {}, receive(p, t) { (p === 'text' ? finals : previews).push(t); } };
  const pipeline = new Pipeline({ nodes: { source, speech, sink }, onError: e => errors.push(e), connections: [edge('source', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'sink', 'preview'), edge('speech', 'final', 'sink', 'text')] });
  return { speech, pipeline, workers, events, finals, previews, errors, accepted };
}

test('online segments accept every real sample once across cap/tail, decode incrementally, finalize exactly once and free streams', () => {
  const r = recognizer(), events = [], s = new ZipformerSegments(r, e => events.push(e));
  const pcm = Float32Array.from({ length: C.segmentSamples * 2 + 37 }, (_, i) => (i + 1) / 1000000);
  s.push(pcm); s.finish(); s.finish(); s.dispose();
  assert.equal(r.streams.length, 3);
  assert.deepEqual(r.streams.map(s => s.samples.length), [C.segmentSamples + C.tailSamples, C.segmentSamples + C.tailSamples, 37 + C.tailSamples]);
  assert.deepEqual(r.streams.flatMap(s => s.samples.slice(0, -C.tailSamples)), [...pcm]);
  assert.ok(r.streams.every(s => s.ended && s.freed && s.samples.slice(-C.tailSamples).every(n => n === 0)));
  const finals = events.filter(e => e.type === 'final'); assert.deepEqual(finals.map(e => e.id), [0, 1, 2]);
  for (const final of finals) assert.ok(events.findIndex(e => e.type === 'partial' && e.id === final.id) < events.indexOf(final));
});

test('empty/no-speech emits no text, cancel frees without final, segment errors still release stream', () => {
  const r = recognizer(), events = [], s = new ZipformerSegments(r, e => events.push(e));
  s.finish(); s.push(new Float32Array(C.segmentSamples + 1)); s.finish(); assert.deepEqual(events, []);
  s.push(new Float32Array(32).fill(.1)); s.dispose(); assert.equal(events.at(-1).type, 'partial');
  assert.ok(r.streams.every(s => s.freed));
  s.push(new Float32Array(1).fill(.1)); r.decode = () => { throw Error('decode failed'); };
  assert.throws(() => s.finish(), /decode failed/); assert.equal(r.streams.at(-1).freed, true);
});

test('typed graph, opt-in definition and runtime assembly preserve v8 defaults, saved graphs, translation and other sinks', async () => {
  assert.ok(ASR_TYPES.includes('SpeechToTextZipformerEn'));
  assert.equal(defaultGraph().nodes[1].type, 'SpeechToTextReazonSpeech');
  assert.deepEqual(NODE_TYPES.SpeechToTextZipformerEn.inputs, { audio: MONO_16KHZ_PCM });
  const graph = defaultGraph(); graph.nodes[1].type = 'SpeechToTextZipformerEn';
  graph.nodes.push(graphNode('TextFormatter', 'format'), graphNode('FocusedInputTextOutputNode', 'field'));
  graph.edges.push(edge('speech', 'final', 'format', 'input1'), edge('format', 'text', 'field', 'text'));
  assert.deepEqual(validateGraph(graph), []);
  assert.deepEqual(validateGraph(withTranslation(graph, { enabled: true, direction: 'en-ja' })), []);
  const built = buildGraph(graph, {}); assert.ok(built.speechNodes.get('speech') instanceof SpeechToTextZipformerEnNode); await built.pipeline.dispose();
  for (const type of ASR_TYPES) {
    const saved = defaultGraph(); saved.nodes[1].type = type;
    if (!Object.hasOwn(NODE_TYPES[type].outputs, 'provisional')) saved.edges = saved.edges.filter(e => e.from[1] !== 'provisional');
    const raw = JSON.stringify(saved), storage = { getItem: key => key === GRAPH_KEY ? raw : null, setItem() { throw Error('v8 must not rewrite'); } };
    assert.deepEqual(readGraph(storage), saved); assert.equal(migrateGraph(saved), saved);
  }
  graph.nodes.push(graphNode('SpeechToTextWhisper', 'second')); assert.deepEqual(validateGraph(graph), []);
});

test('owned bounded PCM, provisional before final, ordered repeated finals, Stop tail and warm repeat session', async () => {
  const f = fixture(); await f.pipeline.start();
  const pcm = new Float32Array(C.segmentSamples * 2 + 37).fill(.2);
  f.speech.receive('audio', pcm); pcm.fill(0);
  await Promise.all([f.pipeline.stop(), f.pipeline.stop()]);
  assert.equal(f.accepted.length, pcm.length); assert.ok(f.accepted.every(n => n === Math.fround(.2)));
  assert.equal(f.finals.length, 3); assert.equal(f.finals[0], f.finals[1]); assert.ok(f.previews.length > 3);
  assert.ok(f.events.findIndex(e => e.type === 'partial') < f.events.findIndex(e => e.type === 'final'));
  // Repeated callback for a committed ID is suppressed before fan-out.
  f.speech.receiveEvent({ type: 'final', id: 2, text: 'duplicate' }); await tick(); assert.equal(f.finals.length, 3);
  const next = f.speech.nextSession(); assert.equal(f.speech.core, null); await f.pipeline.dispose();
  const received = []; await next.start({ signal: new AbortController().signal, emit: (p, t) => received.push([p, t]), fail: e => { throw e; } });
  next.receive('audio', new Float32Array(1).fill(.3)); await next.stop();
  assert.equal(received.filter(([p]) => p === 'final').length, 1); assert.equal(f.workers.length, 1);
  next.dispose(); assert.ok(f.workers.every(w => w.terminated));
});

for (const hold of ['load', 'audio']) test(`Cancel during ${hold} rejects waiters, terminates worker, ignores stale events`, async () => {
  const f = fixture({ hold }); const start = f.pipeline.start(); void start.catch(() => {}); await tick();
  if (hold === 'audio') { await start; f.speech.receive('audio', new Float32Array(1)); }
  const callback = f.workers[0].onmessage; const stop = hold === 'audio' ? f.pipeline.stop() : start; void stop.catch(() => {});
  await f.pipeline.dispose(); await stop.catch(() => {});
  callback({ data: { type: 'final', session: 1, id: 0, text: 'late' } });
  assert.deepEqual(f.finals, []); assert.ok(f.workers.every(w => w.terminated));
});
for (const failure of ['load', 'audio', 'stop']) test(`${failure} failure propagates once and frees worker; fresh session succeeds`, async () => {
  const f = fixture({ failure });
  if (failure === 'load') await assert.rejects(f.pipeline.start(), /Fixture failure/);
  else { await f.pipeline.start(); f.speech.receive('audio', new Float32Array(1)); await tick(); await assert.rejects(f.pipeline.stop(), /Pipeline failed/); }
  await f.pipeline.dispose(); assert.equal(f.errors.length, 1); assert.ok(f.workers.every(w => w.terminated));
  const next = fixture(); await next.pipeline.start(); await next.pipeline.stop(); await next.pipeline.dispose();
});
test('30-second bound includes in-flight PCM; overload and Worker crash/messageerror release all resources', async () => {
  for (const mode of ['overflow', 'crash', 'messageerror']) {
    const f = fixture({ hold: 'audio' }); await f.pipeline.start();
    f.speech.receive('audio', new Float32Array(C.backlogSamples));
    assert.equal(f.workers[0].messages.filter(m => m.type === 'audio').length, 1);
    if (mode === 'overflow') f.speech.receive('audio', new Float32Array(1));
    else if (mode === 'crash') f.workers[0].onerror({ message: 'Worker crashed', preventDefault() {} });
    else f.workers[0].onmessageerror();
    assert.equal(f.speech.core.state, 'released'); assert.equal(f.errors.length, 1);
    assert.equal(f.speech.core.pendingSamples, 0); await f.pipeline.dispose(); assert.ok(f.workers[0].terminated);
  }
});
