import { addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph, readGraph, saveGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY, GRAPH_VERSION, NODE_TYPES, nodeDefinition } from '../extension/graph.js';
import { legacyGraph } from './fixtures/legacy-graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { LiveTextDisplayNode } from '../web/text-nodes.js';
import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { ExtensionTabAudioNode } from '../extension/tab-audio-node.js';
import { TranslationSchedulerNode } from '../extension/translation-scheduler.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('Number startup configuration retains ordinary edges and saved snapshot isolation', async () => {
  const store = storage(), graph = defaultGraph();
  const options = { workerFactory: () => ({ postMessage(data) { if (data.type === 'load') queueMicrotask(() => this.onmessage({data:{type:'ready'}})); }, terminate() {} }), sourceFactory: () => ({ start() {}, stop() {} }) };
  graph.nodes.push(graphNode('Number', 'duration')); graph.nodes.at(-1).settings.value = 1.234567;
  graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'));
  saveGraph(store, graph); const built = buildGraph(readGraph(store), options);
  assert.equal(built.speechNodes.get('speech').core.state, 'released');
  graph.nodes.at(-1).settings.value = 9.5; saveGraph(store, graph);
  await built.pipeline.start(); await built.pipeline.entries.get('speech').queue;
  assert.equal(built.speechNodes.get('speech').maxDuration, 1.234567);
  const next = buildGraph(readGraph(store), options); await next.pipeline.start(); await next.pipeline.entries.get('speech').queue;
  assert.equal(next.speechNodes.get('speech').maxDuration, 9.5);
  assert.deepEqual(built.description.edges, graph.edges);
  await built.pipeline.dispose(); await next.pipeline.dispose();
});

test('consumer duration validation happens on delivery; finite constants and incomplete drafts stay saveable', async () => {
  for (const value of [0, -1, 0.9, 12.01]) {
    const graph = defaultGraph(); graph.nodes.push(graphNode('Number', 'duration'));
    graph.nodes.at(-1).settings.value = value; graph.edges.push(edge('duration', 'value', 'speech', 'maxDuration'));
    saveGraph(storage(), graph);
    const built = buildGraph(graph, { workerFactory() { assert.fail('Invalid configuration must not create Workers'); }, sourceFactory: () => ({start(){},stop(){}}) });
    await built.pipeline.start().catch(() => {}); await built.pipeline.entries.get('speech').queue;
    assert.match(built.pipeline.errors.map(e => e.message).join(' '), /1 to 12 seconds/);
    await built.pipeline.dispose();
  }
  for (const value of [NaN, Infinity, -Infinity, null, undefined, '2']) {
    const graph = defaultGraph(); graph.nodes.push(graphNode('Number','duration')); graph.nodes.at(-1).settings.value = value;
    assert.throws(() => saveGraph(storage(), graph), /finite number/);
  }
});
const audioGraph = (type, translated = false) => {
  const graph = defaultGraph({ enabled: translated });
  graph.nodes.push(graphNode(type, 'tts'), graphNode('AudioOutput', 'player'));
  graph.edges.push(edge(translated ? 'translation' : 'speech', translated ? 'text' : 'final', 'tts', 'text'), edge('tts', 'audio', 'player', 'audio'));
  return graph;
};

test('fresh graph is minimal; only explicit legacy translation choices migrate; saved graphs take precedence', () => {
  const fresh = storage(), minimal = defaultGraph();
  assert.deepEqual(minimal.nodes.map(n => n.type), ['ChromeTabAudio', 'SpeechToTextReazonSpeech', 'LiveTextDisplay', 'TextAccumulator', 'TextToDOM']);
  assert.deepEqual(minimal.edges, [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'transcript-accumulator', 'preview'), edge('speech', 'final', 'transcript-accumulator', 'append'), edge('transcript-accumulator', 'text', 'transcript-dom', 'text'), edge('transcript-dom', 'dom', 'transcript', 'dom')]);
  assert.deepEqual(minimal.nodes[2].settings, { label: 'Text', language: 'und' });
  assert.deepEqual(readGraph(fresh), minimal);
  for (const legacy of ['{broken', '{}', '{"direction":"en-ja"}', '{"enabled":"true"}']) {
    const store = storage(); store.setItem('opus-mt-translation-preferences', legacy);
    assert.equal(readGraph(store).nodes.length, 5);
  }
  for (const enabled of [false, true]) for (const direction of ['ja-en', 'en-ja']) {
    const store = storage(); store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled, direction }));
    const graph = readGraph(store); assert.equal(graph.translationDirection, direction); assert.equal(graph.nodes.length, enabled ? 8 : 5);
    assert.equal(store.getItem('opus-mt-translation-preferences'), null);
    assert.deepEqual(readGraph(store), graph);
  }
  const store = storage(); store.setItem(GRAPH_KEY, '{broken'); assert.throws(() => readGraph(store));
  saveGraph(store, defaultGraph({ enabled: false })); assert.equal(readGraph(store).nodes.length, 5);
  store.setItem('opus-mt-translation-preferences', '{broken'); assert.equal(readGraph(store).nodes.length, 5);
  assert.throws(() => saveGraph({ setItem() { throw Error('Quota'); } }, defaultGraph({ enabled: true })), /Quota/);
});

