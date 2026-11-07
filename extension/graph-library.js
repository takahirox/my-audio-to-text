import { assertGraph, defaultGraph, GRAPH_KEY, executableGraph } from './graph.js';

export const LIBRARY_KEY = 'processing-graph-library-v1';
export const LIBRARY_LOCK = 'processing-graph-save';
const conflict = () => Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
const token = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const validText = value => typeof value === 'string' && value.trim().length > 0;

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
      || !Object.hasOwn(entry, 'graph') || (entry.source !== undefined && typeof entry.source !== 'string')) throw Error('Invalid graph library entry or duplicate graph ID. Original storage has been kept.');
    ids.add(entry.id);
  }
  if (!ids.has(value.assignments.live) || !(value.assignments.webVoice === null || ids.has(value.assignments.webVoice))) throw Error('Invalid execution target assignment. Original storage has been kept.');
  return value;
}
export function entryGraph(entry) {
  if (!entry) throw Error('Graph no longer exists. Return to Graph Library; your draft has been kept.');
  return assertGraph(entry.graph);
}
export function entryError(entry) {
  try { entryGraph(entry); return ''; } catch (error) { return error.message; }
}
export function usable(entry) {
  try { return executableGraph(entryGraph(entry)).nodes.length > 0; } catch { return false; }
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
      if (storage.getItem(LIBRARY_KEY) === null) storage.setItem(LIBRARY_KEY, JSON.stringify(library));
      return { library, warning: legacyChanged(storage, library) ? 'The legacy graph changed in another page. Recover it in Graph Library before saving.' : '' };
    });
  } catch (error) {
    // One deterministic read-only fallback; never retry writes or erase a source.
    return { library: readLibrary(storage), warning: `Library could not be committed: ${error.message} Read-only fallback; reload after restoring storage to save changes.` };
  }
}
export function readLiveGraph(storage) {
  const library = readLibrary(storage);
  if (legacyChanged(storage, library)) throw Error('The legacy graph changed in another page. Recover it in Graph Library before continuing.');
  const entry = library.graphs.find(entry => entry.id === library.assignments.live);
  return { id: entry.id, name: entry.name, graph: entryGraph(entry), revision: entry.revision };
}
export function exportEntry(entry) {
  // Invalid sources are exported byte-for-byte, including malformed legacy JSON.
  if (entryError(entry)) return entry.source ?? JSON.stringify(entry.graph, null, 2);
  return JSON.stringify(entryGraph(entry), null, 2) + '\n';
}
export class GraphLibrary {
  constructor(storage, locks = globalThis.navigator?.locks) { this.storage = storage; this.locks = locks; }
  async change(action, { revision, recoverLegacy = false } = {}) {
    return exclusive(this.locks, () => {
      const before = this.storage.getItem(LIBRARY_KEY), library = readLibrary(this.storage);
      if (revision !== undefined && revision !== library.revision) throw conflict();
      if (!recoverLegacy && legacyChanged(this.storage, library)) throw Error('Legacy graph changed. Recover it as a new graph in Graph Library first. Your draft has been kept.');
      action(library);
      library.revision = token(); validateLibrary(library);
      if (before !== this.storage.getItem(LIBRARY_KEY)) throw conflict();
      this.storage.setItem(LIBRARY_KEY, JSON.stringify(library));
      return library;
    });
  }
  async create({ name = 'Untitled graph', description = '', graph = defaultGraph() } = {}, revision) {
    const validated = assertGraph(graph); // Validate before acquiring storage; rejected imports write nothing.
    return this.change(library => {
      const stamp = now(); let id;
      do { id = token(); } while (library.graphs.some(entry => entry.id === id));
      if (!validText(name) || typeof description !== 'string') throw Error('Enter a graph name and description.');
      library.graphs.push({ id, name: name.trim(), description, graph: validated, revision: token(), createdAt: stamp, updatedAt: stamp });
    }, { revision });
  }
  async save(id, revision, graph) {
    const validated = assertGraph(graph);
    return this.change(library => {
      const entry = library.graphs.find(entry => entry.id === id);
      if (!entry || revision !== entry.revision) throw conflict();
      if (entryError(entry)) throw Error('This saved graph is invalid. Export its original and import a repaired copy as a new graph; the original has been kept.');
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
    return this.create({ name: `${entry?.name || 'Graph'} copy`, description: entry?.description || '', graph: entryGraph(entry) }, revision ?? library.revision);
  }
  assign(target, id, revision) {
    return this.change(library => {
      if (!['live', 'webVoice'].includes(target)) throw Error('Unknown execution target.');
      if (!(target === 'webVoice' && id === null)) {
        const entry = library.graphs.find(entry => entry.id === id);
        entryGraph(entry);
        if (target === 'live' && !usable(entry)) throw Error('Live needs a graph with an executable path.');
      }
      library.assignments[target] = id;
    }, { revision });
  }
  delete(id, revision) {
    return this.change(library => {
      if (!library.graphs.some(entry => entry.id === id)) throw Error('Graph no longer exists. Load saved details before continuing.');
      if (Object.values(library.assignments).includes(id)) throw Error('Reassign execution targets before deleting this graph.');
      if (library.graphs.length <= 1 || !library.graphs.some(entry => entry.id !== id && usable(entry))) throw Error('Keep at least one usable graph. Create or repair another graph first.');
      library.graphs = library.graphs.filter(entry => entry.id !== id);
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
  return entryGraph(library.graphs.find(entry => entry.id === context.id));
}
