import { graphNode, edge } from '../../extension/graph.js';
import { keyedTextGraph } from './keyed-text-graph.js';

// Reviewed legacy #196 transcript: primitives -> ViewBuilder -> VIEW -> Display.
export function viewGraph(translator = 'OpusMtEnJa') {
  const graph = keyedTextGraph(translator);
  graph.nodes = graph.nodes.filter(node => node.id !== 'display');
  graph.nodes.push(graphNode('ViewBuilder', 'view', 1300, 30), graphNode('Display', 'display', 1640, 30));
  graph.edges = graph.edges.map(route => route.to[0] === 'display' ? { ...route, to: ['view', route.to[1]] } : route);
  graph.edges.push(edge('view', 'view', 'display', 'view'));
  graph.nodes.find(node => node.id === 'display').legacyView = true;
  return graph;
}
