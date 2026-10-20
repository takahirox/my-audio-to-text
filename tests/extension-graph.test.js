import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph, withTranslation, GRAPH_KEY, GRAPH_RECOVERY_KEY, GRAPH_VERSION, NODE_TYPES, nodeDefinition } from '../extension/graph.js';
import { legacyGraph } from './fixtures/legacy-graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { LiveTextDisplayNode } from '../web/text-nodes.js';
import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { ExtensionTabAudioNode } from '../extension/tab-audio-node.js';
import { TranslationSchedulerNode } from '../extension/translation-scheduler.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('optional Number configuration reloads and binds a snapshot before ASR or capture startup', async () => {
  const store = storage(), graph = defaultGraph();
  const options = { workerFactory: () => ({ postMessage() {}, terminate() {} }), sourceFactory: () => ({ start() {}, stop() {} }) };
  const unconnected = buildGraph(graph, options);
  assert.equal(unconnected.speechNodes.get('speech').maxDuration, 6); await unconnected.pipeline.dispose();
  graph.nodes.push(graphNode('Number', 'duration'));
  graph.nodes.at(-1).settings.value = 1.234567;
  graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'));
  saveGraph(store, graph); assert.deepEqual(readGraph(store), graph);
  const built = buildGraph(readGraph(store), options);
  assert.equal(built.speechNodes.get('speech').maxDuration, 1.234567);
  assert.equal(built.speechNodes.get('speech').core.state, 'released'); // No workers or audio processing yet.
  graph.nodes.at(-1).settings.value = 9.5; saveGraph(store, graph);
  assert.equal(built.speechNodes.get('speech').maxDuration, 1.234567);
  const next = buildGraph(readGraph(store), options);
  assert.equal(next.speechNodes.get('speech').maxDuration, 9.5);
  assert.deepEqual(built.description.edges, graph.edges);
  await built.pipeline.dispose(); await next.pipeline.dispose();
});

test('connected invalid Number fails before Workers; runtime NUMBER outputs cannot configure startup', () => {
  for (const value of [0, -1, 0.9, 12.01, NaN, Infinity, -Infinity, null, undefined, '2']) {
    const graph = defaultGraph(); graph.nodes.push(graphNode('Number', 'duration'));
    graph.nodes.at(-1).settings.value = value; graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'));
    assert.throws(() => buildGraph(graph, { workerFactory() { assert.fail('Must not create Worker'); } }), /finite number|1 to 12 seconds/);
    assert.throws(() => saveGraph(storage(), graph), /finite number|1 to 12 seconds/);
  }
  const graph = defaultGraph({ enabled: true }); graph.edges.push(edge('translation', 'finalIndex', 'speech', 'maxDuration'));
  assert.match(validateGraph(graph).join('\n'), /Unknown port/);
});
const audioGraph = (type, translated = false) => {
  const graph = defaultGraph({ enabled: translated });
  graph.nodes.push(graphNode(type, 'tts'), graphNode('AudioOutput', 'player'));
  graph.edges.push(edge(translated ? 'translation' : 'speech', translated ? 'text' : 'final', 'tts', 'text'), edge('tts', 'audio', 'player', 'audio'));
  return graph;
};

