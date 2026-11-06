import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASR_TYPES, NODE_TYPES, graphNode, nodeDefinition, portDisplayEntries, defaultGraph, assertGraph } from '../extension/graph.js';
import { asrOutputs, ASR_OUTPUT_GROUPS } from '../web/transcription-nodes.js';
import { TRANSLATION_OUTPUTS, TRANSLATION_OUTPUT_GROUPS } from '../extension/translation-scheduler.js';

const names = (definition, side) => portDisplayEntries(definition, side).map(([name]) => name);
const translators = ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa'];
for (const type of ASR_TYPES) test(`${type} shows committed data/ID before preview without changing runtime declarations`, () => {
  const definition = nodeDefinition(graphNode(type, 'asr'));
  const preview = Object.hasOwn(definition.outputs, 'provisional');
  assert.deepEqual(names(definition, 'output'), ['final', 'finalId', ...(preview ? ['provisional', 'provisionalId'] : [])]);
  assert.deepEqual(definition.outputs, asrOutputs(preview));
  assert.deepEqual(Object.keys(definition.outputs), Object.keys(asrOutputs(preview)));
  assert.equal(definition.outputGroups, ASR_OUTPUT_GROUPS);
});
for (const type of ['KeyedTextCoalesce', 'KeyedTextPair']) test(`${type} shows each input before its ID`, () => {
  const definition = nodeDefinition(graphNode(type, 'keyed'));
  assert.deepEqual(names(definition, 'input'), ['input1', 'id1', 'input2', 'id2']);
  assert.deepEqual(Object.keys(definition.inputs), ['id1', 'input1', 'id2', 'input2']);
  assert.deepEqual(names(definition, 'output'), type === 'KeyedTextCoalesce' ? ['text', 'id'] : ['pair']);
});
for (const type of translators) test(`${type} keeps data/ID adjacent, context last and output families intact`, () => {
  const definition = nodeDefinition(graphNode(type, 'translation'));
  assert.deepEqual(names(definition, 'input'), ['text', 'id', 'provisional', 'provisionalId', ...(type.startsWith('TranslateGemma') ? ['context'] : [])]);
  assert.deepEqual(names(definition, 'output'), ['text', 'id', 'source', 'error', 'provisionalText', 'provisionalId', 'provisionalSource', 'provisionalError']);
  assert.deepEqual(Object.keys(definition.inputs).slice(0, 4), ['text', 'provisional', 'id', 'provisionalId']);
  assert.equal(definition.outputs, TRANSLATION_OUTPUTS);
  assert.equal(definition.outputGroups, TRANSLATION_OUTPUT_GROUPS);
  assert.deepEqual(TRANSLATION_OUTPUT_GROUPS, [['source', 'text', 'error', 'id'], ['provisionalSource', 'provisionalText', 'provisionalError', 'provisionalId']]);
});

test('display metadata ignores malformed, duplicate, inherited and unknown entries without losing ports', () => {
  const inputs = { ...NODE_TYPES.KeyedTextCoalesce.inputs }, before = Object.entries(inputs);
  for (const inputOrder of [undefined, null, {}, 'input1', 42]) {
    assert.deepEqual(portDisplayEntries({ inputs, inputOrder }, 'input'), before);
  }
  const inputOrder = ['missing', 'input2', 'input2', null, {}, 1, 'toString', '__proto__'];
  assert.deepEqual(names({ inputs, inputOrder }, 'input'), ['input2', 'id1', 'input1', 'id2']);
  assert.deepEqual(Object.entries(inputs), before);
  assert.deepEqual(inputOrder, ['missing', 'input2', 'input2', null, {}, 1, 'toString', '__proto__']);
});

test('every instance port appears exactly once with its original contract, including dynamic numbered inputs', () => {
  for (const type of Object.keys(NODE_TYPES)) for (const count of [1, 12, 32]) {
    const node = graphNode(type, 'instance');
    if (['Display', 'TextFormatter'].includes(type)) node.settings.inputCount = count;
    const definition = nodeDefinition(node);
    for (const side of ['input', 'output']) {
      const entries = portDisplayEntries(definition, side);
      assert.deepEqual([...entries].sort(), Object.entries(definition[`${side}s`]).sort());
      if (side === 'input' && ['Display', 'TextFormatter'].includes(type)) {
        assert.deepEqual(entries.map(([name]) => name), Array.from({ length: count }, (_, i) => `input${i + 1}`));
      }
    }
  }
});

test('render ordering never mutates saved version-15 graph data, named edges, settings or positions', () => {
  const graph = defaultGraph({ enabled: true }), before = JSON.stringify(graph);
  for (const node of graph.nodes) for (const side of ['input', 'output']) portDisplayEntries(nodeDefinition(node, graph), side);
  assert.equal(JSON.stringify(graph), before);
  assert.deepEqual(assertGraph(JSON.parse(before)), graph);
  assert.equal(graph.version, 15);
});
