import { assertGraph, edge, executableGraph, graphNode, GRAPH_VERSION, NODE_TYPES } from '../extension/graph.js';
import { assertSubgraph, resolveSubgraphs } from '../extension/subgraphs.js';
import { buttonLabel } from '../web/button-node.js';

export const MICROPHONE = 'MicrophoneAudio';
export const JAPANESE_ASR = 'SpeechToTextMoonshineSmallJa';
export const FOCUSED_OUTPUT = 'FocusedInputTextOutputNode';

const modelHelp = [
  ['Auto Save prepares 305 MB of weights', 'Prepare 305 MB of weights in Models'],
  ['Auto Save prepares 122 MB of weights', 'Prepare 122 MB of weights in Models'],
  ['Auto Save prepares model files; Live initializes an owned CPU WASM Worker before enabling Start.', 'Prepare model files in Models. Live initializes an owned CPU WASM Worker before processing.'],
  ['Auto Save prepares 1.81 GB of verified GGUF data', 'Prepare 1.81 GB of verified GGUF data in Models'],
  ['Auto Save prepares the same shared 3.112 GB cache', 'Prepare the shared 3.112 GB cache in Models'],
  ['Auto Save prepares pinned weights; Live downloads missing files before enabling Start.', 'Prepare pinned weights in Models. Live verifies required files before processing.'],
];
const sharedTypes = Object.fromEntries(Object.entries(NODE_TYPES)
  .filter(([type]) => type !== 'ChromeTabAudio')
  .map(([type, definition]) => {
    const help = modelHelp.reduce((text, [from, to]) => text?.replace(from, to), definition.help);
    return [type, help === definition.help ? definition : { ...definition, help }];
  }));

export const desktopNodeTypes = Object.freeze({
  ...sharedTypes,
  [MICROPHONE]: { ...sharedTypes[MICROPHONE], help: 'Captures the default system microphone after an intentional Start.' },
  [FOCUSED_OUTPUT]: { ...sharedTypes[FOCUSED_OUTPUT], label: 'Focused application text output',
    help: 'Insert each nonempty TEXT delivery into the field focused at delivery. The default graph connects ASR final. Use the global shortcut or tray to start.' },
});

export function defaultDesktopGraph() {
  return { version: GRAPH_VERSION, nodes: [
    graphNode(MICROPHONE, 'microphone', 32, 110),
    graphNode(JAPANESE_ASR, 'speech', 285, 64),
    graphNode(FOCUSED_OUTPUT, 'focused-output', 650, 110),
    graphNode('FloatingDisplay', 'floating-display', 650, 260),
  ], edges: [
    edge('microphone', 'audio', 'speech', 'audio'),
    edge('speech', 'final', 'focused-output', 'text'),
    edge('speech', 'provisional', 'floating-display', 'text'),
  ] };
}

export function assertDesktopNodes(graph) {
  const tab = graph.nodes.find(node => node.type === 'ChromeTabAudio');
  if (tab) throw Error(`Chrome tab audio (ChromeTabAudio, ${tab.id}) requires the Chrome extension. Remove or replace that Node in a copy of this graph.`);
  return graph;
}

export function assertDesktopGraph(value, definitions = [], kind = 'graph') {
  if (value?.format === 'graph-bundle') throw Error('Import graph dependency bundles in Graph Library.');
  const graph = kind === 'subgraph' ? assertSubgraph(value) : assertGraph(value, definitions);
  assertDesktopNodes(resolveSubgraphs(graph, definitions));
  return graph;
}

export function planGraph(value, mode, definitions = []) {
  const graph = executableGraph(resolveSubgraphs(assertDesktopGraph(value, definitions), definitions));
  const byType = type => graph.nodes.filter(node => node.type === type);
  const focused = byType(FOCUSED_OUTPUT).length > 0;
  const microphone = byType(MICROPHONE).length > 0;
  if (mode === 'dictation' && !focused) throw Error('Choose a saved graph with a connected focused application output in Graph Library.');
  if (mode === 'live' && focused) throw Error('Start this graph from the global shortcut or tray.');
  if (!graph.nodes.length) throw Error('No executable path. Connect a source through complete processors to an output destination.');
  const displays = byType('Display').map(({ id, settings }) => ({ id, settings }));
  const actions = byType('Button').map(({ id, settings }) => ({ id, label: buttonLabel(settings.label) }));
  return { graph, microphone, focused, displays, actions };
}
