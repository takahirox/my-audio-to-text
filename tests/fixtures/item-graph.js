import { defaultGraph } from '../../extension/graph.js';

export function itemGraph(translator = 'OpusMtEnJa') {
  const graph = defaultGraph({ enabled: !!translator, direction: 'en-ja' });
  delete graph.translationDirection;
  const display = graph.nodes.find(node => node.id === 'transcript'); display.id = 'display';
  for (const route of graph.edges) if (route.to[0] === 'transcript') route.to[0] = 'display';
  if (translator) graph.nodes.find(node => node.id === 'translation').type = translator;
  return graph;
}
