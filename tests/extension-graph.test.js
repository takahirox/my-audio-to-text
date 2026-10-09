import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph, withTranslation, GRAPH_KEY, NODE_TYPES } from '../extension/graph.js';
import { buildGraph, FinalTextNode } from '../extension/graph-runtime.js';
import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode, TranscriptOutputNode } from '../web/transcription-nodes.js';
import { ExtensionTabAudioNode } from '../extension/tab-audio-node.js';
import { TranslationSchedulerNode } from '../extension/translation-scheduler.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const audioGraph = (type, translated = false) => {
  const graph = defaultGraph({ enabled: translated });
  graph.nodes.push(graphNode(translated ? 'TranslatedFinalText' : 'FinalText', 'text'), graphNode(type, 'tts'), graphNode('AudioOutput', 'player'));
  graph.edges.push(edge(translated ? 'translation' : 'speech', 'final', 'text', 'final'), edge('text', 'text', 'tts', 'text'), edge('tts', 'audio', 'player', 'audio'));
  return graph;
};

test('fresh graph defaults to translation; legacy preferences migrate once; persisted graph is the single source of truth', () => {
  const fresh = storage(); assert.equal(readGraph(fresh).nodes[3].type, 'OpusMtJaEn');
  for (const enabled of [false, true]) for (const direction of ['ja-en', 'en-ja']) {
    const store = storage(); store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled, direction }));
    const graph = readGraph(store); assert.equal(graph.nodes[2].settings.direction, direction); assert.equal(graph.nodes.length, enabled ? 5 : 3);
    assert.equal(store.getItem('opus-mt-translation-preferences'), null);
    assert.deepEqual(readGraph(store), graph);
  }
  const store = storage(); store.setItem(GRAPH_KEY, '{broken'); assert.throws(() => readGraph(store));
  saveGraph(store, defaultGraph({ enabled: false })); assert.equal(readGraph(store).nodes.length, 3);
  store.setItem('opus-mt-translation-preferences', '{broken'); assert.equal(readGraph(store).nodes.length, 3);
  assert.throws(() => saveGraph({ setItem() { throw Error('Quota'); } }, defaultGraph()), /Quota/);
});

for (const [name, edit, pattern] of [
  ['version', g => g.version = 99, /version/],
  ['unknown type', g => g.nodes[0].type = 'toString', /Unknown Node/],
  ['duplicate ID', g => g.nodes[1].id = 'audio', /Duplicate Node/],
  ['bad port', g => g.edges[0].from[1] = 'toString', /Unknown port/],
  ['incompatible type', g => g.edges[0].from = ['speech', 'final'], /Incompatible/],
  ['cycle', g => g.edges.push(edge('speech', 'final', 'speech', 'audio')), /acyclic/],
  ['duplicate edge', g => g.edges.push(g.edges[0]), /Duplicate edge/],
  ['missing input', g => g.edges.pop(), /Required connection/],
  ['missing source', g => g.nodes.shift(), /Exactly one audio input/],
  ['position', g => g.nodes[0].position.x = Infinity, /Invalid position/],
  ['settings', g => g.nodes[2].settings.model = 'remote', /Unknown setting/],
  ['direction mismatch', g => g.nodes[3].type = 'OpusMtEnJa', /direction must match/],
  ['duplicate translation', g => g.nodes.push(graphNode('OpusMtEnJa', 'other')), /Only one paired/],
  ['duplicate transcript destination', g => {
    g.nodes.push(graphNode('TranscriptView', 'other'));
    for (const port of ['provisional', 'final']) g.edges.push(edge('speech', port, 'other', port));
  }, /Only one shared Live transcript/],
  ['malformed edge', g => g.edges.push({ from: null }), /Malformed/],
]) test(`schema rejects ${name} before saving or constructing Workers`, () => {
  const graph = defaultGraph(); edit(graph);
  assert.match(validateGraph(graph).join('\n'), pattern);
  assert.throws(() => assertGraph(graph), pattern);
  assert.throws(() => buildGraph(graph, {}), pattern);
});

