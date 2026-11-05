import { graphNode, edge } from '../../extension/graph.js';

export function accumulateDisplay(graph, display) {
  const id = `${display}-accumulator`;
  graph.nodes.push(graphNode('TextAccumulator', id));
  for (const route of graph.edges) if (route.to[0] === display && route.to[1] === 'append') route.to = [id, 'append'];
  graph.edges.push(edge(id, 'text', display, 'input1'));
  return graph;
}
