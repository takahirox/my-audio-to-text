import { defaultGraph, graphNode, edge } from '../../extension/graph.js';

export function translationGraph({ direction = 'ja-en', enabled = true } = {}) {
  const graph = defaultGraph();
  graph.nodes.find(node => node.id === 'speech').type = direction === 'en-ja'
    ? 'SpeechToTextMoonshineMediumEn' : 'SpeechToTextMoonshineSmallJa';
  if (enabled) {
    graph.nodes.push(graphNode(direction === 'en-ja' ? 'TranslateGemmaEnJa' : 'TranslateGemmaJaEn', 'translation', 620, 430));
    graph.edges.push(edge('speech', 'finalId', 'translation', 'id'), edge('speech', 'final', 'translation', 'text'),
      edge('translation', 'id', 'pair', 'id2'), edge('translation', 'text', 'pair', 'input2'));
  }
  return graph;
}