test('fresh graph is minimal; only explicit legacy translation choices migrate; saved graphs take precedence', () => {
  const fresh = storage(), minimal = defaultGraph();
  assert.deepEqual(minimal.nodes.map(n => n.type), ['ChromeTabAudio', 'SpeechToTextReazonSpeech', 'LiveTextDisplay']);
  assert.deepEqual(minimal.edges, [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'transcript', 'replace'), edge('speech', 'final', 'transcript', 'append')]);
  assert.deepEqual(minimal.nodes[2].settings, { label: 'Text', language: 'und' });
  assert.deepEqual(readGraph(fresh), minimal);
  for (const legacy of ['{broken', '{}', '{"direction":"en-ja"}', '{"enabled":"true"}']) {
    const store = storage(); store.setItem('opus-mt-translation-preferences', legacy);
    assert.equal(readGraph(store).nodes.length, 3);
  }
  for (const enabled of [false, true]) for (const direction of ['ja-en', 'en-ja']) {
    const store = storage(); store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled, direction }));
    const graph = readGraph(store); assert.equal(graph.translationDirection, direction); assert.equal(graph.nodes.length, enabled ? 6 : 3);
    assert.equal(store.getItem('opus-mt-translation-preferences'), null);
    assert.deepEqual(readGraph(store), graph);
  }
  const store = storage(); store.setItem(GRAPH_KEY, '{broken'); assert.throws(() => readGraph(store));
  saveGraph(store, defaultGraph({ enabled: false })); assert.equal(readGraph(store).nodes.length, 3);
  store.setItem('opus-mt-translation-preferences', '{broken'); assert.equal(readGraph(store).nodes.length, 3);
  assert.throws(() => saveGraph({ setItem() { throw Error('Quota'); } }, defaultGraph({ enabled: true })), /Quota/);
});

test('current custom and translation graphs reload byte-for-byte without preference migration or default rewiring', () => {
  for (const enabled of [false, true]) {
    const store = storage(), graph = defaultGraph({ enabled, direction: 'en-ja' });
    graph.nodes[2].settings = { label: 'My custom display', language: 'ja' };
    graph.nodes[0].position.x = 91;
    graph.nodes.push(graphNode('TextFormatter', 'custom'));
    graph.nodes.at(-1).settings.template = 'Final: {1}';
    graph.edges = graph.edges.filter(e => !(e.to[0] === 'transcript' && e.to[1] === 'append'));
    graph.edges.push(edge('speech', 'final', 'custom', 'input1'), edge('custom', 'text', 'transcript', 'append'));
    const raw = JSON.stringify(graph, null, 2); store.setItem(GRAPH_KEY, raw);
    store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: !enabled, direction: 'ja-en' }));
    assert.deepEqual(readGraph(store), graph); assert.deepEqual(readGraph(store), graph);
    assert.equal(store.getItem(GRAPH_KEY), raw);
  }
});

for (const [name, edit, pattern] of [
  ['version', g => g.version = 99, /version/],
  ['unknown type', g => g.nodes[0].type = 'toString', /Unknown Node/],
  ['duplicate ID', g => g.nodes[1].id = 'audio', /Duplicate Node/],
  ['bad port', g => g.edges[0].from[1] = 'toString', /Unknown port/],
  ['incompatible type', g => g.edges[0].from = ['speech', 'final'], /Incompatible/],
  ['cycle', g => g.edges.push(edge('speech', 'final', 'speech', 'audio')), /acyclic/],
  ['duplicate edge', g => g.edges.push(g.edges[0]), /Duplicate edge/],
  ['multiple incoming edges', g => g.edges.push(edge('speech', 'provisional', 'translation', 'text')), /Only one connection/],
  ['missing source', g => g.nodes.shift(), /Unknown edge Node/],
  ['position', g => g.nodes[0].position.x = Infinity, /Invalid position/],
  ['settings', g => g.nodes[2].settings.model = 'remote', /Unknown setting/],
  ['malformed edge', g => g.edges.push({ from: null }), /Malformed/],
]) test(`schema rejects ${name} before saving or constructing Workers`, () => {
  const graph = defaultGraph({ enabled: true }); edit(graph);
  assert.match(validateGraph(graph).join('\n'), pattern);
  assert.throws(() => assertGraph(graph), pattern);
  assert.throws(() => buildGraph(graph, {}), pattern);
});

