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

// Ordinary Number and Text sources feed independent ID-bearing consumers.
export function independentIDGraph(translator = 'OpusMtEnJa') {
  const nodes = [graphNode('Text', 'text'), graphNode('Number', 'number'), graphNode(translator, 'translation'),
    graphNode('PairedTextToDOM', 'pair'), graphNode('TextToDOM', 'plain'), graphNode('KeyedDOMAccumulator', 'history'), graphNode('LiveTextDisplay', 'display')];
  nodes[0].settings.value = 'independent'; nodes[1].settings.value = -1.5;
  return { version: GRAPH_VERSION, nodes, edges: [
    edge('text', 'value', 'translation', 'text'), edge('number', 'value', 'translation', 'id'),
    edge('number', 'value', 'pair', 'id'),
    edge('text', 'value', 'plain', 'text'),
    ...[1, 2, 3].flatMap(slot => [edge('number', 'value', 'history', `id${slot}`), edge(slot === 3 ? 'pair' : 'plain', 'dom', 'history', `dom${slot}`)]),
    edge('history', 'dom', 'display', 'dom'),
    edge('translation', 'source', 'pair', 'input1'), edge('translation', 'text', 'pair', 'input2'),
  ] };
}
