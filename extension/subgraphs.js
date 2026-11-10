import { assertGraph, executableGraph, nodeDefinition, INPUT_TYPES, edge } from './graph.js';

const key = endpoint => JSON.stringify(endpoint);
const portID = value => typeof value === 'string' && /^[a-zA-Z][\w-]{0,63}$/.test(value);
export const references = (library, id) => library.graphs.filter(entry => Array.isArray(entry.graph?.nodes)
  && entry.graph.nodes.some(node => node?.type === 'Subgraph' && node.subgraphId === id));

// This first version deliberately rejects nesting (including all reference cycles).
// Concrete capture and output nodes remain in each parent canvas.
export function assertSubgraph(graph) {
  if (Array.isArray(graph?.nodes) && graph.nodes.some(node => node?.type === 'Subgraph')) throw Error('Nested or circular subgraphs are not supported. Keep shared processing one level deep.');
  graph = assertGraph(graph);
  if (!graph.interface || !['inputs', 'outputs'].every(side => Array.isArray(graph.interface[side]))) throw Error('A reusable subgraph needs exposed input and output port lists.');
  if (graph.nodes.some(node => INPUT_TYPES.includes(node.type) || !Object.keys(nodeDefinition(node, graph).outputs).length)) throw Error('Keep concrete audio inputs and output destinations in the parent graph. Extract processing nodes only.');
  for (const side of ['inputs', 'outputs']) {
    const ids = new Set(), targets = new Set();
    for (const port of graph.interface[side]) {
      const contract = nodeDefinition(graph.nodes.find(node => node.id === port?.node), graph)?.[side]?.[port?.port];
      if (!portID(port?.id) || ids.has(port.id) || typeof port.name !== 'string' || !port.name.trim() || port.name.length > 120 || !contract || targets.has(key([port.node, port.port]))) throw Error(`Invalid or duplicate exposed ${side} port. Keep a unique ID, meaningful name and existing internal endpoint.`);
      if (side === 'inputs' && graph.edges.some(route => key(route.to) === key([port.node, port.port]))) throw Error(`Exposed input ${port.name} already has an internal connection. Disconnect it or remove the exposed port.`);
      ids.add(port.id); targets.add(key([port.node, port.port]));
    }
  }
  return graph;
}

export function portContract(graph, side, port) {
  return nodeDefinition(graph.nodes.find(node => node.id === port.node), graph)[side][port.port];
}

// Expand into ordinary nodes once, before model selection or runtime creation.
// Edges go directly to the real endpoints, preserving atomic output families,
// sampled Hold semantics and the existing runtime's ownership/cleanup rules.
export function resolveSubgraphs(graph, definitions = []) {
  return expandSubgraphs(graph, definitions).graph;
}

// Compare parent wires by their original identities, even when expansion assigns
// different internal node IDs after an edit. Partial branch loss matters too.
export function executableBoundaryEdges(graph, definitions = []) {
  graph = assertGraph(graph, definitions);
  const expanded = expandSubgraphs(graph, definitions);
  const active = new Set(executableGraph(expanded.graph).edges.map(key));
  return new Set(graph.edges.filter(route => active.has(key(expanded.translate(route)))).map(key));
}

function expandSubgraphs(graph, definitions) {
  graph = assertGraph(graph, definitions);
  const nodes = [], edges = [], endpoints = new Map(), used = new Set(graph.nodes.map(node => node.id));
  let sequence = 0;
  for (const node of graph.nodes) {
    if (node.type !== 'Subgraph') { nodes.push(node); continue; }
    const entry = definitions.find(entry => entry.id === node.subgraphId && entry.kind === 'subgraph');
    if (!entry) throw Error(`Missing subgraph ${node.subgraphId}. Import its dependency bundle or remove the instance.`);
    const shared = assertSubgraph(entry.graph), ids = new Map();
    for (const child of shared.nodes) {
      let id; do { id = `shared-${++sequence}`; } while (used.has(id));
      used.add(id); ids.set(child.id, id); nodes.push({ ...child, id });
    }
    const translate = endpoint => [ids.get(endpoint[0]), endpoint[1]];
    edges.push(...shared.edges.map(route => ({ from: translate(route.from), to: translate(route.to) })));
    for (const side of ['inputs', 'outputs']) for (const port of shared.interface[side]) endpoints.set(key([node.id, side, port.id]), translate([port.node, port.port]));
  }
  const translate = route => ({ from: endpoints.get(key([route.from[0], 'outputs', route.from[1]])) || route.from,
    to: endpoints.get(key([route.to[0], 'inputs', route.to[1]])) || route.to });
  for (const route of graph.edges) edges.push(translate(route));
  const resolved = { ...graph, nodes, edges }; delete resolved.interface;
  return { graph: assertGraph(resolved), translate };
}

export function extractSubgraph(graph, selection, subgraphId, definitions = []) {
  graph = assertGraph(graph, definitions);
  const selected = new Set(selection), nodes = graph.nodes.filter(node => selected.has(node.id));
  if (!nodes.length || nodes.length !== selected.size) throw Error('Select processing nodes to create a subgraph.');
  const internal = graph.edges.filter(route => selected.has(route.from[0]) && selected.has(route.to[0]));
  const reached = new Set([nodes[0].id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const route of internal) if (reached.has(route.from[0]) !== reached.has(route.to[0])) { reached.add(route.from[0]); reached.add(route.to[0]); changed = true; }
  }
  if (reached.size !== nodes.length) throw Error('Select one connected group of processing nodes.');
  const ports = { inputs: [], outputs: [] }, mapped = new Map();
  for (const route of graph.edges) {
    const source = selected.has(route.from[0]), target = selected.has(route.to[0]);
    if (source === target) continue;
    const side = target ? 'inputs' : 'outputs', endpoint = target ? route.to : route.from, identity = key([side, endpoint]);
    if (!mapped.has(identity)) {
      const id = `${target ? 'in' : 'out'}${ports[side].length + 1}`; mapped.set(identity, id);
      ports[side].push({ id, name: `${endpoint[0]} ${endpoint[1]}`, node: endpoint[0], port: endpoint[1] });
    }
  }
  const shared = assertSubgraph({ version: graph.version, nodes, edges: internal, interface: ports });
  let id = 'subgraph', suffix = 1; while (graph.nodes.some(node => node.id === id)) id = `subgraph-${suffix++}`;
  const instance = { id, type: 'Subgraph', subgraphId, settings: {}, position: { ...nodes[0].position } };
  const parent = { ...graph, nodes: [...graph.nodes.filter(node => !selected.has(node.id)), instance], edges: [] };
  for (const route of graph.edges) {
    const source = selected.has(route.from[0]), target = selected.has(route.to[0]);
    if (source && target) continue;
    parent.edges.push(edge(...(source ? [id, mapped.get(key(['outputs', route.from]))] : route.from), ...(target ? [id, mapped.get(key(['inputs', route.to]))] : route.to)));
  }
  return { shared, parent, instance };
}
