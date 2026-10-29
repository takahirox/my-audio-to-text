import { defaultGraph, graphNode, edge, pairedTextEdges } from '../../extension/graph.js';

export function livePreviewGraph(audioType = 'ChromeTabAudio') {
  const preview = graphNode('TextToDOM', 'preview');
  preview.settings.className = 'paired-text-tail';
  return { version: defaultGraph().version, nodes: [
    graphNode(audioType, 'audio'), graphNode('SpeechToTextZipformerEn', 'speech'),
    graphNode('OpusMtEnJa', 'translation'), graphNode('PairedTextToDOM', 'pairs'),
    graphNode('DOMAccumulator', 'history'), preview,
    graphNode('DOMCombiner', 'combined'), graphNode('LiveTextDisplay', 'live'),
  ], edges: [
    edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'final', 'translation', 'text'),
    ...pairedTextEdges('translation', 'pairs'),
    edge('pairs', 'dom', 'history', 'append'), edge('history', 'dom', 'combined', 'first'),
    edge('speech', 'provisional', 'preview', 'text'), edge('preview', 'dom', 'combined', 'second'),
    edge('combined', 'dom', 'live', 'dom'),
  ] };
}
