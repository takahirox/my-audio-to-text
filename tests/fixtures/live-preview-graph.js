import { defaultGraph } from '../../extension/graph.js';

export function livePreviewGraph(audioType = 'ChromeTabAudio') {
  const graph = defaultGraph({ enabled: true, direction: 'en-ja' });
  graph.nodes[0].type = audioType;
  graph.nodes[1].type = 'SpeechToTextZipformerEn';
  graph.nodes.find(node => node.id === 'transcript').id = 'live';
  for (const route of graph.edges) if (route.to[0] === 'transcript') route.to[0] = 'live';
  return graph;
}
