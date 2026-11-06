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
  connect(e, 'speech', 'final', 'history', 'pair'); assert.deepEqual(e.draft.edges, before);
  e.selected = { id: 'speech', port: 'missing', contract: NODE_TYPES.SpeechToTextReazonSpeech.outputs.final };
  e.connect('translation', 'text', NODE_TYPES.OpusMtJaEn.inputs.text); assert.deepEqual(e.draft.edges, before);
  assert.match(e.error, /Unknown port/);
  e.draft.nodes.push(graphNode('OpusMtEnJa', 'second'));
  e.draft.edges.push(edge('translation', 'text', 'second', 'text'));
  const withSecond = structuredClone(e.draft.edges);
  connect(e, 'second', 'text', 'translation', 'text'); assert.deepEqual(e.draft.edges, withSecond);
  assert.match(e.error, /acyclic/);
});

for (const ports of [['input1','input2'],['input2','input1']]) test(`paired editor accepts compatible alternate producers in ${ports.join('/')} order`, () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('Text','literal'),graphNode('TextFormatter','alternate'),graphNode('KeyedTextPair','another-pair'));
  const e = editor(graph);
  for (const port of ports) {
    const [id,output] = port === 'input1' ? ['literal','value'] : ['alternate','text'];
    connect(e,id,output,'another-pair',port);
    assert.ok(e.draft.edges.some(route => JSON.stringify(route) === JSON.stringify(edge(id,output,'another-pair',port))));
    assert.deepEqual(validateGraph(e.draft),[]);
  }
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

test('Whisper editor rejects provisional and accepts final directly into Display.input', () => {
  const graph = defaultGraph(); graph.nodes[1].type = 'SpeechToTextWhisper';
  graph.edges = graph.edges.filter(route => !['provisional', 'provisionalId'].includes(route.from[1]));
  graph.edges = graph.edges.filter(e => e.to[0] !== 'transcript');
  graph.edges = graph.edges.filter(route => route.to[0] !== 'transcript');
  const e = editor(graph), before = structuredClone(graph.edges);
  e.selected = { id: 'speech', port: 'provisional', contract: NODE_TYPES.SpeechToTextWhisper.outputs.final };
  e.connect('transcript', 'input1', NODE_TYPES.Display.inputs.input1);
  assert.match(e.error, /Unknown port: speech.provisional → transcript.input/);
  assert.deepEqual(e.draft.edges, before);
  connect(e, 'speech', 'final', 'transcript', 'input1');
  assert.deepEqual(e.draft.edges, [...before, edge('speech', 'final', 'transcript', 'input1')]);
});


test('formatter Add/Remove changes only that instance and the removed last wire; invalid template draft remains editable', () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('TextFormatter', 'a'), graphNode('TextFormatter', 'b'));
  graph.edges.push(edge('speech', 'final', 'a', 'input1'), edge('speech', 'final', 'a', 'input4'), edge('speech', 'final', 'b', 'input4'));
  const e = editor(graph), a = graph.nodes.at(-2), b = graph.nodes.at(-1);
  for (let i = 0; i < 3; i++) e.resizeInputs(a, 1);
  assert.equal(a.settings.inputCount, 7); assert.equal(b.settings.inputCount, 4);
  assert.equal(Object.keys(nodeDefinition(a).inputs).length, 7);
  a.settings.template = '{7}\n{1}'; e.resizeInputs(a, -1);
  assert.equal(a.settings.template, '{7}\n{1}'); assert.match(validateGraph(graph).join(' '), /Input \{7\} is not configured/);
  assert.equal(graph.edges.length, 12, 'unaffected wires preserved');
  e.resizeInputs(a, 1); assert.deepEqual(validateGraph(graph), []);
  for (let i = 0; i < 4; i++) e.resizeInputs(a, -1);
  assert.equal(a.settings.inputCount, 3);
  assert.ok(graph.edges.some(route => route.to[0] === 'a' && route.to[1] === 'input1'));
  assert.ok(!graph.edges.some(route => route.to[0] === 'a' && route.to[1] === 'input4'));
  assert.ok(graph.edges.some(route => route.to[0] === 'b' && route.to[1] === 'input4'));
});

function placementEditor(rectangles) {
  const e = Object.create(GraphEditor.prototype);
  const cards = rectangles.map(({ x, y, width, height }) => ({ offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height }));
  const added = { offsetWidth: 235, offsetHeight: 150 };
  e.canvas = { querySelectorAll: () => [...cards, added] };
  return { e, added };
}
test('quick-add finds nearby space when the viewport center is occupied without moving existing cards', () => {
  const rectangles = [{ x: 380, y: 220, width: 235, height: 150 }], before = structuredClone(rectangles);
  const { e, added } = placementEditor(rectangles);
  const position = e.nodePlacement({ left: 0, top: 0, right: 1000, bottom: 600 }, added);
  const old = rectangles[0];
  assert.ok(position.x + 235 <= old.x || position.x >= old.x + old.width || position.y + 150 <= old.y || position.y >= old.y + old.height);
  assert.ok(Math.hypot(position.x - old.x, position.y - old.y) < 300, 'use nearby available space');
  assert.deepEqual(rectangles, before);
});
test('quick-add densely occupied and undersized views have deterministic finite placement within reachable bounds', () => {
  const rectangles = Array.from({ length: 144 }, (_, i) => ({ x: i % 12 * 200, y: Math.floor(i / 12) * 120, width: 235, height: 150 }));
  for (const bounds of [{ left: 700, top: 400, right: 1200, bottom: 800 }, { left: 0, top: 0, right: 180, bottom: 100 }]) {
    const { e, added } = placementEditor(rectangles);
    const position = e.nodePlacement(bounds, added);
    assert.deepEqual(e.nodePlacement(bounds, added), position);
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    assert.ok(position.x >= bounds.left && position.x <= Math.max(bounds.left, bounds.right - added.offsetWidth));
    assert.ok(position.y >= bounds.top && position.y <= Math.max(bounds.top, bounds.bottom - added.offsetHeight));
  }
});
