import { accumulateDisplay } from './text-accumulator.js';
import { graphNode, edge, GRAPH_VERSION } from '../../extension/graph.js';

// Fixed English transcript: sentence splits, independent equal phrases,
// disambiguating context, and an unpunctuated Stop tail. No live ASR variability.
export const windowTranscript = [
  'The meeting ', 'starts at ten. ', 'Please wait. ', 'Please wait. ',
  'I went to the bank ', 'to deposit money. ',
  'Later I sat on the bank ', 'of the river. ',
  'We need to finish ', 'this project by Friday',
];
export const closedWindows = [
  'The meeting starts at ten. Please wait. Please wait. I went to the bank to deposit money. Later I sat on the bank of the river. We need to finish this project b',
  'y Friday',
];

export function windowGraph(mode = 'window', translator = 'TranslateGemmaEnJa') {
  const nodes = [graphNode('Text', 'input'), graphNode(translator, 'translator'), graphNode('LiveTextDisplay', 'display')];
  const edges = [];
  if (mode === 'baseline') edges.push(edge('input', 'value', 'translator', 'text'));
  else {
    const window = graphNode('TextWindow', 'window');
    const chars = graphNode('Number', 'window-chars'), wait = graphNode('Number', 'window-wait');
    chars.settings.value = 160; wait.settings.value = 0.8;
    nodes.push(window, chars, wait);
    edges.push(edge(chars.id, 'value', window.id, 'maxChars'), edge(wait.id, 'value', window.id, 'maxWaitSeconds'));
    edges.push(edge('input', 'value', 'window', 'text'), edge('window', 'text', 'translator', 'text'));
  }
  if (mode === 'revisable') {
    nodes.push(graphNode('TranslationCommit', 'commit'), graphNode('TextToDOM', 'preview-dom'), graphNode('LiveTextDisplay', 'preview-display'));
    edges.push(edge('window', 'text', 'commit', 'boundary'),
      ...['source', 'text', 'error'].map(port => edge('translator', port, 'commit', port)),
      edge('translator', 'provisionalText', 'preview-dom', 'text'), edge('preview-dom', 'dom', 'preview-display', 'dom'),
      edge('commit', 'final', 'display', 'append'));
  } else edges.push(edge('translator', 'text', 'display', 'append'));
  return accumulateDisplay({ version: GRAPH_VERSION, nodes, edges }, 'display');
}
