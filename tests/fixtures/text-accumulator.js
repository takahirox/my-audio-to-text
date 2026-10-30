import { graphNode, edge } from '../../extension/graph.js';

// Explicit committed history plus an independent replacement snapshot.
export function accumulateDisplay(graph, display) {
  const id = `${display}-accumulator`, dom = `${display}-dom`;
  const previews = graph.edges.filter(route => route.to[0] === display && route.to[1] === 'replace');
  graph.nodes.push(graphNode('TextAccumulator', id), graphNode('TextToDOM', dom));
  for (const route of graph.edges) if (route.to[0] === display && route.to[1] === 'append') route.to = [id, 'append'];
  graph.edges.push(edge(id, 'text', dom, 'text'));
  if (previews.length) {
    const preview = `${display}-preview`, combined = `${display}-combined`;
    graph.nodes.push(graphNode('TextToDOM', preview), graphNode('DOMCombiner', combined));
    for (const route of previews) route.to = [preview, 'text'];
    graph.edges.push(edge(dom, 'dom', combined, 'first'), edge(preview, 'dom', combined, 'second'), edge(combined, 'dom', display, 'dom'));
  } else graph.edges.push(edge(dom, 'dom', display, 'dom'));
  return graph;
}
