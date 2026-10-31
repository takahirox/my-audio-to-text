import { addDOMFormatters } from './fixtures/dom-graph.js';
import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultGraph, graphNode, edge, saveGraph, readGraph, executableGraph, graphPreferences, NODE_TYPES } from '../extension/graph.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { TRANSLATE_GEMMA } from '../web/translation-models.js';
import { defineAssetSet } from '../extension/model-asset-cache.js';
import { TEXT } from '../web/port-contracts.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
test('Gemma directions share a complete immutable q4 manifest, including both external data shards and translation template', () => {
  const files = JSON.parse(readFileSync('extension/translategemma-assets.json'));
  const set = defineAssetSet({ ...TRANSLATE_GEMMA, files });
  assert.equal(set.bytes, 3111911678);
  assert.deepEqual(files.map(f => f.path), ['config.json', 'generation_config.json', 'tokenizer_config.json', 'tokenizer.json',
    'chat_template.jinja', 'onnx/model_q4.onnx', 'onnx/model_q4.onnx_data', 'onnx/model_q4.onnx_data_1']);
  assert.ok(set.files.every(f => f.url.includes(TRANSLATE_GEMMA.revision)));
  const graph = defaultGraph(), before = structuredClone(graph);
  assert.deepEqual(graphModelRequirements(graph), []);
  graph.nodes.push(graphNode('TranslateGemmaEnJa', 'en'), graphNode('TranslateGemmaJaEn', 'ja'), graphNode('TranslateGemmaEnJa', 'duplicate'));
  assert.deepEqual(graphModelRequirements(graph).map(r => r.key), ['translategemma']);
  assert.deepEqual(defaultGraph(), before);
});

for (const [type, direction] of [['TranslateGemmaEnJa', 'en-ja'], ['TranslateGemmaJaEn', 'ja-en']]) {
  test(`${type}: optional context persists explicitly without changing settings, graph version or existing routes`, () => {
    assert.deepEqual(NODE_TYPES[type].inputs, { text: TEXT, provisional: TEXT, context: TEXT });
    assert.deepEqual(NODE_TYPES[type].optionalInputs, ['provisional', 'context']);
    assert.deepEqual(graphNode(type, 'translation').settings, {});
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode('Text', 'context'), graphNode(type, 'translation'), graphNode('TextToDOM', 'dom'), graphNode('LiveTextDisplay', 'out')],
      edges: [edge('input', 'value', 'translation', 'text'), edge('translation', 'text', 'dom', 'text'), edge('dom', 'dom', 'out', 'dom')] };
    const entries = new Map(), storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
    saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
    graph.edges.push(edge('context', 'value', 'translation', 'context'));
    saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
    assert.ok(executableGraph(graph).edges.some(e => e.to[1] === 'context'));
    assert.equal(entries.size, 1, 'no migration/recovery rewrite for an additive optional port');
  });
  test(`${type}: v11 save/reload preserves independent and parked Nodes; real builder routes grouped TEXT to formatter and direct sinks`, async () => {
    const graph = { version: 15, nodes: [graphNode('Text', 'input'), graphNode(type, 'translation'),
      graphNode('TextFormatter', 'format'), graphNode('LiveTextDisplay', 'paired'), graphNode('LiveTextDisplay', 'plain'),
      graphNode('Text', 'independent'), graphNode('LiveTextDisplay', 'other'), graphNode(type, 'parked')], edges: [
      edge('input', 'value', 'translation', 'text'), edge('translation', 'source', 'format', 'input1'),
      edge('translation', 'text', 'format', 'input2'), edge('translation', 'error', 'format', 'input3'),
      edge('format', 'text', 'paired', 'content'), edge('translation', 'text', 'plain', 'content'),
      edge('independent', 'value', 'other', 'content'),
    ] };
    graph.nodes[0].settings.value = 'Original source'; graph.nodes[2].settings.template = '{1}|{2}|{3}';
    graph.nodes[5].settings.value = 'Other branch';
    const entries = new Map(), storage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) };
    saveGraph(storage, addDOMFormatters(graph)); assert.deepEqual(readGraph(storage), graph);
    assert.deepEqual(graphPreferences(graph), { enabled: true, direction });
    assert.equal(executableGraph(addDOMFormatters(graph)).nodes.some(n => n.id === 'parked'), false);
    for (const fail of [false, true]) {
      const workers = [], displays = {}, states = [];
      const built = buildGraph(addDOMFormatters(graph), { prepareTranslateGemma: async () => { if (fail) throw Error('weights evicted'); },
        onDisplay: (id, state) => { state = domText(state); displays[id] = state; }, onTranslationState: state => states.push(state),
        translationWorkerFactory: url => {
          const worker = { messages: [], postMessage(message) {
            this.messages.push(message);
            queueMicrotask(() => this.onmessage?.({ data: { id: message.id,
              type: message.type === 'load' ? 'ready' : message.type === 'translate' ? 'result' : 'drained', texts: ['Translated'] } }));
          }, terminate() { this.terminated = true; } };
          assert.ok(url.pathname.endsWith('/translategemma-worker.js')); workers.push(worker); return worker;
        } });
      await built.pipeline.start(); await built.pipeline.stop(); await built.pipeline.dispose();
      assert.deepEqual(displays.other, 'Other branch');
      assert.deepEqual(displays.plain, fail ? '' : 'Translated');
      assert.deepEqual(displays.paired, fail ? 'Original source||weights evicted' : 'Original source|Translated|');
      assert.equal(workers.length, fail ? 0 : 1);
      if (!fail) {
        assert.equal(workers[0].messages[0].direction, direction);
        assert.equal(workers[0].messages[0].cacheOnly, true); assert.equal(workers[0].terminated, true);
        assert.ok(states.includes('Local TranslateGemma 4B ready'));
      }
    }
    await tick(); assert.deepEqual(readGraph(storage), graph);
  });
}
