import { defaultGraph, GRAPH_KEY, GRAPH_VERSION } from './graph.js';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, entryGraph, resolvedEntryGraph, entryError, exportEntry, exportDraft, legacyChanged } from './graph-library.js';
import { GraphEditor } from './graph-editor.js';
import { graphModelStatus } from './graph-model-status.js';
import { GraphDraftSession, recoveryDrafts, acquireGraphLease } from './graph-draft-session.js';

const element = id => document.getElementById(id);
const preparation = graphModelStatus(element('graph-models'));
const store = new GraphLibrary(localStorage);
async function openEditor() {
  let { library, warning } = await openLibrary(localStorage);
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || library.assignments.live;
  params.set('id', id); history.replaceState(null, '', `?${params}`);
  const parentId = params.get('parent');
  if (parentId) {
    const back = document.createElement('a'); back.textContent = 'Back to parent graph';
    back.href = `?id=${encodeURIComponent(parentId)}&restore=1`; document.querySelector('header nav').append(back);
  }
  let lease, lockError = '';
  try { if (params.get('viewer') !== '1') lease = await acquireGraphLease(navigator.locks, id); } catch (error) { lockError = error.message; }
  library = readLibrary(localStorage);
  let entry = library.graphs.find(entry => entry.id === id);
  if (!entry) {
    lease?.release();
    const drafts = recoveryDrafts(localStorage, id);
    try { const parent = JSON.parse(sessionStorage.getItem(`subgraph-parent-draft:${id}`)); if (parent) drafts.push(parent); } catch { /* Optional older cache. */ }
    for (const draft of drafts) {
      const text = document.createElement('textarea'); text.readOnly = true; text.setAttribute('aria-label', 'Deleted parent draft JSON'); text.value = JSON.stringify(draft.graph, null, 2); element('graph-editor').append(text);
    }
    throw Error('This graph was deleted in another page. Your draft is kept below for copying into a new Library entry.');
  }
  let base = entry.revision, conflict = false, legacyConflict = legacyChanged(localStorage, library);
  let invalidSaved = !!entryError(entry, library);
  element('graph-name').textContent = entry.name;
  element('errors').textContent = [warning, invalidSaved ? `Saved graph unavailable: ${entryError(entry, library)} The original is available under Graph actions → Saved JSON. Repair by importing a copy as a new graph in Library.` : ''].filter(Boolean).join(' ');
  const controls = document.createElement('div'); controls.className = 'graph-recovery';
  const leaseNotice = document.createElement('p'); leaseNotice.setAttribute('role', 'status');
  const acquire = document.createElement('button'); acquire.textContent = 'Start editing';
  const reload = document.createElement('button'); reload.textContent = 'Reload latest graph'; reload.hidden = true;
  controls.append(leaseNotice, acquire, reload); element('graph-editor').before(controls);
  function showLease() {
    leaseNotice.textContent = lease ? '' : lockError || 'Read-only: editing requires an exclusive lease. Another tab/window may be editing this graph. Choose Start editing when it is available.';
    acquire.hidden = !!lease; acquire.disabled = !!lockError;
  }
  showLease();
  let session;
  const initialDraft = invalidSaved ? entry.kind === 'subgraph'
    ? { version: GRAPH_VERSION, nodes: [], edges: [], interface: { inputs: [], outputs: [] } }
    : defaultGraph() : entryGraph(entry, library);
  const editor = new GraphEditor(element('graph-editor'), initialDraft, {
    invalidSaved, readOnly: !lease, definitions: library.graphs, graphId: id, kind: entry.kind || 'graph',
    onDraft: graph => session?.changed(graph), onRetry: () => { void flush().catch(() => {}); }, onFlush: () => flush(),
    onExport: graph => { try { return exportDraft(entry, graph, readLibrary(localStorage)); } catch { return JSON.stringify(graph, null, 2); } },
    onCreateSubgraph: async (definition, revision) => {
      if (!lease || conflict || legacyConflict) throw Error('Graph changed elsewhere. Export the draft or reload the latest graph before creating a subgraph.');
      library = await store.create({ ...definition, replacementSource: { id, revision } });
      editor.definitions = library.graphs;
      entry = library.graphs.find(item => item.id === id); base = entry.revision;
      // Creation saved both entries in one transaction. Adopt that baseline
      // without clearing editor history; applying the replacement is one edit.
      editor.saved = entryGraph(entry, library); makeSession();
      setTimeout(() => {
        try { preparation.replace(resolvedEntryGraph(entry, library)); }
        catch (error) { element('errors').textContent = `Graph saved; model preparation unavailable: ${error.message}. Open Models for recovery.`; }
      }, 0);
      return library;
    },
    onEditSubgraph: async sharedId => {
      try { await flush(); sessionStorage.setItem(`subgraph-parent-draft:${id}`, JSON.stringify({ base, graph: editor.draft })); location.href = `?id=${encodeURIComponent(sharedId)}&parent=${encodeURIComponent(id)}`; }
      catch (error) { element('errors').textContent = `Cannot navigate until Auto Save succeeds: ${error.message}. Repair, retry or export the draft.`; }
    }
  });
  function makeSession() {
    session?.close();
    session = new GraphDraftSession({ id, base, graph: editor.saved || editor.draft, storage: localStorage, sessionId: crypto.randomUUID(),
      validate: graph => editor.assert(graph),
      persist: async (graph, revision) => {
        if (!lease) throw Error('Read-only: acquire editing before saving.');
        if (conflict || legacyConflict) throw Error('Saved graph changed elsewhere. Export your draft or reload the latest graph using recovery controls.');
        const saved = await store.save(id, revision, graph);
        library = saved; editor.definitions = saved.graphs;
        entry = saved.graphs.find(item => item.id === id); base = entry.revision;
        // Model preparation never participates in persistence success/failure.
        setTimeout(() => {
          try { preparation.replace(resolvedEntryGraph(entry, library)); }
          catch (error) { element('errors').textContent = `Graph saved; model preparation unavailable: ${error.message}. Open Models for recovery.`; }
        }, 0);
        return { base };
      }, onState: (status, error) => { editor.setSaveState(status === 'Saved' && editor.transaction ? 'Saving…' : status, error); if (error?.includes('changed in another') || error?.includes('changed elsewhere')) { reload.hidden = false; editor.externalChange = true; session.blocked = error; } },
      onSaved: graph => { editor.saved = structuredClone(graph); editor.updateSummary(); }
    });
    if (legacyConflict) { session.blocked = 'The legacy graph changed elsewhere. Recover it in Graph Library before Auto Save.'; editor.setSaveState('Save failed', session.blocked); }
    if (invalidSaved) { session.blocked = 'This saved graph is invalid; the original has been kept. Export its original and import a repaired copy as a new graph in Library.'; session.state('Save failed', session.blocked); }
  }
  makeSession();
  if (!invalidSaved) setTimeout(() => { try { preparation.replace(resolvedEntryGraph(entry, library), { inspect: true }); } catch { /* Saved dependency diagnostics remain visible. */ } }, 0);
  async function flush() {
    if (!lease) return;
    do { editor.commitEdit(); await session.flush(); } while (editor.transaction || editor.isDirty());
  }
  async function refreshForEditing() {
    if (session?.inflight) await session.inflight.catch(() => {});
    const current = readLibrary(localStorage), next = current.graphs.find(item => item.id === id);
    const graph = entryGraph(next, current);
    library = current; entry = next; base = next.revision; conflict = false; legacyConflict = legacyChanged(localStorage, current);
    invalidSaved = false; editor.definitions = current.graphs; editor.setSaved(graph); makeSession();
    element('graph-name').textContent = next.name; reload.hidden = true;
  }
  acquire.onclick = async () => {
    acquire.disabled = true;
    try {
      const next = await acquireGraphLease(navigator.locks, id);
      if (!next) { showLease(); return; }
      lease = next;
      try { await refreshForEditing(); } catch (error) { lease.release(); lease = null; throw error; }
      params.delete('viewer'); history.replaceState(null, '', `?${params}`);
      editor.setReadOnly(false); showLease(); showRecovery();
    } catch (error) { leaseNotice.textContent = `Cannot start editing: ${error.message}`; }
    finally { acquire.disabled = !!lockError; }
  };
  reload.onclick = async () => {
    if (!confirm('Reload the latest graph? Export your local draft first if needed. Recovery checkpoints will remain available.')) return;
    try { await refreshForEditing(); showRecovery(); }
    catch (error) { element('errors').textContent = `Latest graph unavailable: ${error.message}. Your local draft is kept; export it from Graph actions.`; }
  };
  const recovery = document.createElement('div'); controls.append(recovery);
  function showRecovery() {
    recovery.replaceChildren();
    let drafts;
    try { drafts = recoveryDrafts(localStorage, id); }
    catch (error) { editor.setSaveState('Save failed', `Cannot read recovery storage: ${error.message}. Export your draft before closing.`); return; }
    // Also honor drafts kept by the old parent/subgraph navigation workflow.
    try {
      const parent = JSON.parse(sessionStorage.getItem(`subgraph-parent-draft:${id}`));
      if (parent) drafts.push({ ...parent, key: null });
    } catch { /* The new recovery mechanism does not depend on this old cache. */ }
    for (const draft of drafts) {
      if (JSON.stringify(draft.graph) === JSON.stringify(editor.saved)) continue;
      const details = document.createElement('details'), title = document.createElement('summary'), text = document.createElement('textarea');
      title.textContent = draft.base === base ? 'Recoverable draft available' : 'Older-base draft available (export only)';
      text.readOnly = true; text.setAttribute('aria-label', 'Recoverable draft JSON');
      try { text.value = exportDraft(entry, draft.graph, library); } catch { text.value = JSON.stringify(draft.graph, null, 2); }
      // Invalid field values remain editable, but malformed recovery envelopes
      // must stay export-only instead of crashing the canvas during restoration.
      const graph = draft.graph, tuple = value => Array.isArray(value) && value.length === 2 && value.every(item => typeof item === 'string');
      const renderable = graph?.version === GRAPH_VERSION && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
        && graph.nodes.every(node => typeof node?.id === 'string' && typeof node.type === 'string' && node.settings && typeof node.settings === 'object' && Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y))
        && graph.edges.every(edge => tuple(edge?.from) && tuple(edge?.to))
        && (editor.kind !== 'subgraph' || ['inputs', 'outputs'].every(side => Array.isArray(graph.interface?.[side]) && graph.interface[side].every(port => ['id', 'name', 'node', 'port'].every(key => typeof port?.[key] === 'string'))));
      const restore = document.createElement('button'); restore.textContent = 'Restore draft'; restore.disabled = !lease || draft.base !== base || invalidSaved || !renderable;
      restore.onclick = () => {
        // Recheck the authoritative revision immediately before restoration.
        const current = readLibrary(localStorage).graphs.find(item => item.id === id);
        if (!lease || current?.revision !== draft.base) { editor.setSaveState('Save failed', 'This recovery draft has an older base. Copy/export it and import it as a new graph in Library.'); reload.hidden = false; return; }
        editor.edit(() => { editor.draft = structuredClone(draft.graph); editor.draw(); });
        if (draft.key) session.keys.add(draft.key);
        else sessionStorage.removeItem(`subgraph-parent-draft:${id}`);
        details.remove();
      };
      const discard = document.createElement('button'); discard.textContent = 'Discard recovery copy'; discard.disabled = !lease;
      discard.onclick = () => { if (confirm('Discard this recovery copy?')) { if (draft.key) localStorage.removeItem(draft.key); else sessionStorage.removeItem(`subgraph-parent-draft:${id}`); details.remove(); } };
      const download = document.createElement('button'); download.textContent = 'Export recovery draft JSON';
      download.onclick = () => {
        const url = URL.createObjectURL(new Blob([text.value], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'recoverable-graph.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
      };
      details.append(title, text, restore, download, discard); recovery.append(details);
    }
  }
  showRecovery();
  const recoveryCopy = document.createElement('details'), recoveryTitle = document.createElement('summary'), recoveryText = document.createElement('textarea');
  recoveryTitle.textContent = 'Saved JSON'; recoveryText.readOnly = true;
  recoveryText.setAttribute('aria-label', 'Original saved graph JSON'); recoveryText.value = exportEntry(entry, library);
  recoveryCopy.hidden = !invalidSaved; recoveryCopy.className = 'graph-recovery'; recoveryCopy.append(recoveryTitle, recoveryText);
  editor.actions.querySelector('.graph-command-list').append(recoveryCopy);

  // Catch app navigation before navigation.js or default link navigation. A
  // failed persist blocks the action; downloads never delay navigation.
  let replay = false;
  document.addEventListener('click', event => {
    const target = event.target.closest('a[href], [data-live]');
    if (!target || replay || event.defaultPrevented || target.hasAttribute('download')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void flush().then(() => { replay = true; try { target.click(); } finally { replay = false; } }).catch(error => {
      element('errors').textContent = `Navigation blocked: ${error.message}. Repair or retry Auto Save, or export the draft.`;
    });
  }, true);
  function checkpoint() {
    if (!lease) return true;
    editor.commitEdit();
    const safe = session.checkpoint();
    void session.flush().catch(() => {}); return safe;
  }
  window.addEventListener('beforeunload', event => {
    if (!checkpoint()) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') checkpoint(); });
  window.addEventListener('pagehide', () => { checkpoint(); lease?.release(); lease = null; session.close(); });
  // BFCache restoration requires a fresh explicit acquisition and latest read.
  window.addEventListener('pageshow', event => { if (event.persisted) { const url = new URL(location.href); url.searchParams.set('viewer', '1'); location.replace(url); } });
  window.addEventListener('storage', event => {
    if (![LIBRARY_KEY, GRAPH_KEY, null].includes(event.key)) return;
    try {
      const current = readLibrary(localStorage);
      if (legacyChanged(localStorage, current)) {
        legacyConflict = true; session.blocked = 'The legacy graph changed elsewhere. Recover it in Graph Library before Auto Save.'; preparation.clear();
        editor.setSaveState('Save failed', 'The legacy graph changed elsewhere. Recover it in Graph Library before Auto Save. Your draft is kept.'); reload.hidden = false; return;
      }
      legacyConflict = false; const previousDefinitions = editor.definitions; editor.definitions = current.graphs;
      const next = current.graphs.find(item => item.id === id);
      if (next?.revision === base) {
        // Dependency changes can alter resolved models without a parent edit.
        library = current;
        const references = new Set([...editor.draft.nodes, ...(editor.saved?.nodes || [])].filter(node => node.type === 'Subgraph').map(node => node.subgraphId));
        const dependencyChanged = [...references].some(id => previousDefinitions.find(entry => entry.id === id)?.revision !== current.graphs.find(entry => entry.id === id)?.revision);
        if (!editor.palette.hidden) editor.filterPalette();
        if (dependencyChanged) {
          if (editor.composing) editor.refreshAfterComposition = true; else editor.draw();
          try { preparation.replace(resolvedEntryGraph(next, current), { inspect: true }); } catch { preparation.clear(); }
        } else { editor.errors.textContent = editor.diagnostics(); editor.updateSummary(); }

        return;
      }
      if (editor.isDirty() || editor.transaction || session.inflight) {
        editor.saved = entryGraph(next, current); library = current; entry = next;
        conflict = true; session.blocked = 'Saved graph changed elsewhere. Your local draft is kept. Export it or reload the latest graph.'; editor.externalChange = true; preparation.clear(); checkpoint();
        editor.setSaveState('Save failed', 'Saved graph changed elsewhere. Your local draft is kept. Export it or reload the latest graph.'); reload.hidden = false;
      } else {
        const graph = entryGraph(next, current);
        library = current; entry = next; base = next.revision;
        invalidSaved = false; editor.setSaved(graph); makeSession(); element('graph-name').textContent = next.name;
        preparation.replace(resolvedEntryGraph(next, current), { inspect: true });
      }
    } catch (error) {
      conflict = true; session.blocked = `Saved graph changed but is unavailable: ${error.message}. Export your draft or reload the latest graph.`; preparation.clear(); reload.hidden = false;
      editor.setSaveState('Save failed', `Saved graph changed but is unavailable: ${error.message}. Export your draft from Graph actions.`);
    }
  });
  const stateChannel = new BroadcastChannel('live-graph-state'), liveWindows = new Map();
  stateChannel.onmessage = ({ data }) => {
    if (!data.sessionId) return;
    if (data.state === 'idle') liveWindows.delete(data.sessionId); else liveWindows.set(data.sessionId, data);
    const live = [...liveWindows.values()].find(live => live.graphId === id);
    editor.setActive(live?.graph || null, live?.state || 'idle', live?.tabId);
  };
  function refreshActive() { stateChannel.postMessage({ type: 'get-live-graph-state' }); }
  window.addEventListener('focus', refreshActive); window.addEventListener('pagehide', () => stateChannel.close()); refreshActive();
}
void openEditor().catch(error => { element('errors').textContent = `${error.message} Open Graph Library for recovery.`; });
