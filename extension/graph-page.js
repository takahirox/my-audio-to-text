import { defaultGraph, GRAPH_KEY, GRAPH_VERSION } from './graph.js';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, entryGraph, resolvedEntryGraph, entryError, exportEntry, exportDraft, legacyChanged } from './graph-library.js';
import { GraphEditor } from './graph-editor.js';
import { graphModelStatus } from './graph-model-status.js';

const element = id => document.getElementById(id);
const preparation = graphModelStatus(element('graph-models'));
const store = new GraphLibrary(localStorage);
async function openEditor() {
  let { library, warning } = await openLibrary(localStorage);
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || library.assignments.live;
  let entry = library.graphs.find(entry => entry.id === id);
  if (!entry) {
    // The parent can be deleted in another tab while its shared definition is
    // open. Keep the navigation draft recoverable even without a saved entry.
    const cached = params.get('restore') === '1' && sessionStorage.getItem(`subgraph-parent-draft:${id}`);
    if (cached) {
      const recovery = document.createElement('textarea'); recovery.readOnly = true;
      recovery.setAttribute('aria-label', 'Deleted parent draft JSON'); recovery.value = JSON.stringify(JSON.parse(cached).graph, null, 2);
      element('graph-editor').append(recovery);
      element('errors').textContent = 'This parent graph was deleted in another page. Your draft is kept below; copy it and import it as a new graph in Graph Library.';
      return;
    }
    throw Error('This graph no longer exists. Return to Graph Library.');
  }
  params.set('id', id);
  history.replaceState(null, '', `?${params}`);
  const parentId = params.get('parent');
  if (parentId) {
    const back = document.createElement('a'); back.textContent = 'Back to parent graph';
    back.href = `?id=${encodeURIComponent(parentId)}&restore=1`;
    document.querySelector('header nav').append(back);
  }
  let base = entry.revision, conflict = false, legacyConflict = legacyChanged(localStorage, library);
  const invalidSaved = !!entryError(entry, library);
  element('graph-name').textContent = entry.name;
  element('errors').textContent = [warning, invalidSaved ? `Saved graph unavailable: ${entryError(entry, library)} The original is available under Graph actions → Saved JSON. Repair by importing a copy as a new graph in Library.` : ''].filter(Boolean).join(' ');
  const recoveryCopy = document.createElement('details');
  const recoveryTitle = document.createElement('summary'); recoveryTitle.textContent = 'Saved JSON';
  const recoveryText = document.createElement('textarea'); recoveryText.readOnly = true;
  recoveryText.setAttribute('aria-label', 'Original saved graph JSON');
  recoveryText.value = exportEntry(entry, library);
  recoveryCopy.hidden = !invalidSaved;
  recoveryCopy.className = 'graph-recovery';
  recoveryCopy.append(recoveryTitle, recoveryText);
  async function persist(next) {
    if (conflict) throw Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
    const saved = await store.save(id, base, next);
    library = saved; editor.definitions = saved.graphs;
    entry = saved.graphs.find(entry => entry.id === id); base = entry.revision;
    element('errors').textContent = '';
    const graph = entryGraph(entry, library);
    preparation.replace(resolvedEntryGraph(entry, library));
    try { sessionStorage.removeItem(`subgraph-parent-draft:${id}`); } catch { /* Optional navigation cache cannot undo a successful save. */ }
    return graph;
  }
  let navigatingWithDraft = false;
  const initialDraft = invalidSaved ? entry.kind === 'subgraph'
    ? { version: GRAPH_VERSION, nodes: [], edges: [], interface: { inputs: [], outputs: [] } }
    : defaultGraph() : entryGraph(entry, library);
  const editor = new GraphEditor(element('graph-editor'), initialDraft, {
    invalidSaved, definitions: library.graphs, graphId: id, kind: entry.kind || 'graph', onSave: persist,
    onExport: graph => { try { return exportDraft(entry, graph, readLibrary(localStorage)); } catch { return JSON.stringify(graph, null, 2); } },
    onCreateSubgraph: async (definition, revision) => {
      if (conflict) throw Error('Load saved before creating a subgraph; your draft has been kept.');
      library = await store.create({ ...definition, replacementSource: { id, revision } }); return library;
    },
    onEditSubgraph: sharedId => {
      try {
        sessionStorage.setItem(`subgraph-parent-draft:${id}`, JSON.stringify({ base, graph: editor.draft }));
        navigatingWithDraft = true;
        location.href = `?id=${encodeURIComponent(sharedId)}&parent=${encodeURIComponent(id)}`;
      } catch (error) { element('errors').textContent = `Cannot preserve the parent draft for navigation: ${error.message}. Save or export it first.`; }
    }, onLoad: () => {
      library = readLibrary(localStorage); editor.definitions = library.graphs;
      const next = library.graphs.find(entry => entry.id === id);
      const graph = entryGraph(next, library);
      conflict = false; base = next.revision; entry = next;
      try { sessionStorage.removeItem(`subgraph-parent-draft:${id}`); } catch { /* Saved data remains authoritative. */ }
      element('graph-name').textContent = entry.name;
      return graph;
    }
  });
  if (params.get('restore') === '1') {
    try {
      const draft = JSON.parse(sessionStorage.getItem(`subgraph-parent-draft:${id}`));
      if (draft) {
        // Retain even an invalid draft for repair/export after external changes.
        editor.draft = draft.graph; conflict = draft.base !== base;
        editor.externalChange = conflict; editor.draw();
      }
    } catch (error) { element('errors').textContent = `Parent draft recovery failed: ${error.message}`; }
  }
  editor.actions.querySelector('.graph-command-list').append(recoveryCopy);
  window.addEventListener('beforeunload', event => {
    if (editor.isDirty() && !navigatingWithDraft) { event.preventDefault(); event.returnValue = ''; }
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
      library = current; editor.definitions = current.graphs;
      const next = current.graphs.find(entry => entry.id === id);
      if (next?.revision === base) {
        // Shared changes refresh labels/contracts/diagnostics without dirtying
        // or rewriting the parent. An active session still owns its snapshot.
        preparation.clear(); editor.filterPalette(); editor.draw(); return;
      }
      preparation.clear();
      const graph = entryGraph(next, current), dirty = editor.isDirty();
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
