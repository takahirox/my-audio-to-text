import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphEditor } from '../extension/graph-editor.js';
import { defaultGraph, edge, graphNode, NODE_TYPES } from '../extension/graph.js';

// Exercise the same transactional method used by both DOM connection gestures.
function editor(graph = defaultGraph()) {
  const editor = Object.create(GraphEditor.prototype);
  Object.assign(editor, { draft: graph, draw() {}, canvas: { querySelector() {} } });
  return editor;
}
function connect(editor, source, output, target, input) {
  editor.selected = { id: source, port: output, contract: NODE_TYPES[editor.draft.nodes.find(n => n.id === source).type].outputs[output] };
  editor.connect(target, input, NODE_TYPES[editor.draft.nodes.find(n => n.id === target).type].inputs[input]);
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

test('type mismatch, self-connection, unknown ports, split correlated display and cycles preserve the prior edge', () => {
  const e = editor(), before = structuredClone(e.draft.edges);
  connect(e, 'audio', 'audio', 'translation', 'text'); assert.deepEqual(e.draft.edges, before);
  connect(e, 'translation', 'text', 'translation', 'text'); assert.deepEqual(e.draft.edges, before);
  connect(e, 'speech', 'final', 'translated', 'text'); assert.deepEqual(e.draft.edges, before);
  assert.match(e.error, /matching direct outputs/);
  e.selected = { id: 'speech', port: 'missing', contract: NODE_TYPES.SpeechToText.outputs.final };
  e.connect('translation', 'text', NODE_TYPES.OpusMtJaEn.inputs.text); assert.deepEqual(e.draft.edges, before);
  assert.match(e.error, /Unknown port/);
  e.draft.nodes.push(graphNode('OpusMtEnJa', 'second'));
  e.draft.edges.push(edge('translation', 'text', 'second', 'text'));
  const withSecond = structuredClone(e.draft.edges);
  connect(e, 'second', 'text', 'translation', 'text'); assert.deepEqual(e.draft.edges, withSecond);
  assert.match(e.error, /acyclic/);
});