// Migration changes pending/history behavior, so tests explicitly review the candidate.
function repair(graph) {
  try { return assertGraph(graph); }
  catch (error) { if (!error.recoveryGraph) throw error; return assertGraph(error.recoveryGraph); }
}
test('versions 1–8 explicitly review paired migration, retain originals and preserve unrelated data/routes', () => {
  for (const version of [1, 2, 3, 4, 5, 6, 7, 8]) for (const direction of ['ja-en', 'en-ja']) {
    let graph = legacyGraph({ direction }, Math.min(version, 5));
    if (version > 5) {
      graph = structuredClone(graph); graph.version = version;
      graph.nodes.find(n => n.id === 'transcript').type = 'LiveTextDisplay';
      graph.nodes.find(n => n.id === 'transcript').settings = { label: 'Original custom', language: 'ja' };
      graph.edges.filter(e => e.to[0] === 'transcript').forEach(e => e.to[1] = e.to[1] === 'final' ? 'append' : 'replace');
      const translated = graph.nodes.find(n => n.id === 'translated'); translated.type = 'PairedTextFormatter';
      graph.nodes.push(graphNode('LiveTextDisplay', 'custom-sink', 800, 900));
      graph.nodes.at(-1).settings.label = 'My translation';
      graph.edges.push(edge('translated', 'text', 'custom-sink', 'replace'));
      if (version >= 7) graph.nodes.find(n => n.id === 'speech').type = 'SpeechToTextReazonSpeech';
    }
    graph.nodes.push(graphNode('Text', 'literal', 6100, 6200), graphNode('LiveTextDisplay', 'field'));
    graph.nodes.at(-2).settings.value = 'Stored <content>\n{1}';
    graph.edges.push(edge('literal', 'value', 'field', 'append'));
    const raw = JSON.stringify(graph), store = storage(); store.setItem(GRAPH_KEY, raw);
    let candidate;
    assert.throws(() => readGraph(store), error => { candidate = error.recoveryGraph; return /migration needs review/.test(error.message) && !!candidate; });
    assert.equal(store.getItem(GRAPH_KEY), raw);
    const migrated = assertGraph(candidate); assert.equal(migrated.version, GRAPH_VERSION);
    assert.equal(migrated.nodes.some(n => n.type === 'PairedTextFormatter'), false);
    assert.deepEqual(migrated.nodes.find(n => n.id === 'literal'), graph.nodes.find(n => n.id === 'literal'));
    assert.ok(migrated.edges.some(e => e.from[0] === 'literal' && e.to[0] === 'field'));
    assert.ok(migrated.edges.some(e => e.from[0] === 'translation' && e.from[1] === 'source' && e.to[1] === 'input1'));
    if (version > 5) assert.equal(migrated.nodes.find(n => n.id === 'custom-sink').settings.label, 'My translation');
    saveGraph(store, migrated); assert.equal(store.getItem(GRAPH_RECOVERY_KEY), raw); assert.deepEqual(readGraph(store), migrated);
  }
  const invalid = legacyGraph({}, 4); invalid.edges.push(edge('translation', 'finalResult', 'transcript', 'final'));
  const store = storage(); store.setItem(GRAPH_KEY, JSON.stringify(invalid));
  assert.throws(() => readGraph(store), /Cannot migrate/); assert.equal(store.getItem(GRAPH_KEY), JSON.stringify(invalid));
});

test('v8 plain consumers retain TEXT fan-out; unsupported diagnostic routes are visible in recovery and original backup', () => {
  const graph = defaultGraph({ enabled: true }); graph.version = 8;
  graph.nodes = graph.nodes.filter(n => n.id !== 'translated-format');
  graph.edges = graph.edges.filter(e => e.from[0] !== 'translated-format' && e.to[0] !== 'translated-format');
  graph.nodes.push(graphNode('Number', 'duration'));
  graph.edges.push(edge('translation', 'text', 'translated', 'append'), edge('translation', 'finalIndex', 'speech', 'maxDuration'));
  const raw = structuredClone(graph), migrated = repair(graph);
  assert.deepEqual(graph, raw); assert.ok(migrated.edges.some(e => e.from[0] === 'translation' && e.from[1] === 'text'));
  assert.ok(!migrated.edges.some(e => e.from[1] === 'finalIndex')); assert.equal(migrated.nodes.at(-1).id, 'duration');
});

