import { defaultGraph, graphNode, edge } from '../../extension/graph.js';

export function livePreviewGraph(audioType = 'ChromeTabAudio') {
  return { version: defaultGraph().version, nodes: [
    graphNode(audioType, 'audio'), graphNode('SpeechToTextZipformerEn', 'speech'),
    graphNode('OpusMtEnJa', 'translation'), graphNode('PairedTextToDOM', 'pairs'),
    graphNode('DOMAccumulator', 'history'), graphNode('TextToDOM', 'preview'),
    graphNode('DOMCombiner', 'combined'), graphNode('LiveTextDisplay', 'live'),
  ], edges: [
    edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'final', 'translation', 'text'),
    ...['source', 'text', 'error'].map(port => edge('translation', port, 'pairs', port)),
    edge('pairs', 'dom', 'history', 'append'), edge('history', 'dom', 'combined', 'first'),
    edge('speech', 'provisional', 'preview', 'text'), edge('preview', 'dom', 'combined', 'second'),
    edge('combined', 'dom', 'live', 'dom'),
  ] };
}
