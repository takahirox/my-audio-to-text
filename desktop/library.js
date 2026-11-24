import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { assertDesktopGraph, defaultDesktopGraph } from './graph.js';

export const DEFAULT_SHORTCUT = 'Control+Alt+Shift+D';

export class DesktopLibrary {
  constructor(path) {
    this.path = path;
    try {
      this.value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw Error('Desktop library could not be read. The original file was preserved.', { cause: error });
      const initial = this.entry('Japanese voice typing', defaultDesktopGraph());
      this.write({ version: 1, shortcut: DEFAULT_SHORTCUT, selected: initial.id, graphs: [initial] });
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

  entry(name, graph) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw Error('Enter a graph name of 1–120 characters.');
    return { id: randomUUID(), revision: randomUUID(), name: name.trim(), graph: assertDesktopGraph(graph) };
  }

  lookup(id = this.value.selected) {
    const entry = this.value.graphs.find(item => item.id === id);
    if (!entry) throw Error('This saved graph could not be found.');
    return entry;
  }

  add(name, graph = defaultDesktopGraph()) {
    const entry = this.entry(name, graph);
    this.write({ ...this.value, graphs: [...this.value.graphs, entry] });
    return entry;
  }

  save(id, base, graph) {
    const entry = this.lookup(id);
    if (entry.revision !== base) throw Error('This graph changed since the editor opened. Export the draft and reopen the editor.');
    const saved = { ...entry, revision: randomUUID(), graph: assertDesktopGraph(graph) };
    this.write({ ...this.value, graphs: this.value.graphs.map(item => item.id === id ? saved : item) });
    return saved;
  }

  select(id) {
    this.lookup(id);
    return this.write({ ...this.value, selected: id });
  }

  shortcut(shortcut) { this.write({ ...this.value, shortcut }); }
}