test('concrete supported descriptions instantiate actual Nodes with identical contract identities and the exact saved edges', () => {
  for (const graph of [defaultGraph({ enabled: true }), defaultGraph({ enabled: false }), defaultGraph({ enabled: true, direction: 'en-ja' }), audioGraph('Supertonic3'), audioGraph('Kokoro', true)]) {
    const result = buildGraph(graph, { tabId: 42, onTranscript() {}, onTranslation() {}, onTranslationState() {}, prepareTranslation() {}, onSynthesizedAudio() {} });
    assert.ok(result.pipeline instanceof Pipeline);
    assert.ok(result.audioSources.get('audio') instanceof ExtensionTabAudioNode); assert.ok(result.speechNodes.get('speech') instanceof SpeechToTextNode);
    assert.ok(result.pipeline.entries.get('transcript').node instanceof LiveTextDisplayNode);
    for (const translation of result.translations) assert.ok(translation instanceof TranslationSchedulerNode);
    for (const spec of graph.nodes) {
      const actual = result.pipeline.entries.get(spec.id);
      assert.deepEqual(actual.inputs, nodeDefinition(spec).inputs); assert.deepEqual(actual.outputs, NODE_TYPES[spec.type].outputs);
      if (spec.type === 'Supertonic3') assert.ok(actual.node.node instanceof Supertonic3TextToSpeechNode);
      if (spec.type === 'Kokoro') assert.ok(actual.node.node instanceof KokoroTextToSpeechNode);
    }
    assert.deepEqual(result.description.edges, graph.edges);
    graph.nodes[0].position.x += 100; assert.notEqual(result.description.nodes[0].position.x, graph.nodes[0].position.x);
  }
});

test('direction and translation controls retain saved audio nodes; disabling translation removes dependent audio only', () => {
  const original = audioGraph('Kokoro');
  const enabled = withTranslation(original, { enabled: true, direction: 'en-ja' });
  assert.ok(enabled.nodes.some(n => n.type === 'Kokoro')); assert.ok(enabled.nodes.some(n => n.type === 'OpusMtEnJa'));
  const disabled = withTranslation(enabled, { enabled: false, direction: 'ja-en' });
  assert.ok(disabled.nodes.some(n => n.type === 'Kokoro'));
  assert.equal(withTranslation(audioGraph('Kokoro', true), { enabled: false, direction: 'en-ja' }).nodes.length, 3);
});

for (const type of ['OpusMtJaEn', 'TranslateGemmaEnJa']) test(`${type}: ASR final TEXT → actual formatter, field and Kokoro Nodes drains completed finals in order`, async () => {
  const graph = audioGraph('Kokoro', true); graph.edges.reverse();
  graph.nodes.find(node => node.id === 'translation').type = type;
  graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'));
  graph.edges.push(edge('translation', 'text', 'field', 'text'));
  const texts = [], fieldTexts = [], audio = [], rows = [], workers = [];
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
    outputTarget: { tabId: 42, documentId: 'owned-document', label: 'Test field' },
    pageConnectionFactory: () => ({ request: async (type, value) => { if (type === 'append') fieldTexts.push(value.text); return { inserted: true }; }, close() {} }),
    workerFactory: factory(), translationWorkerFactory: factory(), ttsWorkerFactory: factory(),
    prepareTranslation: async () => {}, prepareTranslateGemma: async () => {}, prepareTts: async () => {}, onDisplay: (id, state) => { if (id === 'transcript') rows.splice(0, rows.length, ...state.items); },
    onTranslation() {}, onTranslationState() {}, onSynthesizedAudio: value => audio.push(value) });
  await built.pipeline.start();
  built.speechNodes.get('speech').receiveEvent({ type: 'partial', text: 'provisional', id: 0 });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(texts, []);
  built.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'one', id: 0 });
  built.speechNodes.get('speech').receiveEvent({ type: 'final', text: 'two', id: 1 });
  const long = 'a'.repeat(299) + '😀' + 'b'.repeat(302);
  built.speechNodes.get('speech').receiveEvent({ type: 'final', text: long, id: 2 });
  await built.pipeline.stop(); await built.pipeline.dispose();
  assert.deepEqual(rows, ['one', 'two', long]); assert.deepEqual(texts.slice(0, 2), ['Translated one', 'Translated two']);
  assert.deepEqual(fieldTexts, ['Translated one', 'Translated two', 'Translated ' + long]);
  assert.equal(texts.slice(2).join(''), 'Translated ' + long); assert.ok(texts.every(text => text.length <= 300 && !/[\uD800-\uDBFF]$/.test(text)));
  assert.equal(audio.length, texts.length);
  assert.ok(workers.every(worker => worker.released));
});

