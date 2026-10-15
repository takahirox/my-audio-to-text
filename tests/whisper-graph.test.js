import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph, GRAPH_KEY, GRAPH_VERSION, NODE_TYPES, withTranslation } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { TextNode } from '../web/text-constant-node.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { SpeechToTextWhisperNode } from '../web/whisper-node.js';
import { TEXT } from '../web/port-contracts.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function store() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
}
function whisperGraph(language) {
  const graph = defaultGraph(); graph.nodes[1].type = 'SpeechToTextWhisper';
  graph.edges = graph.edges.filter(route => route.from[1] !== 'provisional');
  if (language !== undefined) {
    graph.nodes.push(graphNode('Text', 'language')); graph.nodes.at(-1).settings.value = language;
    graph.edges.push(edge('language', 'value', 'speech', 'language'));
  }
  return graph;
}
function fixture({ language, hold, failure } = {}) {
  const workers = [], finals = [], previews = [], requests = [];
  const graph = whisperGraph(language);
  graph.nodes.push(graphNode('TextFormatter', 'format'), graphNode('LiveTextDisplay', 'formatted'));
  graph.nodes.at(-2).settings.template = 'Final: {1}';
  graph.edges.push(edge('speech', 'final', 'format', 'input1'), edge('format', 'text', 'formatted', 'append'));
  const built = buildGraph(graph, {
    sourceFactory: () => ({ start() {}, stop() { built.audioSources.get('audio').context?.emit('audio', new Float32Array()); } }),
    whisperWorkerFactory: path => {
      const worker = { path, terminated: false, messages: [], postMessage(data) {
        this.messages.push(data);
        if (data.type === hold || this.terminated) return;
        queueMicrotask(() => {
          if (this.terminated) return;
          const send = msg => this.onmessage({ data: msg });
          if (data.type === failure) return send({ type: 'error', message: 'Fixture failure', session: data.session });
          if (data.type === 'load') send({ type: 'ready' });
          if (data.type === 'vad-audio') send({ type: 'vad', session: data.session, frames: [{ audio: data.audio, speaking: true }] });
          if (data.type === 'vad-stop') send({ type: 'vad-stopped', session: data.session });
          if (data.type === 'decode') {
            requests.push(data);
            send({ type: 'final', session: data.session, id: data.id, text: 'same text' });
            send({ type: 'final', session: data.session, id: data.id, text: 'duplicate' });
            send({ type: 'decoded', session: data.session });
          }
        });
      }, terminate() { this.terminated = true; } };
      workers.push(worker); return worker;
    },
    onDisplay: (id, state) => { if (id === 'transcript') { finals.splice(0, finals.length, ...state.items); previews.push(state.preview); } },
  });
  return { ...built, speech: built.speechNodes.get('speech'), workers, finals, previews, requests };
}

test('Whisper schema and concrete runtime expose exactly final; ReazonSpeech retains both outputs and default routes', async () => {
  assert.deepEqual(NODE_TYPES.SpeechToTextWhisper.outputs, { final: TEXT });
  assert.deepEqual(new SpeechToTextWhisperNode().outputs, { final: TEXT });
  assert.deepEqual(NODE_TYPES.SpeechToTextReazonSpeech.outputs, { provisional: TEXT, final: TEXT });
  assert.deepEqual(new SpeechToTextNode().outputs, { provisional: TEXT, final: TEXT });
  assert.deepEqual(defaultGraph().edges.slice(1), [edge('speech', 'provisional', 'transcript', 'replace'), edge('speech', 'final', 'transcript', 'append')]);
  const graph = whisperGraph();
  assert.deepEqual(validateGraph(graph), []);
  const built = buildGraph(graph, {});
  assert.deepEqual(built.pipeline.entries.get('speech').outputs, NODE_TYPES.SpeechToTextWhisper.outputs);
  await built.pipeline.dispose();
  graph.edges.push(edge('speech', 'provisional', 'transcript', 'replace'));
  assert.match(validateGraph(graph).join('\n'), /Unknown port: speech.provisional → transcript.replace/);
  const storage = store(), saved = JSON.stringify(whisperGraph()); storage.setItem(GRAPH_KEY, saved);
  assert.throws(() => saveGraph(storage, graph), /Unknown port: speech.provisional/);
  assert.equal(storage.getItem(GRAPH_KEY), saved);
});

