import { domText } from './fixtures/dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultGraph, graphNode, edge, validateGraph, graphWarnings, executableGraph, saveGraph, readGraph, GRAPH_VERSION } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';

const store = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('large current drafts retain every Node, route, setting and position beyond old size limits', () => {
  const graph = defaultGraph();
  for (let index = 0; index < 100; index++) {
    graph.nodes.push(graphNode('Display', `display-${index}`, 4500 + index * 300, 5000));
    graph.edges.push(edge('speech', 'final', `display-${index}`, 'input1'));
  }
  const storage = store(); saveGraph(storage, (graph));
  assert.deepEqual(readGraph(storage), graph); assert.deepEqual(executableGraph((graph)), graph);
});

test('saveable incomplete paths do not contaminate a complete sibling, while either available paired input activates its display', async () => {
  const graph = defaultGraph({ enabled: true });
  graph.edges = graph.edges.filter(route => route.to[0] !== 'translation');
  graph.nodes.push(graphNode('MicrophoneAudio', 'mic'), graphNode('SpeechToTextWhisper', 'whisper'));
  graph.edges.push(edge('mic','audio','whisper','audio'));
  const storage = store(); saveGraph(storage, (graph)); assert.deepEqual(readGraph(storage), graph);
  assert.deepEqual(validateGraph((graph)), []);
  assert.match(graphWarnings(graph).join(' '), /translation.text/);
  const active = executableGraph((graph));
  assert.deepEqual(active.nodes.map(node => node.id), ['audio', 'speech', 'coalesce', 'pair', 'history', 'transcript']);
  const built = buildGraph((graph), {});
  assert.deepEqual([...built.speechNodes.keys()], ['speech']);
  assert.deepEqual([...built.audioSources.keys()], ['audio']); await built.pipeline.dispose();
  assert.equal(active.nodes.some(node => node.id === 'translation'), false);
  assert.ok(active.edges.some(route => route.from[0] === 'coalesce' && route.to[0] === 'pair'));

});

test('constant text roots execute without audio or ASR, while drafts with no sink stay saveable', async () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text','text'), graphNode('Display','display')], edges: [edge('text','value','display','input1')] };
  graph.nodes[0].settings.value = 'independent text';
  const states = [], built = buildGraph((graph), { onDisplay: (id, state) => states.push(domText(state)) });
  assert.equal(built.speechNodes.size, 0); assert.equal(built.audioSources.size, 0);
  await built.pipeline.start(); await built.pipeline.stop(); await built.pipeline.dispose();
  assert.deepEqual(states.at(-1), 'independent text');
  graph.nodes.pop(); graph.edges = [];
  const storage = store(); saveGraph(storage, (graph)); assert.deepEqual(readGraph(storage), graph);
  assert.deepEqual(executableGraph((graph)).nodes, []);
  assert.throws(() => buildGraph((graph), {}), /No executable path/);
});

test('consumer-specific startup values stay saveable and are validated by the executing Node', () => {
  for (const [constant, consumer, input, value] of [['Number','SpeechToTextReazonSpeech','maxDuration',0],['Text','SpeechToTextWhisper','language','fr']]) {
    const graph = defaultGraph();
    graph.nodes.push(graphNode(constant,'configuration'),graphNode(consumer,'unfinished'),graphNode('Display','unfinished-display'));
    graph.nodes.at(-3).settings.value = value;
    graph.edges.push(edge('configuration','value','unfinished',input),edge('unfinished','final','unfinished-display','input1'));
    const storage = store(); saveGraph(storage, (graph)); assert.deepEqual(readGraph(storage),graph);
    assert.match(graphWarnings(graph).join(' '), /Inactive Node: unfinished/);
    assert.deepEqual(executableGraph((graph)).nodes.map(node=>node.id),['audio', 'speech', 'coalesce', 'pair', 'history', 'transcript']);
    graph.edges.push(edge('audio','audio','unfinished','audio'));
    saveGraph(storage, (graph)); assert.deepEqual(readGraph(storage),graph);
  }
});
