import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphEditor } from '../extension/graph-editor.js';
import { defaultGraph, edge, graphNode, NODE_TYPES, nodeDefinition, validateGraph } from '../extension/graph.js';

// Exercise the same transactional method used by both DOM connection gestures.
function editor(graph = defaultGraph({ enabled: true })) {
  const editor = Object.create(GraphEditor.prototype);
  Object.assign(editor, { draft: graph, draw() {}, canvas: { querySelector() {} } });
  return editor;
}
function connect(editor, source, output, target, input) {
  editor.selected = { id: source, port: output, contract: NODE_TYPES[editor.draft.nodes.find(n => n.id === source).type].outputs[output] };
  editor.connect(target, input, nodeDefinition(editor.draft.nodes.find(n => n.id === target)).inputs[input]);
}

test('reconnect replaces only occupied input; identical connection is a no-op and old source fan-out survives', () => {
  const e = editor(), original = structuredClone(e.draft.edges);
  connect(e, 'speech', 'final', 'translation', 'text');
  assert.deepEqual(e.draft.edges, original);
  connect(e, 'speech', 'provisional', 'translation', 'text');
  assert.deepEqual(e.draft.edges.filter(route => route.to[0] === 'translation' && route.to[1] === 'text'), [edge('speech', 'provisional', 'translation', 'text')]);
  assert.deepEqual(e.draft.edges.filter(route => route.to[0] !== 'translation' || route.to[1] !== 'text'), original.filter(route => route.to[0] !== 'translation' || route.to[1] !== 'text'));
  const replacement = structuredClone(e.draft.edges);
  connect(e, 'speech', 'provisional', 'translation', 'text'); assert.deepEqual(e.draft.edges, replacement);
});

test('type mismatch, self-connection, unknown ports, cycles preserve the prior edge', () => {
  const e = editor(), before = structuredClone(e.draft.edges);
  connect(e, 'audio', 'audio', 'translation', 'text'); assert.deepEqual(e.draft.edges, before);
  connect(e, 'translation', 'text', 'translation', 'text'); assert.deepEqual(e.draft.edges, before);
  connect(e, 'speech', 'final', 'translated-format', 'text'); assert.deepEqual(e.draft.edges, before);
  e.selected = { id: 'speech', port: 'missing', contract: NODE_TYPES.SpeechToTextReazonSpeech.outputs.final };
  e.connect('translation', 'text', NODE_TYPES.OpusMtJaEn.inputs.text); assert.deepEqual(e.draft.edges, before);
  assert.match(e.error, /Unknown port/);
  e.draft.nodes.push(graphNode('OpusMtEnJa', 'second'));
  e.draft.edges.push(edge('translation', 'text', 'second', 'text'));
  const withSecond = structuredClone(e.draft.edges);
  connect(e, 'second', 'text', 'translation', 'text'); assert.deepEqual(e.draft.edges, withSecond);
  assert.match(e.error, /acyclic/);
});

test('Number connects only to NUMBER; consumer value limits do not restrict edge construction', () => {
  const e = editor(defaultGraph()); e.draft.nodes.push(graphNode('Number', 'duration'));
  const before = structuredClone(e.draft.edges);
  connect(e, 'duration', 'value', 'speech', 'audio'); assert.deepEqual(e.draft.edges, before);
  connect(e, 'speech', 'final', 'speech', 'maxDuration'); assert.deepEqual(e.draft.edges, before);
  connect(e, 'audio', 'audio', 'speech', 'maxDuration'); assert.deepEqual(e.draft.edges, before);
  e.draft.nodes.at(-1).settings.value = 0;
  connect(e, 'duration', 'value', 'speech', 'maxDuration');
  assert.deepEqual(e.draft.edges, [...before, edge('duration', 'value', 'speech', 'maxDuration')]);
  e.draft.nodes.at(-1).settings.value = 2.5;
  connect(e, 'duration', 'value', 'speech', 'maxDuration');
  assert.deepEqual(e.draft.edges.at(-1), edge('duration', 'value', 'speech', 'maxDuration'));
});

test('Whisper editor connections reject the removed output and accept final for either display port', () => {
  const graph = defaultGraph(); graph.nodes[1].type = 'SpeechToTextWhisper';
  graph.edges = graph.edges.filter(route => route.from[1] !== 'provisional');
  graph.edges = graph.edges.filter(e => e.to[0] !== 'transcript');
  const e = editor(graph), before = structuredClone(graph.edges);
  e.selected = { id: 'speech', port: 'provisional', contract: NODE_TYPES.SpeechToTextWhisper.outputs.final };
  e.connect('transcript', 'content', NODE_TYPES.LiveTextDisplay.inputs.content);
  assert.match(e.error, /Unknown port: speech.provisional → transcript.content/);
  assert.deepEqual(e.draft.edges, before);
  connect(e, 'speech', 'final', 'transcript', 'content');
  assert.deepEqual(e.draft.edges, [...before, edge('speech', 'final', 'transcript', 'content')]);
});


test('formatter Add/Remove changes only that instance and the removed last wire; invalid template draft remains editable', () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('TextFormatter', 'a'), graphNode('TextFormatter', 'b'));
  graph.edges.push(edge('speech', 'final', 'a', 'input1'), edge('speech', 'final', 'a', 'input4'), edge('speech', 'final', 'b', 'input4'));
  const e = editor(graph), a = graph.nodes.at(-2), b = graph.nodes.at(-1);
  for (let i = 0; i < 3; i++) e.resizeFormatter(a, 1);
  assert.equal(a.settings.inputCount, 7); assert.equal(b.settings.inputCount, 4);
  assert.equal(Object.keys(nodeDefinition(a).inputs).length, 7);
  a.settings.template = '{7}\n{1}'; e.resizeFormatter(a, -1);
  assert.equal(a.settings.template, '{7}\n{1}'); assert.match(validateGraph(graph).join(' '), /Input \{7\} is not configured/);
  assert.equal(graph.edges.length, 7, 'unaffected wires preserved');
  e.resizeFormatter(a, 1); assert.deepEqual(validateGraph(graph), []);
  for (let i = 0; i < 4; i++) e.resizeFormatter(a, -1);
  assert.equal(a.settings.inputCount, 3);
  assert.ok(graph.edges.some(route => route.to[0] === 'a' && route.to[1] === 'input1'));
  assert.ok(!graph.edges.some(route => route.to[0] === 'a' && route.to[1] === 'input4'));
  assert.ok(graph.edges.some(route => route.to[0] === 'b' && route.to[1] === 'input4'));
});
