import { defaultGraph, graphNode, edge } from '../../extension/graph.js';

export function translationGraph({ direction = 'ja-en', enabled = true } = {}) {
  const graph = defaultGraph();
  graph.nodes.find(node => node.id === 'speech').type = direction === 'en-ja'
    ? 'SpeechToTextMoonshineMediumEn' : 'SpeechToTextMoonshineSmallJa';
  if (enabled) {
    graph.nodes.push(graphNode('TranslateGemma4B', 'translation', 620, 430));
    if (direction === 'en-ja') for (const [index, [port, value]] of [['source_lang', 'en'], ['target_lang', 'ja']].entries()) {
      const node = graphNode('Text', `translation-${port}`, 300, 800 + index * 250); node.settings.value = value;
      graph.nodes.push(node); graph.edges.push(edge(node.id, 'value', 'translation', port));
    }
    graph.edges.push(edge('speech', 'finalId', 'translation', 'id'), edge('speech', 'final', 'translation', 'text'),
      edge('translation', 'id', 'pair', 'id2'), edge('translation', 'text', 'pair', 'input2'));
  }
  return graph;
}
