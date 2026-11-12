import { assertGraph, defaultGraph, GRAPH_KEY, executableGraph } from './graph.js';
import { assertSubgraph, resolveSubgraphs, references, portContract, executableBoundaryEdges } from './subgraphs.js';
import { webVoiceError } from './web-voice-graph.js';

export const LIBRARY_KEY = 'processing-graph-library-v1';
export const LIBRARY_LOCK = 'processing-graph-save';
// Notify the coordinator after committed library changes. It reads the canonical
// extension-origin storage through its inert offscreen host; no model preparation.
function notifyVoiceLibrary() {
  try {
    if (globalThis.chrome?.runtime?.sendMessage) void chrome.runtime.sendMessage({ type: 'web-voice-library-changed' }).catch(() => {});
  } catch { /* An invalidated context must not turn a committed save into an error. */ }
}
const conflict = () => Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
const token = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function notifyLibrary() {
  // A closed/invalidated messaging context must not turn a committed save into
  // a reported write failure. A later worker generation refreshes the menus.
  try {
    if (globalThis.chrome?.runtime?.sendMessage) void chrome.runtime.sendMessage({ type: 'graph-library-changed' }).catch(() => {});
  } catch {}
}
const validText = value => typeof value === 'string' && value.trim().length > 0;
const nameCollator = new Intl.Collator('ja', { numeric: true });
export const compareGraphNames = (a, b) => nameCollator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Validate the envelope separately: a corrupt graph must remain recoverable and
// must not prevent browsing or editing other entries. Never normalize stored data.
export function validateLibrary(value) {
  if (!value || value.version !== 1 || !validText(value.revision) || !Array.isArray(value.graphs) || !value.graphs.length
    || !value.assignments || !(value.legacySource === null || typeof value.legacySource === 'string')) throw Error('Invalid or unsupported graph library. Original storage has been kept.');
  const ids = new Set();
  for (const entry of value.graphs) {
    if (!entry || !validText(entry.id) || ids.has(entry.id) || !validText(entry.name) || typeof entry.description !== 'string'
      || !validText(entry.revision) || typeof entry.createdAt !== 'string' || typeof entry.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))
      || !Object.hasOwn(entry, 'graph') || (entry.kind !== undefined && !['graph', 'subgraph'].includes(entry.kind)) || (entry.source !== undefined && typeof entry.source !== 'string')) throw Error('Invalid graph library entry or duplicate graph ID. Original storage has been kept.');
    ids.add(entry.id);
  }
  if (!(value.assignments.live === null || validText(value.assignments.live)) || !(value.assignments.webVoice === null || validText(value.assignments.webVoice))) throw Error('Invalid execution target assignment. Original storage has been kept.');
  return value;
}
export function entryGraph(entry, library) {
  if (!entry) throw Error('Graph no longer exists. Return to Graph Library; your draft has been kept.');
  return entry.kind === 'subgraph' ? assertSubgraph(entry.graph) : assertGraph(entry.graph, library?.graphs);
}
export function resolvedEntryGraph(entry, library) {
  return resolveSubgraphs(entryGraph(entry, library), library?.graphs);
}
export function entryError(entry, library) {
  try { entryGraph(entry, library); resolvedEntryGraph(entry, library); return ''; } catch (error) { return error.message; }
}
export function usable(entry, library) {
  try { return entry.kind !== 'subgraph' && executableGraph(resolvedEntryGraph(entry, library)).nodes.length > 0; } catch { return false; }
}
function initialLibrary(storage) {
  const source = storage.getItem(GRAPH_KEY), stamp = now();
  let graph;
  if (source === null) graph = defaultGraph();
  else { try { graph = JSON.parse(source); } catch { graph = null; } }
  // Store the original object, not assertGraph's upgraded/canonicalized result.
  const id = source === null ? 'default-live' : 'legacy-graph';
  return { version: 1, revision: token(), legacySource: source,
    graphs: [{ id, name: source === null ? 'Live transcription' : 'My saved graph', description: '', createdAt: stamp, updatedAt: stamp, revision: token(), graph, ...(source === null ? {} : { source }) }],
    assignments: { live: id, webVoice: null } };
}
export function readLibrary(storage) {
  const raw = storage.getItem(LIBRARY_KEY);
  return raw === null ? initialLibrary(storage) : validateLibrary(JSON.parse(raw));
}
export function legacyChanged(storage, library) { return storage.getItem(GRAPH_KEY) !== library.legacySource; }
async function exclusive(locks, action) {
  // MV3 pages have Web Locks. Refuse unsafe writes on unsupported hosts.
  if (!locks?.request) throw Error('Graph storage requires Web Locks. Your saved data has been kept.');
  return locks.request(LIBRARY_LOCK, action);
}
export async function openLibrary(storage, locks = globalThis.navigator?.locks) {
  try {
    return await exclusive(locks, () => {
      const library = readLibrary(storage);
      if (storage.getItem(LIBRARY_KEY) === null) { storage.setItem(LIBRARY_KEY, JSON.stringify(library)); notifyLibrary(); }
      return { library, warning: legacyChanged(storage, library) ? 'The legacy graph changed in another page. Recover it in Graph Library before saving.' : '' };
    });
  } catch (error) {
    // One deterministic read-only fallback; never retry writes or erase a source.
    return { library: readLibrary(storage), warning: `Library could not be committed: ${error.message} Read-only fallback; reload after restoring storage to save changes.` };
  }
}
function savedGraphContext(storage, id) {
  const library = readLibrary(storage);
  if (legacyChanged(storage, library)) throw Error('The legacy graph changed in another page. Recover it in Graph Library before continuing.');
  const entry = library.graphs.find(entry => entry.id === id);
  if (!entry) throw Error('The selected graph no longer exists. Use the toolbar context menu to open a saved runnable graph.');
  if (entry.kind === 'subgraph') throw Error('Choose a parent graph; reusable subgraphs cannot run directly.');
  return { id: entry.id, name: entry.name, graph: resolvedEntryGraph(entry, library), revision: entry.revision };
}
export function readSelectedGraph(storage, id) {
  const context = savedGraphContext(storage, id);
  if (!executableGraph(context.graph).nodes.length) throw Error('No executable path in the selected graph. Connect a path in Graph Editor or choose another graph from the toolbar context menu.');
  return context;
}
export function readLiveGraph(storage) { return savedGraphContext(storage, readLibrary(storage).assignments.live); }
export function exportEntry(entry, library) {
  // Invalid sources are exported byte-for-byte, including malformed legacy JSON.
  if (entryError(entry, library)) return entry.source ?? JSON.stringify(entry.graph, null, 2);
  const dependencies = new Set(entry.graph.nodes.filter(node => node.type === 'Subgraph').map(node => node.subgraphId));
  if (entry.kind === 'subgraph' || dependencies.size) {
    const entries = [entry, ...(library?.graphs || []).filter(item => dependencies.has(item.id))];
    return JSON.stringify({ format: 'graph-bundle', version: 1, root: entry.id,
      graphs: entries.map(({ id, name, description, kind = 'graph', graph }) => ({ id, name, description, kind, graph })) }, null, 2) + '\n';
  }
  return JSON.stringify(entryGraph(entry, library), null, 2) + '\n';
}
export function exportDraft(entry, graph, library) {
  // Original-source recovery belongs only to saved entries, never to a draft.
  const { source, ...metadata } = entry;
  return exportEntry({ ...metadata, graph }, library);
}

