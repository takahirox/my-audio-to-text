import { assertGraph, edge, executableGraph, graphNode, GRAPH_VERSION, NODE_TYPES } from '../extension/graph.js';

export const MICROPHONE = 'MicrophoneAudio';
export const JAPANESE_ASR = 'SpeechToTextMoonshineSmallJa';
export const FOCUSED_OUTPUT = 'FocusedInputTextOutputNode';

export const desktopNodeTypes = Object.freeze({
  [MICROPHONE]: { ...NODE_TYPES[MICROPHONE], help: 'Captures the default system microphone after an intentional Start.' },
  [JAPANESE_ASR]: { ...NODE_TYPES[JAPANESE_ASR], help: 'Prepare the Japanese model in Models. Connect final for committed text or provisional for streaming hypotheses.' },
  TextFormatter: NODE_TYPES.TextFormatter,
  Text: NODE_TYPES.Text,
  Display: NODE_TYPES.Display,
  [FOCUSED_OUTPUT]: { ...NODE_TYPES[FOCUSED_OUTPUT], label: 'Focused application text output',
    help: 'Insert each nonempty TEXT delivery into the field focused at delivery. The default graph connects ASR final. Use the global shortcut or tray to start.' },
});

export function defaultDesktopGraph() {
  return { version: GRAPH_VERSION, nodes: [
    graphNode(MICROPHONE, 'microphone', 32, 110),
    graphNode(JAPANESE_ASR, 'speech', 285, 64),
    graphNode(FOCUSED_OUTPUT, 'focused-output', 650, 110),
  ], edges: [edge('microphone', 'audio', 'speech', 'audio'), edge('speech', 'final', 'focused-output', 'text')] };
}

export function assertDesktopGraph(value) {
  if (value?.format === 'graph-bundle') throw Error('Desktop accepts individual graph JSON. Subgraph bundles are unsupported.');
  const graph = assertGraph(value);
  for (const node of graph.nodes) {
    if (!Object.hasOwn(desktopNodeTypes, node.type)) throw Error(`Unsupported desktop Node: ${node.type} (${node.id}).`);
  }
  return graph;
}

export function planGraph(value, mode) {
  const graph = executableGraph(assertDesktopGraph(value));
  const count = type => graph.nodes.filter(node => node.type === type).length;
  const focused = count(FOCUSED_OUTPUT);
  if (focused > 1 || count(MICROPHONE) > 1) throw Error('Connect at most one microphone and one focused application output.');
  if (mode === 'dictation' && !focused) throw Error('Choose a saved graph with a connected focused application output in Graph Library.');
  if (mode === 'live' && focused) throw Error('Start this graph from the global shortcut or tray.');
  if (mode === 'live' && !count('Display')) throw Error('Connect a source to Display to run this graph in Live.');
  const displays = graph.nodes.filter(node => node.type === 'Display').map(({ id, settings }) => ({ id, settings }));
  return { graph, microphone: count(MICROPHONE) === 1, focused: focused === 1, displays };
}
