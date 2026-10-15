import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, graphWarnings, executableGraph, saveGraph, readGraph } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';

const store = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('large v8 drafts retain every Node, route, setting and position beyond old size limits', () => {
  const graph = defaultGraph();
  for (let index = 0; index < 100; index++) {
    graph.nodes.push(graphNode('LiveTextDisplay', `display-${index}`, 4500 + index * 300, 5000));
    graph.edges.push(edge('speech', 'final', `display-${index}`, 'append'));
  }
  const storage = store(); saveGraph(storage, graph);
  assert.deepEqual(readGraph(storage), graph); assert.deepEqual(executableGraph(graph), graph);
});

test('saveable incomplete paths do not contaminate a complete sibling, including incomplete correlated formatters', async () => {
  const graph = defaultGraph({ enabled: true });
  graph.edges = graph.edges.filter(route => !(route.to[0] === 'translated-format' && route.to[1] === 'finalIndex'));
  graph.nodes.push(graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextWhisper', 'whisper'));
  graph.edges.push(edge('mic','audio','whisper','audio'));
  const storage = store(); saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
  assert.deepEqual(validateGraph(graph), []);
  assert.match(graphWarnings(graph).join(' '), /finalIndex for correlated display/);
  const active = executableGraph(graph);
  assert.deepEqual(active.nodes.map(node => node.id), ['audio', 'speech', 'transcript']);
  const built = buildGraph(graph, {});
  assert.deepEqual([...built.speechNodes.keys()], ['speech']);
  assert.deepEqual([...built.audioSources.keys()], ['audio']); await built.pipeline.dispose();
  graph.edges.find(route => route.to[1] === 'finalError').from = ['speech', 'final'];
  assert.match(validateGraph(graph).join(' '), /matching direct outputs/);
});

test('constant text roots execute without audio or ASR, while drafts with no sink stay saveable', async () => {
  const graph = { version: 8, nodes: [graphNode('Text','text'), graphNode('LiveTextDisplay','display')], edges: [edge('text','value','display','append')] };
  graph.nodes[0].settings.value = 'independent text';
  const states = [], built = buildGraph(graph, { onDisplay: (id, state) => states.push(state) });
  assert.equal(built.speechNodes.size, 0); assert.equal(built.audioSources.size, 0);
  await built.pipeline.start(); await built.pipeline.stop(); await built.pipeline.dispose();
  assert.deepEqual(states.at(-1).items, ['independent text']);
  graph.nodes.pop(); graph.edges = [];
  const storage = store(); saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
  assert.deepEqual(executableGraph(graph).nodes, []);
  assert.throws(() => buildGraph(graph, {}), /No executable path/);
});

test('consumer-specific startup values in unfinished branches warn until the consumer participates', () => {
  for (const [constant, consumer, input, value] of [['Number','SpeechToTextReazonSpeech','maxDuration',0],['Text','SpeechToTextWhisper','language','fr']]) {
    const graph = defaultGraph();
    graph.nodes.push(graphNode(constant,'configuration'),graphNode(consumer,'unfinished'),graphNode('LiveTextDisplay','unfinished-display'));
    graph.nodes.at(-3).settings.value = value;
    graph.edges.push(edge('configuration','value','unfinished',input),edge('unfinished','final','unfinished-display','append'));
    const storage = store(); saveGraph(storage,graph); assert.deepEqual(readGraph(storage),graph);
    assert.match(graphWarnings(graph).join(' '), /unfinished:.*inactive configuration/);
    assert.deepEqual(executableGraph(graph).nodes.map(node=>node.id),['audio','speech','transcript']);
    graph.edges.push(edge('audio','audio','unfinished','audio'));
    assert.throws(()=>saveGraph(storage,graph), /unfinished:/);
  }
});