export function assertSubgraphUpdate(library, id, graph) {
  const entry = library.graphs.find(entry => entry.id === id);
  if (!entry) return;
  const parents = references(library, id);
  const breaking = ['inputs', 'outputs'].flatMap(side => entry.graph.interface[side].filter(port => {
    const replacement = graph.interface[side].find(next => next.id === port.id);
    return !replacement || portContract(entry.graph, side, port) !== portContract(graph, side, replacement);
  }).map(port => port.name));
  for (const side of ['inputs', 'outputs']) for (const port of graph.interface[side]) {
    if (!entry.graph.interface[side].some(previous => previous.id === port.id)) breaking.push(port.name);
  }
  const resolution = 'Duplicate this subgraph for a new contract, replace instances and reconnect in those parents, then save them before retiring the old definition. Your draft has been kept.';
  if (parents.length && breaking.length) throw Error(`Cannot change exposed ports (${breaking.join(', ')}). Referenced by: ${parents.map(parent => parent.name).join(', ')}. ${resolution}`);
  const candidate = library.graphs.map(item => item.id === id ? { ...entry, graph } : item);
  const affected = [];
  for (const parent of parents) {
    // Expansion also rejects errors such as internal event cycles.
    const next = executableBoundaryEdges(parent.graph, candidate);
    const previous = executableBoundaryEdges(parent.graph, library.graphs);
    if ([...previous].some(route => !next.has(route))) affected.push(parent.name);
  }
  if (affected.length) throw Error(`Cannot disable executable paths. Referenced by: ${affected.join(', ')}. Restore the internal connections. ${resolution}`);
  const incompatible = [];
  for (const parent of parents) {
    // Every compatible parent can be selected from a field mic. Preserve that
    // capability even when it is not the legacy Web voice default.
    if (webVoiceError(resolveSubgraphs(parent.graph, library.graphs))) continue;
    const reason = webVoiceError(resolveSubgraphs(parent.graph, candidate));
    if (reason) incompatible.push(`${parent.name}: ${reason}`);
  }
  if (incompatible.length) throw Error(`Cannot break Web voice paths. Referenced by: ${incompatible.join('; ')}. ${resolution}`);
}
export class GraphLibrary {
  constructor(storage, locks = globalThis.navigator?.locks) { this.storage = storage; this.locks = locks; }
  async change(action, { revision, recoverLegacy = false } = {}) {
    return exclusive(this.locks, () => {
      const before = this.storage.getItem(LIBRARY_KEY), library = readLibrary(this.storage);
      if (revision !== undefined && revision !== library.revision) throw conflict();
      if (!recoverLegacy && legacyChanged(this.storage, library)) throw Error('Legacy graph changed. Recover it as a new graph in Graph Library first. Your draft has been kept.');
      // A conditional change may explicitly report that nothing changed. Recheck
      // under the same lock without revising storage or sending notifications.
      if (action(library) === false && before !== null) return library;
      library.revision = token(); validateLibrary(library);
      if (before !== this.storage.getItem(LIBRARY_KEY)) throw conflict();
      this.storage.setItem(LIBRARY_KEY, JSON.stringify(library));
      notifyLibrary();
      notifyVoiceLibrary();
      return library;
    });
  }
  async create({ name = 'Untitled graph', description = '', graph = defaultGraph(), kind = 'graph', id: requestedId, replacementGraph, replacementSource } = {}, revision) {
    return this.change(library => {
      if (replacementSource) {
        const source = library.graphs.find(entry => entry.id === replacementSource.id);
        if (!source || source.revision !== replacementSource.revision) throw Error('Parent graph changed while Create Subgraph was open. Cancel this dialog, load the latest saved graph if needed, then select the nodes and create the subgraph again.');
      }
      const validated = kind === 'subgraph' ? assertSubgraph(graph) : assertGraph(graph, library.graphs);
      resolveSubgraphs(validated, library.graphs);
      const stamp = now(); let id = requestedId;
      if (id !== undefined && (!validText(id) || library.graphs.some(entry => entry.id === id))) throw Error('Subgraph identity already exists. Retry Create Subgraph.');
      if (id === undefined) do { id = token(); } while (library.graphs.some(entry => entry.id === id));
      if (!validText(name) || typeof description !== 'string') throw Error('Enter a graph name and description.');
      library.graphs.push({ id, kind, name: name.trim(), description, graph: validated, revision: token(), createdAt: stamp, updatedAt: stamp });
      // Extraction must validate its replacement in the same storage transaction.
      if (replacementGraph) resolveSubgraphs(replacementGraph, library.graphs);
    }, { revision });
  }
  async save(id, revision, graph) {
    return this.change(library => {
      const entry = library.graphs.find(entry => entry.id === id);
      if (!entry || revision !== entry.revision) throw conflict();
      if (entryError(entry, library)) throw Error('This saved graph is invalid. Export its original and import a repaired copy as a new graph; the original has been kept.');
      const validated = entry.kind === 'subgraph' ? assertSubgraph(graph) : assertGraph(graph, library.graphs);
      resolveSubgraphs(validated, library.graphs);
      if (entry.kind === 'subgraph') assertSubgraphUpdate(library, id, validated);
      entry.graph = validated; delete entry.source; entry.updatedAt = now(); entry.revision = token();
    });
  }
  rename(id, name, description, revision) {
    return this.change(library => {
      const entry = library.graphs.find(entry => entry.id === id);
      if (!entry || entry.revision !== revision) throw conflict();
      if (!validText(name) || typeof description !== 'string') throw Error('Enter a graph name and description.');
      Object.assign(entry, { name: name.trim(), description, updatedAt: now(), revision: token() });
    });
  }
  async duplicate(id, revision) {
    const library = readLibrary(this.storage), entry = library.graphs.find(entry => entry.id === id);
    return this.create({ name: `${entry?.name || 'Graph'} copy`, description: entry?.description || '', graph: entryGraph(entry, library), kind: entry.kind || 'graph' }, revision ?? library.revision);
  }
  assign(target, id, revision) {
    return this.change(library => {
      if (!['live', 'webVoice'].includes(target)) throw Error('Unknown execution target.');
      if (!(target === 'webVoice' && id === null)) {
        const entry = library.graphs.find(entry => entry.id === id);
        if (entry?.kind === 'subgraph') throw Error('Choose a parent graph; reusable subgraphs cannot run directly.');
        resolvedEntryGraph(entry, library);
        if (target === 'live' && !usable(entry, library)) throw Error('Live needs a graph with an executable path.');
      }
      library.assignments[target] = id;
    }, { revision });
  }
  delete(id, revision) {
    return this.change(library => {
      if (!library.graphs.some(entry => entry.id === id)) throw Error('Graph no longer exists. Load saved details before continuing.');
      const parents = references(library, id);
      if (parents.length) throw Error(`Referenced by: ${parents.map(entry => entry.name).join(', ')}. Remove or replace those instances and save the parents before deleting this subgraph.`);
      if (library.graphs.length <= 1 || !library.graphs.some(entry => entry.id !== id && usable(entry, library))) throw Error('Keep at least one usable graph. Create or repair another graph first.');
      library.graphs = library.graphs.filter(entry => entry.id !== id);
      for (const target of ['live', 'webVoice']) if (library.assignments[target] === id) library.assignments[target] = null;
    }, { revision });
  }
  import(value, name, revision) {
    if (value?.format !== 'graph-bundle') return this.create({ name, graph: value }, revision);
    return this.change(library => {
      if (value.version !== 1 || !Array.isArray(value.graphs) || !value.graphs.length || !value.graphs.some(entry => entry.id === value.root)) throw Error('Invalid graph dependency bundle.');
      const ids = new Map();
      for (const entry of value.graphs) {
        if (!validText(entry.id) || ids.has(entry.id) || !validText(entry.name) || typeof entry.description !== 'string' || !['graph', 'subgraph'].includes(entry.kind)) throw Error('Invalid or duplicate bundled graph.');
        ids.set(entry.id, token());
      }
      const imported = value.graphs.map(entry => {
        const graph = structuredClone(entry.graph);
        if (!Array.isArray(graph?.nodes)) throw Error('Invalid bundled graph.');
        for (const node of graph.nodes) if (node.type === 'Subgraph') {
          if (!ids.has(node.subgraphId)) throw Error(`Missing bundled dependency ${node.subgraphId}. Export the parent with its dependencies.`);
          node.subgraphId = ids.get(node.subgraphId);
        }
        const stamp = now();
        return { ...entry, id: ids.get(entry.id), graph, revision: token(), createdAt: stamp, updatedAt: stamp };
      });
      // Fresh IDs on every import never overwrite definitions already in use.
      const candidate = { ...library, graphs: [...library.graphs, ...imported] };
      for (const entry of imported) { entryGraph(entry, candidate); resolvedEntryGraph(entry, candidate); }
      const root = imported.find(entry => entry.id === ids.get(value.root));
      library.graphs.push(...imported.filter(entry => entry !== root), root);
    }, { revision });
  }
  recoverLegacy(revision) {
    return this.change(library => {
      const source = this.storage.getItem(GRAPH_KEY);
      if (source === library.legacySource) return;
      if (source !== null) {
        let graph; try { graph = JSON.parse(source); } catch { graph = null; }
        const stamp = now();
        library.graphs.push({ id: token(), name: 'Recovered legacy graph', description: 'Changed by another page after migration.', graph, source, revision: token(), createdAt: stamp, updatedAt: stamp });
      }
      library.legacySource = source;
    }, { revision, recoverLegacy: true });
  }
}

// Compatibility for automation deliberately targeting the saved Live default.
// Draft editors must instead retain an ID/revision and call GraphLibrary.save.
export function readLiveGraphData(storage) { return readLiveGraph(storage).graph; }
export async function saveLiveGraphData(storage, graph, locks = globalThis.navigator?.locks) {
  const opened = await openLibrary(storage, locks);
  if (storage.getItem(LIBRARY_KEY) === null) throw Error(opened.warning);
  const context = readLiveGraph(storage);
  const library = await new GraphLibrary(storage, locks).save(context.id, context.revision, graph);
  return resolvedEntryGraph(library.graphs.find(entry => entry.id === context.id), library);
}
