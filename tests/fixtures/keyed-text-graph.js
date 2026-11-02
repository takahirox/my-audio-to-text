import { GRAPH_VERSION, graphNode, edge } from '../../extension/graph.js';

// Recommended transcript graph: every edge after ASR is NUMBER or TEXT.
export function keyedTextGraph(translator = 'OpusMtEnJa') {
  const nodes = [graphNode('ChromeTabAudio', 'audio', 20, 30),
    graphNode('SpeechToTextReazonSpeech', 'speech', 300, 30),
    graphNode('KeyedTextCoalesce', 'coalesce', 620, 30),
    graphNode('KeyedTextPair', 'pair', 960, 30), graphNode('TextDisplay', 'display', 1300, 30)];
  const edges = [edge('audio', 'audio', 'speech', 'audio'),
    edge('speech', 'finalId', 'coalesce', 'id1'), edge('speech', 'final', 'coalesce', 'input1'),
    edge('speech', 'provisionalId', 'coalesce', 'id2'), edge('speech', 'provisional', 'coalesce', 'input2'),
    edge('coalesce', 'id', 'pair', 'id1'), edge('coalesce', 'text', 'pair', 'input1'),
    ...['id', 'input1', 'input2'].map(port => edge('pair', port, 'display', port))];
  if (translator) {
    nodes.push(graphNode(translator, 'translation', 620, 430));
    edges.push(edge('speech', 'finalId', 'translation', 'id'), edge('speech', 'final', 'translation', 'text'),
      edge('translation', 'id', 'pair', 'id2'), edge('translation', 'text', 'pair', 'input2'));
  }
  return { version: GRAPH_VERSION, nodes, edges };
}
