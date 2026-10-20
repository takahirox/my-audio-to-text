import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';

// Fixed English transcript: sentence splits, independent equal phrases,
// disambiguating context, and an unpunctuated Stop tail. No live ASR variability.
export const windowTranscript = [
  'The meeting', 'starts at ten.', 'Please wait.', 'Please wait.',
  'I went to the bank', 'to deposit money.',
  'Later I sat on the bank', 'of the river.',
  'We need to finish', 'this project by Friday',
];
export const closedWindows = [
  'The meeting starts at ten.', 'Please wait.', 'Please wait.',
  'I went to the bank to deposit money.', 'Later I sat on the bank of the river.',
  'We need to finish this project by Friday',
];

export function windowGraph(mode = 'window', translator = 'TranslateGemmaEnJa') {
  const nodes = [graphNode('Text', 'input'), graphNode(translator, 'translator'), graphNode('LiveTextDisplay', 'display')];
  const edges = [];
  if (mode === 'baseline') edges.push(edge('input', 'value', 'translator', 'text'));
  else {
    const window = graphNode('TextWindow', 'window');
    window.settings = { maxChars: 160, maxWaitMs: 800, sentenceBoundary: 'on' };
    nodes.push(window);
    edges.push(edge('input', 'value', 'window', 'text'), edge('window', 'text', 'translator', 'text'));
  }
  if (mode === 'revisable') {
    nodes.push(graphNode('TranslationCommit', 'commit'));
    edges.push(edge('window', 'provisional', 'translator', 'provisional'), edge('window', 'text', 'commit', 'boundary'),
      ...['source', 'text', 'error'].map(port => edge('translator', port, 'commit', port)),
      edge('commit', 'provisional', 'display', 'replace'), edge('commit', 'final', 'display', 'append'));
  } else edges.push(edge('translator', 'text', 'display', 'append'));
  return { version: GRAPH_VERSION, nodes, edges };
}
