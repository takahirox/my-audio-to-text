import { defaultGraph } from '../../extension/graph.js';

// The persisted v1–3 ports, independent of the current schema.
export function legacyGraph(options = {}, version = 3) {
  const graph = defaultGraph(options); graph.version = version;
  for (const route of graph.edges) {
    if (route.to[0] === 'translation' && route.to[1] === 'text') route.to[1] = 'final';
    if (route.from[0] === 'translation') route.from[1] = route.from[1] === 'finalResult' ? 'final' : 'provisional';
  }
  return graph;
}
export const legacyAdapter = (translated, id = 'text') => ({ id, type: translated ? 'TranslatedFinalText' : 'FinalText', settings: {}, position: { x: 20, y: 20 } });
