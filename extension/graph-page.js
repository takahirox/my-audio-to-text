import { readGraph, saveGraph, defaultGraph, GRAPH_KEY } from './graph.js';
import { GraphEditor } from './graph-editor.js';
import { graphModelStatus } from './graph-model-status.js';

const element = id => document.getElementById(id);
const preparation = graphModelStatus(element('graph-models'));
let graph, editor, base, recoveryGraph, conflict = false;
try { graph = readGraph(localStorage); }
catch (error) {
  recoveryGraph = error.recoveryGraph;
  element('errors').textContent = `Saved graph unavailable: ${error.message}${recoveryGraph ? ' The affected graph is open as an unsaved repair draft.' : '. Reset draft and Save to recover.'}`;
  graph = defaultGraph();
}
base = localStorage.getItem(GRAPH_KEY);
async function persist(next) {
  const saved = await navigator.locks.request('processing-graph-save', async () => {
    if (conflict || localStorage.getItem(GRAPH_KEY) !== base) throw new Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
    const saved = saveGraph(localStorage, next); base = localStorage.getItem(GRAPH_KEY);
    element('errors').textContent = ''; return saved;
  });
  // Keep preparation outside the persistence transaction and its error path.
  // The immutable saved snapshot, never the editable draft, chooses assets.
  preparation.replace(saved);
  return saved;
}
editor = new GraphEditor(element('graph-editor'), graph, { recoveryGraph, onSave: persist, onLoad: () => {
  const next = readGraph(localStorage);
  conflict = false; base = localStorage.getItem(GRAPH_KEY); return next;
} });
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY && event.key !== null) return;
  // Another page now owns the saved snapshot. Stop preparing this page's old
  // requirements; opening/loading a saved graph must not start downloads.
  preparation.clear();
  try {
    const next = readGraph(localStorage), dirty = editor.isDirty();
    conflict = dirty; editor.receiveSaved(next);
    if (!dirty) base = localStorage.getItem(GRAPH_KEY);
  } catch (error) { conflict = true; element('errors').textContent = `Saved graph changed but is invalid: ${error.message}. Reload to recover.`; }
});
const stateChannel = new BroadcastChannel('live-graph-state');
stateChannel.onmessage = ({ data }) => editor.setActive(data.graph, data.state, data.tabId);
async function refreshActive() {
  try {
    const live = await chrome.runtime.sendMessage({ type: 'get-live-graph-state' });
    editor.setActive(live?.graph, live?.state || 'idle', live?.tabId);
  } catch { editor.setActive(null, 'idle'); }
}
window.addEventListener('focus', () => { void refreshActive(); });
window.addEventListener('pagehide', () => stateChannel.close());
void refreshActive();
