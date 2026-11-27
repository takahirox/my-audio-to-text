import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { assertDesktopGraph, assertDesktopNodes, defaultDesktopGraph } from './graph.js';
import { assertSubgraphUpdate, importGraphBundle } from '../extension/graph-library.js';

export const DEFAULT_SHORTCUT = 'Control+Alt+Shift+D';

export class DesktopLibrary {
  constructor(path, defaultShortcut = DEFAULT_SHORTCUT) {
    this.path = path;
    try {
      this.value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('Desktop library could not be read. The original file was preserved.', { cause: error });
      const initial = this.entry('Japanese voice typing', defaultDesktopGraph());
      this.write({ version: 1, shortcut: defaultShortcut, selected: initial.id, graphs: [initial] });
    }
    if (this.value?.version !== 1 || !Array.isArray(this.value.graphs)
        || typeof this.value.shortcut !== 'string' || !this.value.graphs.some(entry => entry.id === this.value.selected)) {
      throw Error('Desktop library has an unsupported format. The original file was preserved.');
    }
  }

  write(value) {
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temp, this.path);
    this.value = value;
    return value;
  }

  entry(name, graph, kind = 'graph', definitions = this.value?.graphs || []) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw Error('Enter a graph name of 1–120 characters.');
    return { id: randomUUID(), revision: randomUUID(), name: name.trim(), kind, description: '', graph: assertDesktopGraph(graph, definitions, kind) };
  }

  lookup(id = this.value.selected) {
    const entry = this.value.graphs.find(item => item.id === id);
    if (!entry) throw Error('This saved graph could not be found.');
    return entry;
  }

  add(name, graph = defaultDesktopGraph(), kind) {
    const entry = this.entry(name, graph, kind);
    this.write({ ...this.value, graphs: [...this.value.graphs, entry] });
    return entry;
  }

  import(name, value) {
    if (value?.format !== 'graph-bundle') return this.add(name, value);
    const { root, entries } = importGraphBundle(value, this.value.graphs, assertDesktopNodes);
    this.write({ ...this.value, graphs: [...this.value.graphs, ...entries] });
    return root;
  }

  extract(parentId, revision, { id, name, graph, replacementGraph }) {
    const parent = this.lookup(parentId);
    if (parent.kind === 'subgraph' || parent.revision !== revision) throw Error('Parent graph changed. Reload it before creating a Subgraph.');
    if (typeof id !== 'string' || !id.trim() || this.value.graphs.some(entry => entry.id === id)) throw Error('Invalid or duplicate Subgraph identity.');
    const shared = { ...this.entry(name, graph, 'subgraph'), id };
    const graphs = [...this.value.graphs, shared];
    const replacement = { ...parent, revision: randomUUID(), graph: assertDesktopGraph(replacementGraph, graphs) };
    this.write({ ...this.value, graphs: graphs.map(entry => entry.id === parentId ? replacement : entry) });
    return this.value;
  }

  save(id, base, graph) {
    const entry = this.lookup(id);
    if (entry.revision !== base) throw Error('This graph changed since the editor opened. Export the draft and reopen the editor.');
    const valid = assertDesktopGraph(graph, this.value.graphs, entry.kind);
    if (entry.kind === 'subgraph') assertSubgraphUpdate(this.value, id, valid, null);
    const saved = { ...entry, revision: randomUUID(), graph: valid };
    this.write({ ...this.value, graphs: this.value.graphs.map(item => item.id === id ? saved : item) });
    return saved;
  }

  select(id) {
    if (this.lookup(id).kind === 'subgraph') throw Error('Choose a parent graph for the global shortcut.');
    return this.write({ ...this.value, selected: id });
  }

  shortcut(shortcut) { this.write({ ...this.value, shortcut }); }
}
