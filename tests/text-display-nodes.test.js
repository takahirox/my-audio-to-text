import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT } from '../web/port-contracts.js';
import { LiveTextDisplayNode, TextFormatterNode, parseTemplate } from '../web/text-nodes.js';
import { defaultGraph, graphNode, edge, validateGraph, assertGraph } from '../extension/graph.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const context = () => ({ signal: new AbortController().signal });

test('replace, empty clearing, every append, grouped precedence and literal text are deterministic', () => {
  const states = [], node = new LiveTextDisplayNode(state => states.push(state)), c = context(); node.start();
  node.receive('replace', '<b>preview</b>', c); assert.equal(states.at(-1).preview, '<b>preview</b>');
  node.receive('replace', '', c); assert.equal(states.at(-1).preview, '');
  node.receive('replace', 'pending', c); node.receive('append', 'committed', c);
  node.receive('append', 'committed', c); node.receive('append', '', c);
  node.receiveInputs({ append: 'grouped', replace: 'stale' }, c);
  assert.deepEqual(states.at(-1), { preview: '', items: ['committed', 'committed', '', 'grouped'] });
  assert.deepEqual(states[0], { preview: '', items: [] }, 'published snapshots do not change');
  assert.throws(() => node.receive('append', {}, c), /TEXT/);
  c.signal = AbortSignal.abort(); node.receive('append', 'late', c); assert.equal(states.at(-1).items.length, 4);
});

test('independent display instances and TEXT fan-out drain without duplicating a preview', async () => {
  let emit; const a = new LiveTextDisplayNode(), b = new LiveTextDisplayNode();
  const pipeline = new Pipeline({ nodes: { source: { outputs: { text: TEXT }, start(c) { emit = c.emit; } }, a, b }, connections: [edge('source', 'text', 'a', 'replace'), edge('source', 'text', 'b', 'append')] });
  await pipeline.start(); emit('text', 'same'); emit('text', 'same'); await pipeline.stop();
  assert.equal(a.preview, 'same'); assert.deepEqual(a.items, []); assert.equal(b.preview, ''); assert.deepEqual(b.items, ['same', 'same']);
  await pipeline.dispose();
});

test('formatter has bounded substitutions, literal labels/newlines, escaping and missing values', () => {
  const output = [], node = new TextFormatterNode({ template: 'Source: {1}\n{{{2}}}\nMissing:{4}' }), c = { ...context(), emit: (port, text) => output.push(text) };
  node.receiveInputs({ input1: '<img src=x onerror=alert(1)>', input2: '{1}' }, c);
  assert.deepEqual(output, ['Source: <img src=x onerror=alert(1)>\n{{1}}\nMissing:']);
  node.receive('input1', '', c); assert.equal(output.at(-1), 'Source: \n{{1}}\nMissing:');
  for (const template of ['{0}', '{5}', '{input1}', '{1.x}', '{1', '}', 'a'.repeat(2049)]) assert.throws(() => parseTemplate(template));
  assert.throws(() => node.receive('input2', null, c), /TEXT/);
});

test('direct grouped formatter update emits once; separate branches emit latest values without waiting or matching', async () => {
  let a, b; const result = [], formatter = new TextFormatterNode({ template: '{1}|{2}|{3}' });
  const pipeline = new Pipeline({ nodes: {
    a: { outputs: { one: TEXT, two: TEXT }, start(c) { a = c.emitOutputs; } },
    b: { outputs: { text: TEXT }, start(c) { b = c.emit; } }, formatter,
    sink: new LiveTextDisplayNode(state => { if (state.items.length) result.splice(0, result.length, ...state.items); }),
  }, connections: [edge('a', 'one', 'formatter', 'input1'), edge('a', 'two', 'formatter', 'input3'), edge('b', 'text', 'formatter', 'input2'), edge('formatter', 'text', 'sink', 'append')] });
  await pipeline.start(); a({ one: 'A', two: 'grouped' }); await tick(); assert.deepEqual(result, ['A||grouped']);
  b('text', 'B'); await tick(); assert.deepEqual(result, ['A||grouped', 'A|B|grouped']);
  a({ one: 'C' }); await pipeline.stop(); assert.deepEqual(result, ['A||grouped', 'A|B|grouped', 'C|B|grouped']); await pipeline.dispose();
});

test('validation accepts multiple generic sinks and translators, output-only paths and primitive formatters', () => {
  const graph = defaultGraph(); graph.nodes.push(graphNode('LiveTextDisplay', 'other'), graphNode('TextFormatter', 'format'), graphNode('OpusMtEnJa', 'second'));
  graph.edges.push(edge('speech', 'final', 'format', 'input1'), edge('format', 'text', 'other', 'append'), edge('speech', 'final', 'second', 'text'), edge('second', 'text', 'other', 'replace'));
  assert.deepEqual(validateGraph(graph), []);
  for (const [id, key, value] of [['other', 'label', ''], ['other', 'label', 'a'.repeat(121)], ['format', 'template', '{5}']]) {
    const invalid = structuredClone(graph); invalid.nodes.find(n => n.id === id).settings[key] = value; assert.throws(() => assertGraph(invalid));
  }
  const disconnected = structuredClone(graph); disconnected.edges = disconnected.edges.filter(e => e.to[0] !== 'other'); assert.match(validateGraph(disconnected).join(' '), /at least one TEXT/);
  const only = defaultGraph({ enabled: false }); only.nodes = only.nodes.filter(n => n.id !== 'transcript'); only.edges = only.edges.filter(e => e.to[0] !== 'transcript');
  only.nodes.push(graphNode('FocusedInputTextOutputNode', 'field')); only.edges.push(edge('speech', 'final', 'field', 'text')); assert.deepEqual(validateGraph(only), []);
});

test('mixed display owns Stop/Cancel preview cleanup; replace-only values and committed items remain', () => {
  const mixed = new LiveTextDisplayNode(() => {}, { appendConnected: true }), value = new LiveTextDisplayNode(), c = context();
  mixed.receive('append', 'history', c); mixed.receive('replace', 'pending', c); mixed.stop(); assert.equal(mixed.preview, ''); assert.deepEqual(mixed.items, ['history']);
  mixed.receive('replace', 'canceled', c); mixed.dispose(); assert.equal(mixed.preview, '');
  value.receive('replace', 'current value', c); value.stop(); value.dispose(); assert.equal(value.preview, 'current value');
});
