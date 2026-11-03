import { graphNode, edge } from '../../extension/graph.js';
import { keyedTextGraph } from './keyed-text-graph.js';

export function itemGraph(translator = 'OpusMtEnJa') {
  const graph = keyedTextGraph(translator);
  graph.nodes = graph.nodes.filter(node => node.id !== 'display');
  graph.nodes.push(graphNode('KeyedPairedTextAccumulator', 'history', 1300, 30), graphNode('Display', 'display', 1640, 30));
  graph.edges = graph.edges.filter(route => route.to[0] !== 'display');
  graph.edges.push(edge('pair', 'pair', 'history', 'pair'), edge('history', 'pairs', 'display', 'input'));
  return graph;
}