test('current custom and translation graphs reload byte-for-byte without preference migration or default rewiring', () => {
  for (const enabled of [false, true]) {
    const store = storage(), graph = defaultGraph({ enabled, direction: 'en-ja' });
    graph.nodes[2].settings = { label: 'My custom display', language: 'ja' };
    graph.nodes[0].position.x = 91;
    graph.nodes.push(graphNode('TextFormatter', 'custom'));
    graph.nodes.at(-1).settings.template = 'Final: {1}';
    graph.edges = graph.edges.filter(e => !(e.to[0] === 'transcript-accumulator' && e.to[1] === 'append'));
    graph.edges.push(edge('speech', 'final', 'custom', 'input1'), edge('custom', 'text', 'transcript-accumulator', 'append'));
    const raw = JSON.stringify(graph, null, 2); store.setItem(GRAPH_KEY, raw);
    store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: !enabled, direction: 'ja-en' }));
    assert.deepEqual(readGraph(store), graph); assert.deepEqual(readGraph(store), graph);
    assert.equal(store.getItem(GRAPH_KEY), raw);
  }
});

test('enabled legacy preferences never replace a corrupt saved graph; explicit recovery retains its original', () => {
  for (const direction of ['ja-en', 'en-ja']) {
    const store = storage(), preferences = JSON.stringify({ enabled: true, direction });
    store.setItem(GRAPH_KEY, '{broken');
    store.setItem('opus-mt-translation-preferences', preferences);
    assert.throws(() => readGraph(store), /Invalid saved graph/);
    assert.equal(store.getItem(GRAPH_KEY), '{broken');
    assert.equal(store.getItem('opus-mt-translation-preferences'), preferences);
    assert.equal(store.getItem(GRAPH_RECOVERY_KEY), null);
    const recovered = defaultGraph(); // Graph Editor's explicit Reset + Save.
    saveGraph(store, recovered);
    assert.deepEqual(readGraph(store), recovered);
    assert.equal(store.getItem(GRAPH_RECOVERY_KEY), '{broken');
    assert.equal(store.getItem('opus-mt-translation-preferences'), null);
  }
});

test('explicit multi-output bilingual graphs retain original and unrelated routes through Save/reload', () => {
  for (const direction of ['ja-en', 'en-ja']) {
    const store = storage(), graph = defaultGraph({ enabled: true, direction });
    graph.nodes.find(n => n.id === 'transcript').settings.label = 'My full transcript';
    graph.nodes.push(graphNode('LiveTextDisplay', 'another-original'), graphNode('FocusedInputTextOutputNode', 'field'));
    graph.edges.push(edge('transcript-dom', 'dom', 'another-original', 'dom'), edge('translation', 'text', 'field', 'text'));
    const expected = structuredClone(graph);
    saveGraph(store, graph);
    store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled: false, direction: direction === 'ja-en' ? 'en-ja' : 'ja-en' }));
    const raw = store.getItem(GRAPH_KEY), loaded = readGraph(store);
    assert.deepEqual(loaded, expected);
    assert.equal(store.getItem(GRAPH_KEY), raw);
    saveGraph(store, loaded);
    assert.deepEqual(readGraph(store), expected);
    assert.equal(store.getItem(GRAPH_KEY), raw);
    assert.equal(store.getItem('opus-mt-translation-preferences'), null);
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
    assert.ok(migrated.edges.some(e => e.from[0] === 'literal' && e.to[0] === 'field-accumulator'));
    assert.ok(migrated.edges.some(e => e.from[0] === 'translation' && e.from[1] === 'source' && e.to[1] === 'input1'));
    if (version > 5) assert.equal(migrated.nodes.find(n => n.id === 'custom-sink').settings.label, 'My translation');
    saveGraph(store, migrated); assert.equal(store.getItem(GRAPH_RECOVERY_KEY), raw); assert.deepEqual(readGraph(store), migrated);
  }
  const invalid = legacyGraph({}, 4); invalid.edges.push(edge('translation', 'finalResult', 'transcript', 'final'));
  const store = storage(); store.setItem(GRAPH_KEY, JSON.stringify(invalid));
  assert.throws(() => readGraph(store), /Cannot migrate/); assert.equal(store.getItem(GRAPH_KEY), JSON.stringify(invalid));
});

