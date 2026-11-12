import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputUnion, compatiblePorts, portContract, ANY, ITEM, TEXT, NUMBER, KEYED_PAIRED_TEXT } from '../web/port-contracts.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { AUDIO_STREAM } from '../web/audio-stream.js';
import { SPEAKER_AUDIO, SpeakerOutputNode } from '../web/speaker-output.js';
import { Pipeline } from '../web/pipeline.js';
import { GRAPH_VERSION, GRAPH_KEY, NODE_TYPES, graphNode, edge, assertGraph, upgradeGraph, saveGraph, readGraph } from '../extension/graph.js';
import { GraphEditor } from '../extension/graph-editor.js';
import { GraphLibrary, openLibrary, entryGraph, exportEntry } from '../extension/graph-library.js';
import { extractSubgraph, resolveSubgraphs } from '../extension/subgraphs.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { speakerContext } from './fixtures/speaker-context.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const clip = () => ({ samples: new Float32Array([.25]), sampleRate: 24000, channels: 1 });
const begin = () => ({ type: 'start', id: 1, sampleRate: 24000, channels: 1 });
const chunk = () => ({ type: 'chunk', id: 1, sequence: 0, samples: new Float32Array([.5]) });
const end = () => ({ type: 'end', id: 1, sequence: 1 });
function graph(type = 'Qwen3TtsStreaming', legacy = false) {
  const streaming = type.endsWith('Streaming');
  const speaker = graphNode('SpeakerOutput', 'speaker');
  if (legacy) speaker.type = 'StreamingSpeakerOutput';
  return { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode(type, 'tts'), speaker],
    edges: [edge('text', 'value', 'tts', 'text'), edge('tts', streaming ? 'stream' : 'audio', 'speaker', legacy ? 'stream' : 'audio')] };
}
function storage(source) {
  const values = new Map(source ? [[GRAPH_KEY, source]] : []);
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const locks = { request: (_, action) => Promise.resolve().then(action) };

test('input-only unions compose concrete identities without broadening outputs or ITEM', () => {
  const nested = inputUnion(inputUnion(SYNTHESIZED_AUDIO), AUDIO_STREAM, SYNTHESIZED_AUDIO);
  assert.equal(nested.name, SPEAKER_AUDIO.name);
  for (const input of [nested, SPEAKER_AUDIO]) {
    for (const output of [SYNTHESIZED_AUDIO, AUDIO_STREAM]) assert.equal(compatiblePorts(output, input), true);
    for (const output of [TEXT, NUMBER, ITEM, ANY, KEYED_PAIRED_TEXT, portContract('audio-stream'), input]) {
      assert.equal(compatiblePorts(output, input), false);
    }
    for (const destination of [input, ANY, AUDIO_STREAM, SYNTHESIZED_AUDIO]) assert.equal(compatiblePorts(input, destination), false);
    assert.throws(() => new Pipeline({ nodes: { bad: { outputs: { audio: input } } } }), /input-only/);
  }
  for (const members of [[], [undefined], [true], ['text'], [{}], [ANY], [ITEM], [SPEAKER_AUDIO, ANY]]) assert.throws(() => inputUnion(...members));
});

test('one Speaker input accepts either TTS kind, rejects unrelated types and duplicate incoming wires', async () => {
  assert.equal(NODE_TYPES.StreamingSpeakerOutput, undefined);
  assert.deepEqual(Object.entries(NODE_TYPES).filter(([, value]) => value.label.startsWith('Speaker')).map(([type]) => type), ['SpeakerOutput']);
  assert.deepEqual(NODE_TYPES.SpeakerOutput.inputs, { audio: SPEAKER_AUDIO });
  for (const type of ['Supertonic3', 'Kokoro', 'Qwen3TtsStreaming', 'CosyVoice3Streaming']) assert.doesNotThrow(() => assertGraph(graph(type)));
  const invalid = graph();
  invalid.edges[1].from = ['text', 'value'];
  assert.throws(() => assertGraph(invalid), /Incompatible/);
  const two = graph();
  two.nodes.push(graphNode('Kokoro', 'other'));
  two.edges.push(edge('other', 'audio', 'speaker', 'audio'));
  assert.throws(() => assertGraph(two), /Only one connection/);
  assert.throws(() => new Pipeline({ nodes: {
    clip: { outputs: { audio: SYNTHESIZED_AUDIO } }, stream: { outputs: { pcm: AUDIO_STREAM } }, speaker: new SpeakerOutputNode(),
  }, connections: [edge('clip', 'audio', 'speaker', 'audio'), edge('stream', 'pcm', 'speaker', 'audio')] }), /Only one connection/);
  for (const contract of [TEXT, NUMBER, ITEM, KEYED_PAIRED_TEXT]) {
    assert.throws(() => new Pipeline({ nodes: { source: { outputs: { value: contract } }, speaker: new SpeakerOutputNode() },
      connections: [edge('source', 'value', 'speaker', 'audio')] }), /Incompatible/);
  }
});

test('editor replaces the single audio wire when switching kinds and saved reload selects the new contract', async () => {
  const draft = graph('Kokoro'); draft.nodes.push(graphNode('Qwen3TtsStreaming', 'stream'));
  draft.edges.push(edge('text', 'value', 'stream', 'text'));
  const editor = Object.assign(Object.create(GraphEditor.prototype), { draft, draw() {}, canvas: { querySelector() {} } });
  const store = storage();
  for (const [source, output, contract] of [['stream', 'stream', AUDIO_STREAM], ['tts', 'audio', SYNTHESIZED_AUDIO]]) {
    editor.selected = { id: source, port: output, contract };
    editor.connect('speaker', 'audio', SPEAKER_AUDIO);
    assert.deepEqual(editor.draft.edges.filter(route => route.to[0] === 'speaker'), [edge(source, output, 'speaker', 'audio')]);
    saveGraph(store, editor.draft);
    const built = buildGraph(readGraph(store), {});
    assert.equal(built.pipeline.entries.get('speaker').context.inputContracts.audio, contract);
    await built.pipeline.dispose();
    editor.draft = readGraph(store);
  }
  const before = structuredClone(editor.draft.edges);
  editor.selected = { id: 'text', port: 'value', contract: TEXT };
  editor.connect('speaker', 'audio', SPEAKER_AUDIO);
  assert.deepEqual(editor.draft.edges, before);
});

test('legacy Speaker migration is narrow, immutable and canonical through load, import, save and export', async () => {
  for (const type of ['Qwen3TtsStreaming', 'CosyVoice3Streaming']) {
    const legacy = graph(type, true), original = structuredClone(legacy), canonical = graph(type);
    assert.deepEqual(assertGraph(legacy), canonical);
    assert.deepEqual(upgradeGraph(upgradeGraph(legacy)), canonical);
    assert.deepEqual(legacy, original);
    const store = storage(JSON.stringify(legacy));
    assert.deepEqual(readGraph(store), canonical);
    saveGraph(store, legacy);
    assert.deepEqual(JSON.parse(store.getItem(GRAPH_KEY)), canonical);
    const libraryStore = storage(JSON.stringify(legacy)), library = new GraphLibrary(libraryStore, locks);
    const { library: initial } = await openLibrary(libraryStore, locks), saved = initial.graphs[0];
    assert.deepEqual(entryGraph(saved, initial), canonical);
    assert.deepEqual(JSON.parse(exportEntry(saved, initial)), canonical);
    const imported = await library.import(legacy, 'Imported');
    assert.deepEqual(imported.graphs.at(-1).graph, canonical);
    const updated = await library.save(saved.id, saved.revision, legacy);
    assert.deepEqual(updated.graphs[0].graph, canonical);
    const bad = structuredClone(legacy); bad.edges[1].to[1] = 'unknown';
    assert.throws(() => assertGraph(bad), /Unknown port/);
    const conflicting = structuredClone(legacy); conflicting.edges.push(edge('tts', 'stream', 'speaker', 'audio'));
    assert.throws(() => assertGraph(conflicting), /Duplicate edge|Only one connection/);
  }
  const complete = graph('Kokoro'); assert.deepEqual(assertGraph(complete), complete);
  const canonicalWithWrongPort = graph(); canonicalWithWrongPort.edges[1].to[1] = 'stream';
  assert.throws(() => assertGraph(canonicalWithWrongPort), /Unknown port/);
});

test('TTS subgraph outputs keep concrete identity and legacy parent bundles export/import canonical Speakers', async () => {
  for (const type of ['Kokoro', 'Qwen3TtsStreaming', 'CosyVoice3Streaming']) {
    const extracted = extractSubgraph(graph(type), ['tts'], 'tts-shared');
    const definitions = [{ id: 'tts-shared', name: 'TTS', description: '', kind: 'subgraph', graph: extracted.shared }];
    const parent = extracted.parent;
    if (type.endsWith('Streaming')) {
      parent.nodes.find(node => node.id === 'speaker').type = 'StreamingSpeakerOutput';
      parent.edges.find(route => route.to[0] === 'speaker').to[1] = 'stream';
    }
    const resolved = resolveSubgraphs(parent, definitions);
    assert.equal(resolved.nodes.find(node => node.id === 'speaker').type, 'SpeakerOutput');
    const built = buildGraph(resolved, {});
    assert.equal(built.pipeline.entries.get('speaker').context.inputContracts.audio, type === 'Kokoro' ? SYNTHESIZED_AUDIO : AUDIO_STREAM);
    await built.pipeline.dispose();
    const root = { id: 'root', name: 'Parent', description: '', kind: 'graph', graph: parent };
    const bundle = JSON.parse(exportEntry(root, { graphs: [root, ...definitions] }));
    assert.equal(bundle.graphs[0].graph.nodes.find(node => node.id === 'speaker').type, 'SpeakerOutput');
    // Exercise import of a legacy bundle, too, rather than only our new export.
    bundle.graphs[0].graph = parent;
    const store = storage(), library = new GraphLibrary(store, locks);
    await openLibrary(store, locks);
    const imported = await library.import(bundle);
    assert.equal(imported.graphs.at(-1).graph.nodes.find(node => node.id === 'speaker').type, 'SpeakerOutput');
    assert.equal(imported.graphs.at(-1).graph.edges.find(route => route.to[0] === 'speaker').to[1], 'audio');
  }
});

test('Pipeline dispatch uses concrete source identity, validates before fan-out and snapshots queued audio', async () => {
  for (const contract of [SYNTHESIZED_AUDIO, AUDIO_STREAM]) {
    const audio = speakerContext({ state: 'suspended', holdResume: true });
    const speaker = new SpeakerOutputNode({ contextFactory: () => audio });
    let emitter; const received = [];
    const pipeline = new Pipeline({ nodes: {
      source: { outputs: { pcm: contract }, start(context) { emitter = context; } }, speaker,
      observer: { inputs: { audio: contract }, receive(_, value) { received.push(value); } },
    }, connections: [edge('source', 'pcm', 'speaker', 'audio'), edge('source', 'pcm', 'observer', 'audio')] });
    await pipeline.start();
    assert.equal(speaker.contract, contract);
    const value = contract === SYNTHESIZED_AUDIO ? clip() : chunk();
    if (contract === AUDIO_STREAM) emitter.emit('pcm', begin());
    emitter.emit('pcm', value); value.samples.fill(-1);
    if (contract === AUDIO_STREAM) emitter.emit('pcm', end());
    await tick();
    assert.equal(speaker.queue[0].samples[0], contract === SYNTHESIZED_AUDIO ? .25 : .5);
    assert.equal(received.find(value => value.samples).samples[0], contract === SYNTHESIZED_AUDIO ? .25 : .5);
    const count = received.length;
    emitter.emit('pcm', contract === SYNTHESIZED_AUDIO ? begin() : clip());
    await tick();
    assert.equal(pipeline.errors.length, 1); assert.match(pipeline.errors[0].message, /Node source/);
    assert.equal(received.length, count, 'no sibling receives an invalid payload');
    assert.equal(speaker.queue.length, 1);
    await pipeline.cancel(); await pipeline.dispose();
    assert.equal(audio.closes, 1);
  }
});

test('direct Speaker users validate the whole payload, lock one kind and reject malformed or mixed audio', async () => {
  const context = { signal: new AbortController().signal };
  for (const first of [clip(), begin()]) {
    const audio = speakerContext({ state: 'suspended', holdResume: true });
    const speaker = new SpeakerOutputNode({ contextFactory: () => audio });
    speaker.start(context);
    assert.throws(() => speaker.receive('audio', { type: 'start' }, context), /valid audio kind/);
    assert.throws(() => speaker.receive('audio', { ...clip(), ...begin() }, context), /valid audio kind/);
    speaker.receive('audio', first, context);
    assert.throws(() => speaker.receive('audio', first.type ? clip() : begin(), context), TypeError);
    await speaker.dispose();
  }
});

test('concurrent clip and stream Pipelines own independent kinds, queues, cancellation and contexts', async () => {
  const pipelines = [];
  for (const contract of [SYNTHESIZED_AUDIO, AUDIO_STREAM]) {
    const audio = speakerContext({ state: 'suspended', holdResume: true });
    const speaker = new SpeakerOutputNode({ contextFactory: () => audio });
    const pipeline = new Pipeline({ nodes: {
      source: { outputs: { pcm: contract }, start(context) {
        for (const value of contract === SYNTHESIZED_AUDIO ? [clip()] : [begin(), chunk(), end()]) context.emit('pcm', value);
      } }, speaker,
    }, connections: [edge('source', 'pcm', 'speaker', 'audio')] });
    pipelines.push({ pipeline, audio, speaker });
  }
  await Promise.all(pipelines.map(({ pipeline }) => pipeline.start())); await tick();
  const [completed, streaming] = pipelines;
  assert.equal(completed.speaker.contract, SYNTHESIZED_AUDIO); assert.equal(streaming.speaker.contract, AUDIO_STREAM);
  await completed.pipeline.cancel(); await completed.pipeline.dispose();
  assert.equal(completed.audio.closes, 1); assert.equal(completed.speaker.queue.length, 0);
  assert.equal(streaming.audio.closes, 0); assert.equal(streaming.speaker.queue.length, 1);
  assert.equal(streaming.speaker.queue[0].samples[0], .5);
  await streaming.pipeline.cancel(); await streaming.pipeline.dispose();
  assert.equal(streaming.audio.closes, 1);
});
