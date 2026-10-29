import { graphNode, edge } from '../../extension/graph.js';

// Compose a transcript fixture explicitly; non-display fan-out stays on the
// original producer. Call once after declaring this display's segment routes.
export function accumulateDisplay(graph, display) {
  const id = `${display}-accumulator`;
  graph.nodes.push(graphNode('TextAccumulator', id));
  for (const route of graph.edges) if (route.to[0] === display && ['append', 'replace'].includes(route.to[1])) {
    route.to = [id, route.to[1] === 'append' ? 'append' : 'preview'];
  }
  graph.nodes.push(graphNode('TextToDOM', `${display}-dom`));
  graph.edges.push(edge(id, 'text', `${display}-dom`, 'text'), edge(`${display}-dom`, 'dom', display, 'dom'));
  return graph;
}
