import { defaultGraph } from '../../extension/graph.js';

// Persisted ports, independent of the current schema.
export function legacyGraph(options = {}, version = 3) {
  const graph = defaultGraph(options); graph.version = version;
  graph.edges = graph.edges.filter(route => route.to[0] !== 'translated');
  if (graph.nodes.some(node => node.id === 'translation')) {
    for (const port of ['provisional', 'final']) graph.edges.push({
      from: ['translation', version === 4 ? (port === 'final' ? 'finalResult' : 'provisionalResult') : port], to: ['translated', port],
    });
  }
  if (version < 4) for (const route of graph.edges) {
    if (route.to[0] === 'translation' && route.to[1] === 'text') route.to[1] = 'final';
  }
  return graph;
}
export const legacyAdapter = (translated, id = 'text') => ({ id, type: translated ? 'TranslatedFinalText' : 'FinalText', settings: {}, position: { x: 20, y: 20 } });
