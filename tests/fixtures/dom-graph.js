import { readGraph, saveGraph, assertGraph } from '../../extension/graph.js';

// Test-fixture composition shorthand. Explicitly insert ordinary formatters
// before testing unrelated processor behavior; production never accepts TEXT
// display routes. Legacy migration fixtures must not call this helper.
export function addDOMFormatters(graph) {
  for (const display of graph.nodes.filter(node => node.type === 'LiveTextDisplay')) {
    const routes = graph.edges.filter(route => route.to[0] === display.id && route.to[1] === 'content');
    if (!routes.length) continue;
    const id = `${display.id}-text-dom`;
    graph.nodes.push({ id, type: 'TextToDOM', settings: {}, position: { x: 20, y: 20 } });
    for (const route of routes) route.to = [id, 'text'];
    graph.edges.push({ from: [id, 'dom'], to: [display.id, 'dom'] });
  }
  return graph;
}

export function reviewGraph(graph) {
  try { return assertGraph(graph); }
  catch (error) { if (!error.recoveryGraph) throw error; return assertGraph(error.recoveryGraph); }
}
export function reviewSavedGraph(storage) {
  try { return readGraph(storage); }
  catch (error) { if (!error.recoveryGraph) throw error; saveGraph(storage, error.recoveryGraph); return readGraph(storage); }
}
