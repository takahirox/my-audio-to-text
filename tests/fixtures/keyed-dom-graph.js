import { GRAPH_VERSION, graphNode, edge } from '../../extension/graph.js';

// Concrete production graph, shared by deterministic runtime and MV3 tests.
export function keyedDOMGraph(translator = 'OpusMtEnJa') {
  const nodes = [graphNode('ChromeTabAudio', 'audio', 30, 30), graphNode('SpeechToTextReazonSpeech', 'speech', 300, 30),
    ...['preview', 'final', 'translated'].map((id, i) => graphNode('PairedTextToDOM', id, 900, 30 + i * 300)),
    graphNode('KeyedDOMAccumulator', 'history', 1230, 30), graphNode('LiveTextDisplay', 'display', 1560, 30)];
  const edges = [edge('audio', 'audio', 'speech', 'audio'),
    edge('speech', 'provisional', 'preview', 'input1'), edge('speech', 'provisionalId', 'preview', 'id'),
    edge('speech', 'final', 'final', 'input1'), edge('speech', 'finalId', 'final', 'id'),
    ...['preview', 'final', 'translated'].flatMap((id, i) => [edge(id, 'id', 'history', `id${i + 1}`), edge(id, 'dom', 'history', `dom${i + 1}`)]),
    edge('history', 'dom', 'display', 'dom')];
  if (translator) {
    nodes.push(graphNode(translator, 'translation', 600, 630));
    edges.push(edge('speech', 'final', 'translation', 'text'), edge('speech', 'finalId', 'translation', 'id'),
      edge('translation', 'source', 'translated', 'input1'), edge('translation', 'text', 'translated', 'input2'), edge('translation', 'id', 'translated', 'id'));
  } else {
    nodes.splice(nodes.findIndex(node => node.id === 'translated'), 1);
  }
  return { version: GRAPH_VERSION, nodes, edges: edges.filter(route => nodes.some(node => node.id === route.from[0])) };
}