test('Whisper finals connect to replace, append, completed translation and other TEXT consumers; preset uses implemented outputs', () => {
  for (const port of ['replace', 'append']) {
    const graph = whisperGraph(); graph.edges.at(-1).to[1] = port;
    assert.deepEqual(validateGraph(graph), []);
    for (const direction of ['ja-en', 'en-ja']) {
      const translated = withTranslation(graph, { enabled: true, direction });
      assert.deepEqual(validateGraph(translated), []);
      assert.deepEqual(translated.edges.filter(route => route.to[0] === 'translation'), [edge('speech', 'final', 'translation', 'text')]);
      assert.deepEqual(withTranslation(translated, { enabled: false, direction }), { ...graph, translationDirection: direction });
    }
  }
});

test('v7 migration removes only dead Whisper edges, preserving all custom nodes, routes, settings and positions', () => {
  for (const dead of [false, true]) for (const whisper of [false, true]) for (const enabled of [false, true]) {
    const graph = withTranslation(whisper ? whisperGraph('ja') : defaultGraph(), { enabled, direction: 'en-ja' });
    graph.version = 7;
    graph.nodes[1].position = { x: 42, y: 777 };
    graph.nodes[2].settings = { label: 'Custom display', language: 'ja' };
    graph.nodes.push(graphNode('Text', 'literal'), graphNode('TextFormatter', 'format'), graphNode('FocusedInputTextOutputNode', 'field'));
    graph.nodes.at(-3).settings.value = 'literal\n😀'; graph.nodes.at(-2).settings.template = '{1}: {2}';
    graph.edges.push(edge('literal', 'value', 'format', 'input1'), edge('speech', 'final', 'format', 'input2'), edge('format', 'text', 'field', 'text'));
    if (dead && whisper) graph.edges.push(edge('speech', 'provisional', 'transcript', 'replace'), edge('speech', 'provisional', 'format', 'input3'));
    const original = structuredClone(graph), storage = store(); storage.setItem(GRAPH_KEY, JSON.stringify(graph));
    const expected = structuredClone(graph); expected.version = GRAPH_VERSION;
    if (whisper) expected.edges = expected.edges.filter(route => !(route.from[0] === 'speech' && route.from[1] === 'provisional'));
    assert.deepEqual(readGraph(storage), expected);
    assert.deepEqual(JSON.parse(storage.getItem(GRAPH_KEY)), expected);
    assert.deepEqual(readGraph(storage), expected);
    assert.deepEqual(saveGraph(storage, expected), expected);
    assert.deepEqual(graph, original);
  }
});

test('v7 dead Whisper routes migrate to saveable incomplete drafts without redirecting ports', () => {
  for (const [type, port] of [['LiveTextDisplay', 'replace'], ['FocusedInputTextOutputNode', 'text'], ['OpusMtEnJa', 'text']]) {
    const graph = whisperGraph('ja'); graph.version = 7;
    graph.nodes.push(graphNode(type, 'affected', 555, 444));
    graph.edges.push(edge('speech', 'provisional', 'affected', port));
    const storage = store(); storage.setItem(GRAPH_KEY, JSON.stringify(graph));
    const expected = structuredClone(graph); expected.version = GRAPH_VERSION;
    expected.edges = expected.edges.filter(route => route.from[1] !== 'provisional');
    assert.deepEqual(readGraph(storage), expected);
    assert.deepEqual(readGraph(storage), expected);
  }
});