test('v8 plain consumers retain TEXT fan-out; unsupported diagnostic routes are visible in recovery and original backup', () => {
  const graph = v9Default({ enabled: true }); graph.version = 8;
  graph.nodes = graph.nodes.filter(n => n.id !== 'translated-format');
  graph.edges = graph.edges.filter(e => e.from[0] !== 'translated-format' && e.to[0] !== 'translated-format');
  graph.nodes.push(graphNode('Number', 'duration'));
  graph.edges.push(edge('translation', 'text', 'translated', 'append'), edge('translation', 'finalIndex', 'speech', 'maxDuration'));
  const raw = structuredClone(graph), migrated = repair(graph);
  assert.deepEqual(graph, raw); assert.ok(migrated.edges.some(e => e.from[0] === 'translation' && e.from[1] === 'text'));
  assert.ok(!migrated.edges.some(e => e.from[1] === 'finalIndex')); assert.ok(migrated.nodes.some(n => n.id === 'duration'));
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
    prepareTranslation: async () => {}, prepareTranslateGemma: async () => {}, prepareTts: async () => {}, onDisplay: (id, state) => { state = domText(state); if (id === 'transcript') rows.splice(0, rows.length, ...state.split('\n')); },
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

test('TEXT routing and optional translator previews are independent of producer', () => {
  const graph = defaultGraph({ enabled: true });
  graph.edges = graph.edges.filter(route => !(route.to[0] === 'transcript' && route.to[1] === 'replace') && route.to[1] !== 'provisional');
  // A translated stream can be the full transcript destination, independently
  // of the scheduler's paired diagnostic view. No producer identity is required.
  graph.edges.find(route => route.to[0] === 'transcript-dom').from = ['translation', 'text'];
  graph.nodes.find(node => node.id === 'transcript').settings.label = 'Any text';
  assert.deepEqual(validateGraph(graph), []);
  assert.ok(buildGraph(graph, {}).pipeline);
  graph.edges.push(edge('speech', 'final', 'translation', 'provisional'));
  assert.deepEqual(validateGraph(graph), []); assert.ok(buildGraph(graph, {}).pipeline); graph.edges.pop();
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
  assert.equal(repair(legacy).nodes.length, 29);
});

test('multiple processing directions prepare independently of sink labels and graph preference', async () => {
  const graph = defaultGraph({ enabled: false }); graph.translationDirection = 'en-ja';
  for (const [type, id] of [['OpusMtJaEn', 'forward'], ['OpusMtEnJa', 'reverse']]) {
    graph.nodes.push(graphNode(type, id), graphNode('LiveTextDisplay', id + '-display'));
    graph.nodes.at(-1).settings.label = 'Any arbitrary label'; graph.edges.push(edge('speech', 'final', id, 'text'), edge(id, 'text', id + '-display', 'content'));
  }
  const directions = [], built = buildGraph(addDOMFormatters(graph), { workerFactory: () => ({ postMessage() {}, terminate() {} }), sourceFactory: () => ({ start() {}, stop() {} }), prepareTranslation: async (signal, direction) => { directions.push(direction); throw Error('Fixture unavailable'); } });
  // Use the production scheduler start hook; ASR model setup is unrelated here.
  for (const id of ['forward', 'reverse']) { const entry = built.pipeline.entries.get(id); entry.node.start(entry.context); }
  await Promise.all(built.translations.map(n => n.ready)); assert.deepEqual(directions.sort(), ['en-ja', 'ja-en']);
  await built.pipeline.dispose();
});


test('v8 migration retains shared displays, formatter fan-out and independent formatter content; backup failure preserves original', () => {
  const graph = v9Default({ enabled: true }); graph.version = 8;
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
  for (const route of [edge(formatter.id, 'text', 'field', 'text'), edge(formatter.id, 'text', 'translated-accumulator', 'preview'), edge('speech', 'final', 'translated-accumulator', 'append'), edge('literal', 'value', 'independent', 'input4')]) assert.ok(next.edges.some(e => JSON.stringify(e) === JSON.stringify(route)));
  const store = storage(), raw = JSON.stringify(graph); store.setItem(GRAPH_KEY, raw);
  const failing = { ...store, setItem(key, value) { if (key === GRAPH_RECOVERY_KEY) throw Error('Quota'); store.setItem(key, value); } };
  assert.throws(() => saveGraph(failing, next), /Quota/); assert.equal(store.getItem(GRAPH_KEY), raw);
  saveGraph(store, next); saveGraph(store, defaultGraph()); assert.equal(store.getItem(GRAPH_RECOVERY_KEY), raw);
});


function v9Default({ enabled = false, direction = 'ja-en' } = {}) {
  const nodes = [graphNode('ChromeTabAudio','audio'),graphNode('SpeechToTextReazonSpeech','speech'),graphNode('LiveTextDisplay','transcript')];
  const edges = [edge('audio','audio','speech','audio'),edge('speech','provisional','transcript','replace'),edge('speech','final','transcript','append')];
  if (enabled) {
    nodes.push(graphNode(direction === 'en-ja' ? 'OpusMtEnJa':'OpusMtJaEn','translation'),graphNode('LiveTextDisplay','translated'),graphNode('TextFormatter','translated-format'));
    nodes[5].settings = {inputCount:3,template:direction === 'en-ja'?'English: {1}\nJapanese: {2}{3}':'Japanese: {1}\nEnglish: {2}{3}'};
    edges.push(edge('speech','final','translation','text'),...['source','text','error'].map((port,index)=>edge('translation',port,'translated-format',`input${index+1}`)),edge('translated-format','text','translated','append'));
  }
  return {version:9,translationDirection:direction,nodes,edges};
}

test('saved multi-direction graphs and explicit edits preserve shared sinks, independent paths and incomplete drafts', async () => {
  const { TabSession } = await import('../extension/session.js');
  const { graphPreferences } = await import('../extension/graph.js');
  const graph = defaultGraph({ enabled: true, direction: 'ja-en' });
  graph.nodes.push(graphNode('OpusMtEnJa', 'reverse'), graphNode('OpusMtJaEn', 'another'),
    graphNode('TextFormatter', 'shared'), graphNode('TextToDOM', 'shared-dom'), graphNode('LiveTextDisplay', 'shared-view'),
    graphNode('FocusedInputTextOutputNode', 'field'), graphNode('OpusMtEnJa', 'parked'));
  graph.edges.push(edge('speech', 'final', 'reverse', 'text'), edge('speech', 'final', 'another', 'text'),
    edge('translation', 'text', 'shared', 'input1'), edge('reverse', 'text', 'shared', 'input2'), edge('another', 'text', 'shared', 'input3'),
    edge('shared', 'text', 'shared-dom', 'text'), edge('shared-dom', 'dom', 'shared-view', 'dom'), edge('reverse', 'text', 'field', 'text'));
  graph.translationDirection = 'en-ja';
  const original = structuredClone(graph), store = storage();
  saveGraph(store, graph);
  const saved = store.getItem(GRAPH_KEY);
  // Obsolete stored choices cannot control an existing explicit graph.
  for (const enabled of [false, true]) for (const direction of ['ja-en', 'en-ja']) {
    store.setItem('opus-mt-translation-preferences', JSON.stringify({ enabled, direction }));
    assert.deepEqual(readGraph(store), original);
    assert.deepEqual(graphPreferences(graph), { enabled: true, direction: 'ja-en' });
    assert.equal(store.getItem(GRAPH_KEY), saved);
  }
  const session = new TabSession(() => {}, { graph });
  const edited = structuredClone(graph); edited.nodes.find(n => n.id === 'reverse').position.x += 50;
  edited.nodes.find(n => n.id === 'reverse').type = 'OpusMtJaEn';
  session.setGraph(edited); saveGraph(store, session.graph);
  assert.deepEqual(readGraph(store), edited);
  assert.deepEqual(readGraph(store).edges, original.edges);
  assert.deepEqual(graph, original);
  assert.equal(store.getItem(GRAPH_RECOVERY_KEY), null);
});
