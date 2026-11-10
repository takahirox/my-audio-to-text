import { defaultGraph, GRAPH_KEY } from './graph.js';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, entryGraph, entryError, exportEntry, legacyChanged } from './graph-library.js';
import { GraphEditor } from './graph-editor.js';
import { graphModelStatus } from './graph-model-status.js';

const element = id => document.getElementById(id);
const preparation = graphModelStatus(element('graph-models'));
const store = new GraphLibrary(localStorage);
async function openEditor() {
  const { library, warning } = await openLibrary(localStorage);
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || library.assignments.live;
  let entry = library.graphs.find(entry => entry.id === id);
  if (!entry) throw Error('This graph no longer exists. Return to Graph Library.');
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  let base = entry.revision, conflict = false, legacyConflict = legacyChanged(localStorage, library);
  const invalidSaved = !!entryError(entry);
  element('graph-name').textContent = entry.name;
  element('errors').textContent = [warning, invalidSaved ? `Saved graph unavailable: ${entryError(entry)} The original is available under Graph actions → Saved JSON. Repair by importing a copy as a new graph in Library.` : ''].filter(Boolean).join(' ');
  const recoveryCopy = document.createElement('details');
  const recoveryTitle = document.createElement('summary'); recoveryTitle.textContent = 'Saved JSON';
  const recoveryText = document.createElement('textarea'); recoveryText.readOnly = true;
  recoveryText.setAttribute('aria-label', 'Original saved graph JSON');
  recoveryText.value = exportEntry(entry);
  recoveryCopy.hidden = !invalidSaved;
  recoveryCopy.className = 'graph-recovery';
  recoveryCopy.append(recoveryTitle, recoveryText);
  async function persist(next) {
    if (conflict) throw Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
    const saved = await store.save(id, base, next);
    entry = saved.graphs.find(entry => entry.id === id); base = entry.revision;
    element('errors').textContent = '';
    const graph = entryGraph(entry);
    preparation.replace(graph);
    return graph;
  }
  const editor = new GraphEditor(element('graph-editor'), invalidSaved ? defaultGraph() : entryGraph(entry), { invalidSaved, onSave: persist, onLoad: () => {
    const next = readLibrary(localStorage).graphs.find(entry => entry.id === id);
    const graph = entryGraph(next);
    conflict = false; base = next.revision; entry = next;
    element('graph-name').textContent = entry.name;
    return graph;
  } });
  editor.actions.querySelector('.graph-command-list').append(recoveryCopy);
  window.addEventListener('beforeunload', event => {
    if (editor.isDirty()) { event.preventDefault(); event.returnValue = ''; }
  });
  window.addEventListener('storage', event => {
    if (![LIBRARY_KEY, GRAPH_KEY, null].includes(event.key)) return;
    try {
      const current = readLibrary(localStorage);
      if (legacyChanged(localStorage, current)) {
        legacyConflict = true; preparation.clear();
        element('errors').textContent = 'The legacy graph changed in another page. Recover it in Graph Library before saving. Your draft has been kept.';
        return;
      }
      if (legacyConflict) { legacyConflict = false; element('errors').textContent = ''; }
      const next = current.graphs.find(entry => entry.id === id);
      if (next?.revision === base) return; // Other entries/assignments cannot dirty this draft.
      preparation.clear();
      const graph = entryGraph(next), dirty = editor.isDirty();
      conflict = dirty; editor.receiveSaved(graph);
      element('graph-name').textContent = next.name;
      if (!dirty) { base = next.revision; entry = next; }
    } catch (error) { conflict = true; preparation.clear(); element('errors').textContent = `Saved graph changed but is unavailable: ${error.message} Your draft has been kept; export it from Graph actions.`; }
  });
  const stateChannel = new BroadcastChannel('live-graph-state');
  const liveWindows = new Map();
  stateChannel.onmessage = ({ data }) => {
    if (!data.sessionId) return;
    if (data.state === 'idle') liveWindows.delete(data.sessionId);
    else liveWindows.set(data.sessionId, data);
    const live = [...liveWindows.values()].find(live => live.graphId === id);
    editor.setActive(live?.graph || null, live?.state || 'idle', live?.tabId);
  };
  function refreshActive() { stateChannel.postMessage({ type: 'get-live-graph-state' }); }
  window.addEventListener('focus', () => { void refreshActive(); });
  window.addEventListener('pagehide', () => stateChannel.close());
  void refreshActive();
}
void openEditor().catch(error => {
  element('errors').textContent = `${error.message} Open Graph Library for recovery.`;
});
