import { translationGraph } from './translation-graph.js';

export function itemGraph(translator = 'TranslateGemmaEnJa') {
  const graph = translationGraph({ enabled: !!translator, direction: 'en-ja' });
  const display = graph.nodes.find(node => node.id === 'transcript'); display.id = 'display';
  for (const route of graph.edges) if (route.to[0] === 'transcript') route.to[0] = 'display';
  if (translator) graph.nodes.find(node => node.id === 'translation').type = translator;
  return graph;
}