test('TEXT routing is independent of producer; ASR previews cannot use the window-only translator input', () => {
  const graph = defaultGraph({ enabled: true });
  graph.edges = graph.edges.filter(route => !(route.to[0] === 'transcript' && route.to[1] === 'replace') && route.to[1] !== 'provisional');
  // A translated stream can be the full transcript destination, independently
  // of the scheduler's paired diagnostic view. No producer identity is required.
  graph.edges.find(route => route.to[0] === 'transcript').from = ['translation', 'text'];
  graph.nodes.find(node => node.id === 'transcript').settings.label = 'Any text';
  assert.deepEqual(validateGraph(graph), []);
  assert.ok(buildGraph(graph, {}).pipeline);
  graph.edges.push(edge('speech', 'final', 'translation', 'provisional'));
  assert.match(validateGraph(graph).join(' '), /same TextWindow/); graph.edges.pop();
  graph.edges.find(route => route.to[0] === 'translation' && route.to[1] === 'text').from = ['translation', 'text'];
  assert.match(validateGraph(graph).join('\n'), /acyclic/);
});

test('v5 migration preserves independent language, maximum IDs and fan-out; large drafts migrate without a node cap', () => {
  const legacy = legacyGraph({ direction: 'en-ja' }, 5), longId = 'x'.repeat(64);
  legacy.nodes.find(n => n.id === 'transcript').settings.direction = 'ja-en';
  legacy.nodes.find(n => n.id === 'translated').id = longId;
  for (const route of legacy.edges) if (route.to[0] === 'translated') route.to[0] = longId;
  legacy.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'), graphNode('FocusedInputTextOutputNode', longId.slice(0, 62) + '-2'));
  legacy.edges.push(edge('translation', 'text', 'field', 'text'), edge('speech', 'final', longId.slice(0, 62) + '-2', 'text'));
  const migrated = repair(legacy);
  assert.equal(migrated.nodes.find(n => n.id === 'transcript').settings.language, 'ja');
  assert.equal(migrated.nodes.find(n => n.type === 'TextFormatter').settings.template, 'English: {1}\nJapanese: {2}{3}');
  assert.ok(migrated.nodes.every(n => n.id.length <= 64)); assert.equal(new Set(migrated.nodes.map(n => n.id)).size, migrated.nodes.length);
  assert.ok(migrated.edges.some(e => JSON.stringify(e) === JSON.stringify(edge('translation', 'text', 'field', 'text'))));
  while (legacy.nodes.length < 24) { const id = 'field-' + legacy.nodes.length; legacy.nodes.push(graphNode('FocusedInputTextOutputNode', id)); legacy.edges.push(edge('speech', 'final', id, 'text')); }
  const store = storage(), saved = JSON.stringify(legacy); store.setItem(GRAPH_KEY, saved);
  assert.throws(() => readGraph(store), /migration needs review/);
  assert.equal(repair(legacy).nodes.length, 25);
});

test('disabling translation retains a shared display and all unaffected routes', () => {
  const graph = defaultGraph({ enabled: true }); graph.edges.find(e => e.to[0] === 'transcript' && e.to[1] === 'append').from = ['translation', 'text'];
  const disabled = withTranslation(graph, { enabled: false, direction: 'ja-en' });
  assert.ok(disabled.nodes.some(n => n.id === 'transcript'));
  assert.deepEqual(disabled.edges, [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'transcript', 'replace')]);
});

