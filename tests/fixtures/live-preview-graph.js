import { translationGraph } from './translation-graph.js';

export function livePreviewGraph(audioType = 'ChromeTabAudio') {
  const graph = translationGraph({ enabled: true, direction: 'en-ja' });
  graph.nodes[0].type = audioType;
  graph.nodes[1].type = 'SpeechToTextMoonshineMediumEn';
  graph.nodes.find(node => node.id === 'transcript').id = 'live';
  for (const route of graph.edges) if (route.to[0] === 'transcript') route.to[0] = 'live';
  return graph;
}