test('v6 rename preserves custom branches, IDs, destinations, settings, positions and Number wiring exactly', () => {
  for (const enabled of [false, true]) {
    const graph = defaultGraph({ enabled, direction: 'en-ja' });
    graph.version = 6; graph.nodes[1].type = 'SpeechToText'; graph.nodes[1].position = { x: 49, y: 919 };
    graph.nodes[2].settings = { label: '<my display>', language: 'ja' };
    graph.nodes.push(graphNode('Number', 'cap'), graphNode('TextFormatter', 'format'), graphNode('FocusedInputTextOutputNode', 'field'));
    graph.nodes.at(-3).settings.value = 1.75; graph.nodes.at(-2).settings.template = '<literal> {1}';
    graph.edges.push(edge('cap', 'value', 'speech', 'maxDuration'), edge('speech', 'final', 'format', 'input1'), edge('format', 'text', 'field', 'text'));
    const original = structuredClone(graph), storage = store(); storage.setItem(GRAPH_KEY, JSON.stringify(graph));
    const migrated = readGraph(storage);
    const expected = structuredClone(original); expected.version = GRAPH_VERSION; expected.nodes[1].type = 'SpeechToTextReazonSpeech';
    assert.deepEqual(migrated, expected); assert.deepEqual(readGraph(storage), expected); assert.deepEqual(graph, original);
    assert.equal(migrated.nodes.filter(n => n.type.startsWith('SpeechToText')).length, 1);
    graph.edges.push(edge('speech', 'final', 'field', 'audio'));
    storage.setItem(GRAPH_KEY, JSON.stringify(graph)); const raw = storage.getItem(GRAPH_KEY);
    assert.throws(() => readGraph(storage), /Invalid saved graph.*Unknown port.*Reset and Save/s);
    assert.equal(storage.getItem(GRAPH_KEY), raw);
    saveGraph(storage, defaultGraph()); assert.deepEqual(readGraph(storage), defaultGraph());
  }
});

test('Text is generic, literal, empty-safe and round-trips; ordinary consumers receive it once at start', async () => {
  for (const value of ['', 'en', 'ja', '<script>&"\n😀 {1}']) {
    const graph = defaultGraph(); graph.nodes.push(graphNode('Text', 'literal'));
    graph.nodes.at(-1).settings.value = value;
    graph.edges = graph.edges.filter(e => e.to[1] !== 'replace'); graph.edges.push(edge('literal', 'value', 'transcript', 'replace'));
    const storage = store(); saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
    const received = []; const node = new TextNode(readGraph(storage).nodes.at(-1).settings);
    assert.equal(node.outputs.value, TEXT); node.start({ emit: (port, text) => received.push([port, text]) });
    assert.deepEqual(received, [['value', value]]);
  }
  const graph = defaultGraph(); graph.nodes.push(graphNode('Text', 'literal')); graph.edges.push(edge('literal', 'value', 'speech', 'maxDuration'));
  assert.match(validateGraph(graph).join('\n'), /Incompatible port types/);
  assert.throws(() => new TextNode({ value: 2 }), /string/);
});

test('model ports support independent ASRs; Whisper language is a validated startup constant', async () => {
  assert.equal(NODE_TYPES.SpeechToTextReazonSpeech.inputs.language, undefined);
  assert.equal(NODE_TYPES.SpeechToTextWhisper.inputs.maxDuration, undefined);
  for (const language of [undefined, 'en', 'ja']) {
    const f = fixture({ language });
    assert.equal(f.speech.language, language ?? 'en');
    await f.pipeline.start();
    assert.equal(f.workers[0].messages[0].language, language ?? 'en');
    assert.equal(f.workers[0].path, './whisper-worker.js');
    assert.throws(() => f.speech.receive('language', 'ja'), /before model loading/);
    await f.pipeline.stop(); await f.pipeline.dispose();
  }
  for (const language of ['', 'EN', ' en', 'fr', null, 1]) assert.throws(() => buildGraph(whisperGraph(language), {}), /Whisper.language|Invalid setting/);
  const graph = whisperGraph(); graph.nodes.push(graphNode('SpeechToTextReazonSpeech', 'other'));
  assert.deepEqual(validateGraph(graph), []);
  const dynamic = whisperGraph(); dynamic.edges.push(edge('speech', 'final', 'speech', 'language'));
  assert.match(validateGraph(dynamic).join('\n'), /requires Text.value.*startup/);
  const storage = store(), snapshot = whisperGraph('en'); saveGraph(storage, snapshot);
  const built = buildGraph(readGraph(storage), {}); snapshot.nodes.at(-1).settings.value = 'ja'; saveGraph(storage, snapshot);
  assert.equal(built.speechNodes.get('speech').language, 'en'); assert.equal(buildGraph(readGraph(storage), {}).speechNodes.get('speech').language, 'ja');
  await built.pipeline.dispose();
});