test('multiple processing directions prepare independently of sink labels and graph preference', async () => {
  const graph = defaultGraph({ enabled: false }); graph.translationDirection = 'en-ja';
  for (const [type, id] of [['OpusMtJaEn', 'forward'], ['OpusMtEnJa', 'reverse']]) {
    graph.nodes.push(graphNode(type, id), graphNode('LiveTextDisplay', id + '-display'));
    graph.nodes.at(-1).settings.label = 'Any arbitrary label'; graph.edges.push(edge('speech', 'final', id, 'text'), edge(id, 'text', id + '-display', 'append'));
  }
  const directions = [], built = buildGraph(graph, { workerFactory: () => ({ postMessage() {}, terminate() {} }), sourceFactory: () => ({ start() {}, stop() {} }), prepareTranslation: async (signal, direction) => { directions.push(direction); throw Error('Fixture unavailable'); } });
  // Use the production scheduler start hook; ASR model setup is unrelated here.
  for (const id of ['forward', 'reverse']) { const entry = built.pipeline.entries.get(id); entry.node.start(entry.context); }
  await Promise.all(built.translations.map(n => n.ready)); assert.deepEqual(directions.sort(), ['en-ja', 'ja-en']);
  await built.pipeline.dispose();
});


test('v8 migration retains shared displays, formatter fan-out and independent formatter content; backup failure preserves original', () => {
  const graph = defaultGraph({ enabled: true }); graph.version = 8;
  const formatter = graph.nodes.find(n => n.id === 'translated-format');
  formatter.type = 'PairedTextFormatter'; formatter.settings = { direction: 'ja-en' }; formatter.position = { x: 6000, y: 7000 };
  const display = graph.nodes.find(n => n.id === 'translated'); display.settings.label = 'User label';
  graph.edges = graph.edges.filter(e => e.to[0] !== formatter.id);
  for (const port of ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError']) graph.edges.push(edge('translation', port, formatter.id, port));
  graph.edges.find(e => e.from[0] === formatter.id).to[1] = 'replace';
  graph.nodes.push(graphNode('FocusedInputTextOutputNode', 'field'), graphNode('TextFormatter', 'independent'), graphNode('Text', 'literal'));
  graph.nodes.at(-2).settings = { template: 'User template: {4}\n{{}}' };
  graph.nodes.at(-1).settings.value = 'Stored literal';
  graph.edges.push(edge('speech', 'final', 'translated', 'append'), edge(formatter.id, 'text', 'field', 'text'), edge('literal', 'value', 'independent', 'input4'));
  let migration;
  assert.throws(() => assertGraph(graph), error => { migration = error; return /latest-result TEXT replaces whole-history/.test(error.message); });
  const next = assertGraph(migration.recoveryGraph);
  assert.deepEqual(next.nodes.find(n => n.id === formatter.id).position, formatter.position);
  assert.equal(next.nodes.find(n => n.id === display.id).settings.label, 'User label');
  assert.deepEqual(next.nodes.find(n => n.id === 'independent').settings, { template: 'User template: {4}\n{{}}', inputCount: 4 });
  for (const route of [edge(formatter.id, 'text', 'field', 'text'), edge(formatter.id, 'text', 'translated', 'replace'), edge('speech', 'final', 'translated', 'append'), edge('literal', 'value', 'independent', 'input4')]) assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(route)));
  const store = storage(), raw = JSON.stringify(graph); store.setItem(GRAPH_KEY, raw);
  const failing = { ...store, setItem(key, value) { if (key === GRAPH_RECOVERY_KEY) throw Error('Quota'); store.setItem(key, value); } };
  assert.throws(() => saveGraph(failing, next), /Quota/); assert.equal(store.getItem(GRAPH_KEY), raw);
  saveGraph(store, next); saveGraph(store, defaultGraph()); assert.equal(store.getItem(GRAPH_RECOVERY_KEY), raw);
});