test('concrete supported descriptions instantiate actual Nodes with identical contract identities and the exact saved edges', () => {
  for (const graph of [defaultGraph(), defaultGraph({ enabled: false }), defaultGraph({ direction: 'en-ja' }), audioGraph('Supertonic3'), audioGraph('Kokoro', true)]) {
    const result = buildGraph(graph, { tabId: 42, onTranscript() {}, onTranslation() {}, onTranslationState() {}, prepareTranslation() {}, onSynthesizedAudio() {} });
    assert.ok(result.pipeline instanceof Pipeline);
    assert.ok(result.audio instanceof ExtensionTabAudioNode); assert.ok(result.speech instanceof SpeechToTextNode);
    assert.ok(result.pipeline.entries.get('transcript').node instanceof TranscriptOutputNode);
    if (result.translation) assert.ok(result.translation instanceof TranslationSchedulerNode);
    for (const spec of graph.nodes) {
      const actual = result.pipeline.entries.get(spec.id);
      assert.deepEqual(actual.inputs, NODE_TYPES[spec.type].inputs); assert.deepEqual(actual.outputs, NODE_TYPES[spec.type].outputs);
      if (spec.type === 'Supertonic3') assert.ok(actual.node.node instanceof Supertonic3TextToSpeechNode);
      if (spec.type === 'Kokoro') assert.ok(actual.node.node instanceof KokoroTextToSpeechNode);
    }
    assert.deepEqual(result.description.edges, graph.edges);
    graph.nodes[0].position.x += 100; assert.notEqual(result.description.nodes[0].position.x, graph.nodes[0].position.x);
  }
});

test('final adapters skip pending/errors and preserve a whole utterance for TEXT fan-out', () => {
  const values = [], context = { emit: (port, text) => values.push([port, text]) }, adapter = new FinalTextNode(true);
  adapter.receive('provisional', { text: 'bad', status: 'complete' }, context);
  for (const status of ['pending', 'error', 'canceled']) adapter.receive('final', { text: 'bad', status }, context);
  const text = 'a'.repeat(299) + '😀' + 'b'.repeat(302);
  adapter.receive('final', { text, status: 'complete' }, context);
  assert.deepEqual(values, [['text', text]]);
});

test('direction and translation controls retain saved audio nodes; disabling translation removes dependent audio only', () => {
  const original = audioGraph('Kokoro');
  const enabled = withTranslation(original, { enabled: true, direction: 'en-ja' });
  assert.ok(enabled.nodes.some(n => n.type === 'Kokoro')); assert.ok(enabled.nodes.some(n => n.type === 'OpusMtEnJa'));
  const disabled = withTranslation(enabled, { enabled: false, direction: 'ja-en' });
  assert.ok(disabled.nodes.some(n => n.type === 'Kokoro'));
  assert.equal(withTranslation(audioGraph('Kokoro', true), { enabled: false, direction: 'en-ja' }).nodes.length, 3);
});

test('saved translation → final-text → actual Kokoro Node graph drains only completed finals in order, even with reordered edges', async () => {
  const graph = audioGraph('Kokoro', true); graph.edges.reverse();
  const texts = [], audio = [], rows = [], workers = [];
  const factory = () => url => {
    const worker = { url, released: false, postMessage(data) {
      queueMicrotask(() => {
        if (this.released) return;
        let reply;
        if (data.type === 'load') reply = { type: 'ready', id: data.id };
        else if (data.type === 'vad-stop') reply = { type: 'vad-stopped', session: data.session };
        else if (data.type === 'translate') reply = { type: 'result', id: data.id, texts: ['Translated ' + data.text] };
        else if (data.type === 'generate') { texts.push(data.text); reply = { type: 'result', id: data.id, audio: { samples: new Float32Array([0, .2, -.2]), sampleRate: 24000, channels: 1 } }; }
        else if (data.type === 'drain') reply = { type: 'drained', id: data.id };
        if (reply) this.onmessage?.({ data: reply });
      });
    }, terminate() { this.released = true; } };
    workers.push(worker); return worker;
  };
  const built = buildGraph(graph, { tabId: 42, sourceFactory: () => ({ start() {}, stop() {} }),
    workerFactory: factory(), translationWorkerFactory: factory(), ttsWorkerFactory: factory(),
    prepareTranslation: async () => {}, prepareTts: async () => {}, onTranscript: (port, value) => { if (port === 'final') rows.push(value.text); },
    onTranslation() {}, onTranslationState() {}, onSynthesizedAudio: value => audio.push(value) });
  await built.pipeline.start();
  built.speech.receiveEvent({ type: 'partial', text: 'provisional', id: 0 });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(texts, []);
  built.speech.receiveEvent({ type: 'final', text: 'one', id: 0 });
  built.speech.receiveEvent({ type: 'final', text: 'two', id: 1 });
  const long = 'a'.repeat(299) + '😀' + 'b'.repeat(302);
  built.speech.receiveEvent({ type: 'final', text: long, id: 2 });
  await built.pipeline.stop(); await built.pipeline.dispose();
  assert.deepEqual(rows, ['one', 'two', long]); assert.deepEqual(texts.slice(0, 2), ['Translated one', 'Translated two']);
  assert.equal(texts.slice(2).join(''), 'Translated ' + long); assert.ok(texts.every(text => text.length <= 300 && !/[\uD800-\uDBFF]$/.test(text)));
  assert.equal(audio.length, texts.length);
  assert.ok(workers.every(worker => worker.released));
});