test('continuous Whisper queues bounded finals only, drains tail exactly once, preserves repeated text and other TEXT consumers', async () => {
  const f = fixture(); await f.pipeline.start();
  const pcm = Float32Array.from({ length: 210001 }, (_, i) => i / 210001);
  f.speech.receive('audio', pcm); await tick();
  assert.deepEqual(f.requests.map(r => r.audio.length), [96000, 96000]);
  const formatted = f.pipeline.entries.get('formatted').node;
  await Promise.all([f.pipeline.stop(), f.pipeline.stop()]);
  assert.deepEqual(f.requests.map(r => [r.id, r.final, r.audio.length]), [[1, true, 96000], [2, true, 96000], [3, true, 18001]]);
  assert.deepEqual(Float32Array.from(f.requests.flatMap(r => Array.from(r.audio))), pcm);
  assert.deepEqual(f.finals, ['same text', 'same text', 'same text']); assert.ok(f.previews.every(p => p === ''));
  assert.deepEqual(formatted.items, ['Final: same text', 'Final: same text', 'Final: same text']);
  await f.pipeline.dispose(); assert.ok(f.workers.every(w => w.terminated));
});

for (const hold of ['load', 'decode']) test(`Whisper Cancel during ${hold} releases both workers and ignores stale events`, async () => {
  const f = fixture({ hold });
  const start = f.pipeline.start();
  if (hold === 'decode') { await start; f.speech.receive('audio', new Float32Array(96000)); }
  else void start.catch(() => {});
  await tick(); const callbacks = f.workers.map(w => w.onmessage);
  await f.pipeline.dispose(); await start.catch(() => {});
  for (const cb of callbacks) cb({ data: { type: 'final', session: 1, id: 1, text: 'late' } });
  assert.deepEqual(f.finals, []); assert.ok(f.workers.every(w => w.terminated));
});

for (const failure of ['load', 'decode', 'vad-stop']) test(`Whisper ${failure} error releases resources and a fresh session can run`, async () => {
  const f = fixture({ failure });
  if (failure === 'load') await assert.rejects(f.pipeline.start(), /Fixture failure/);
  else {
    await f.pipeline.start(); f.speech.receive('audio', new Float32Array(96000)); await tick();
    await assert.rejects(f.pipeline.stop(), /Pipeline failed/); await f.pipeline.dispose();
  }
  assert.ok(f.workers.every(w => w.terminated));
  const next = fixture(); await next.pipeline.start(); next.speechNodes.get('speech').receive('audio', new Float32Array(37));
  await next.pipeline.stop(); assert.deepEqual(next.finals, ['same text']); await next.pipeline.dispose();
});

test('Whisper backlog overflow fails explicitly and releases resources', async () => {
  const f = fixture({ hold: 'decode' }); await f.pipeline.start();
  f.speech.receive('audio', new Float32Array(480001)); await tick();
  assert.equal(f.speech.core.state, 'released'); assert.ok(f.workers.every(w => w.terminated));
  assert.match(f.pipeline.errors[0].message, /30 seconds behind/); await f.pipeline.dispose();
});

test('Whisper Worker crash fails once and Stop settles without a leaked drain', async () => {
  const f = fixture({ hold: 'decode' }); await f.pipeline.start(); f.speech.receive('audio', new Float32Array(37));
  const stop = f.pipeline.stop(); await tick();
  f.workers[0].onerror({ preventDefault() {}, message: 'Worker crashed' });
  await assert.rejects(stop, /Pipeline failed/); assert.equal(f.pipeline.errors.length, 1);
  await f.pipeline.dispose(); assert.ok(f.workers.every(w => w.terminated));
});
