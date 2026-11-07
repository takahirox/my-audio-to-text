import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, entryGraph, entryError, exportEntry, legacyChanged, usable } from './graph-library.js';
import { GRAPH_KEY, NODE_TYPES, ASR_TYPES } from './graph.js';
import { graphModelRequirements } from './graph-model-preparation.js';
import { ModelAssetCache } from './model-asset-cache.js';

const element = id => document.getElementById(id), store = new GraphLibrary(localStorage);
const selectionKey = 'graph-library-selection';
let library, selectedId, detailsEntry, fatal = false;
const states = new Map();
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dirty() { return detailsEntry && (element('graph-name').value !== detailsEntry.name || element('graph-description').value !== detailsEntry.description); }
function selected() { return library.graphs.find(entry => entry.id === selectedId); }
function models(entry) {
  if (entryError(entry)) return [];
  const graph = entryGraph(entry), requirements = graphModelRequirements(graph);
  return [...new Set([...requirements.map(requirement => requirement.title.split(' · ').filter(part => !/\d[\d.]* (?:MB|GB)|allow |WebGPU|CPU WASM|terms apply|Apache/.test(part)).slice(0, 2).join(' · ')),
    ...graph.nodes.filter(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type)).map(node => NODE_TYPES[node.type].label)])];
}
function state(entry) {
  if (entryError(entry)) return 'Error · needs recovery';
  return states.get(JSON.stringify(entry.graph)) || (models(entry).length ? 'Unknown' : 'Ready · no model files');
}
function select(id) {
  if (id !== selectedId && dirty() && !confirm('Discard unsaved graph name or description changes?')) return;
  selectedId = id;
  try { localStorage.setItem(selectionKey, id); } catch { /* Selection is optional; graph writes report their own errors. */ }
  render(true);
}
function renderDetails() {
  const entry = selected();
  element('selected').hidden = !entry;
  if (!entry) { detailsEntry = null; return; }
  detailsEntry = structuredClone(entry);
  element('open').hidden = false;
  element('selected-title').textContent = `Selected graph: ${entry.name}`;
  element('graph-name').value = entry.name; element('graph-description').value = entry.description;
  element('open').href = `graph-editor.html?id=${encodeURIComponent(entry.id)}`;
  element('editor-link').href = element('open').href;
  const invalid = entryError(entry);
  element('selected-error').textContent = invalid ? `Invalid saved graph: ${invalid} Export the original JSON, repair it, and import as new. The original is kept.` : '';
  element('duplicate').disabled = element('check-cache').disabled = !!invalid;
  const assigned = Object.values(library.assignments).includes(entry.id);
  const last = !library.graphs.some(other => other.id !== entry.id && usable(other));
  element('delete').disabled = assigned || last;
  element('delete-hint').textContent = assigned ? 'Reassign execution targets before deleting this graph.' : last ? 'Keep at least one usable graph.' : '';
  preview(invalid ? null : entryGraph(entry));
}
function preview(graph) {
  const root = element('preview'); root.replaceChildren();
  if (!graph?.nodes.length) { root.setAttribute('viewBox', '0 0 300 100'); return; }
  const svg = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const positions = new Map(graph.nodes.map((node, index) => [node.id, node.position || { x: index * 210, y: 0 }]));
  const xs = [...positions.values()].map(p => p.x), ys = [...positions.values()].map(p => p.y);
  root.setAttribute('viewBox', `${Math.min(...xs) - 10} ${Math.min(...ys) - 10} ${Math.max(...xs) - Math.min(...xs) + 200} ${Math.max(...ys) - Math.min(...ys) + 70}`);
  for (const edge of graph.edges) {
    const from = positions.get(edge.from[0]), to = positions.get(edge.to[0]);
    const line = svg('line', { x1: from.x + 90, y1: from.y + 25, x2: to.x + 90, y2: to.y + 25 });
    line.append(el('title', `${edge.from.join('.')} → ${edge.to.join('.')}`)); root.append(line);
  }
  for (const node of graph.nodes) {
    const p = positions.get(node.id), group = svg('g', {});
    group.append(svg('rect', { x: p.x, y: p.y, width: 180, height: 50, rx: 6 }));
    const name = svg('text', { x: p.x + 8, y: p.y + 19 }); name.textContent = node.id;
    const type = svg('text', { x: p.x + 8, y: p.y + 38 }); type.textContent = NODE_TYPES[node.type].label;
    group.append(name, type); root.append(group);
  }
}
function render(replaceDetails = false) {
  const search = element('search').value.toLocaleLowerCase(), filter = element('filter').value;
  const rows = library.graphs.filter(entry => `${entry.name} ${entry.description} ${models(entry).join(' ')}`.toLocaleLowerCase().includes(search)
    && (filter === 'all' || filter === 'assigned' && Object.values(library.assignments).includes(entry.id) || filter === 'invalid' && entryError(entry)));
  rows.sort(element('sort').value === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  element('graph-list').replaceChildren(...rows.map(entry => {
    const row = el('div'); row.className = 'library-row'; row.setAttribute('role', 'row'); row.setAttribute('aria-selected', entry.id === selectedId);
    row.onclick = event => { if (!event.target.closest('button')) select(entry.id); };
    const cell = el('span'); cell.setAttribute('role', 'cell');
    const button = el('button', entry.name); button.onclick = () => select(entry.id); button.setAttribute('aria-label', `Select ${entry.name}`); button.setAttribute('aria-pressed', entry.id === selectedId); cell.append(button); row.append(cell);
    for (const [label, value] of [['Purpose', entry.description || '—'], ['Updated', new Date(entry.updatedAt).toLocaleString()], ['Required models', entryError(entry) ? 'Unknown' : models(entry).join(', ') || 'None'], ['File cache', state(entry)]]) {
      const cell = el('span', value); cell.dataset.label = label; cell.setAttribute('role', 'cell'); row.append(cell);
    }
    return row;
  }));
  element('empty').hidden = !!rows.length;
  for (const [target, id] of [['live', 'live-target'], ['webVoice', 'web-target']]) {
    const select = element(id); select.replaceChildren();
    if (target === 'webVoice') { const option = el('option', 'Not assigned'); option.value = ''; select.append(option); }
    for (const entry of library.graphs) {
      const option = el('option', entry.name + (entryError(entry) ? ' (needs recovery)' : '')); option.value = entry.id;
      option.disabled = !!entryError(entry) || target === 'live' && !usable(entry); select.append(option);
    }
    select.value = library.assignments[target] || '';
  }
  if (replaceDetails || !dirty()) renderDetails();
  else if (!selected()) {
    element('selected-error').textContent = 'This graph was deleted in another page. Unsaved details have been kept; copy them before selecting another graph. Export JSON still recovers the previous saved graph.';
    element('open').hidden = true;
    for (const id of ['duplicate', 'delete', 'check-cache']) element(id).disabled = true;
  }
  const changed = legacyChanged(localStorage, library);
  element('recovery').hidden = !changed;
  element('recover-legacy').hidden = !changed;
  element('recovery-message').textContent = changed ? 'The legacy graph changed after migration. Keep it as a separate entry before further edits. Both versions are preserved; no assignment will change.' : '';
}
async function action(work, { selectNew = false } = {}) {
  const controls = [...document.querySelectorAll('main button, main input, main select, main textarea')].map(node => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  const restore = () => { for (const [node, disabled] of controls) node.disabled = disabled; };
  try {
    const next = await work();
    restore(); library = next;
    if (selectNew) { selectedId = next.graphs.at(-1).id; try { localStorage.setItem(selectionKey, selectedId); } catch {} }
    element('errors').textContent = ''; render(selectNew);
  } catch (error) { restore(); element('errors').textContent = `${error.message} Nothing was overwritten. Reload or Load saved details to review current data.`; }
}
element('export-storage').onclick = () => download(localStorage.getItem(LIBRARY_KEY) ?? 'null', 'graph-library-original.json');
element('export-legacy').onclick = () => download(localStorage.getItem(GRAPH_KEY) ?? 'null', 'legacy-graph-original.json');
try {
  const opened = await openLibrary(localStorage); library = opened.library;
  element('library-warning').textContent = opened.warning;
  selectedId = localStorage.getItem(selectionKey);
  if (!library.graphs.some(entry => entry.id === selectedId)) selectedId = library.assignments.live;
  render(true);
} catch (error) {
  fatal = true; element('errors').textContent = error.message;
  element('recovery').hidden = false; element('recover-legacy').hidden = true;
  element('recovery-message').textContent = 'Original storage is available for export. No saved data has been overwritten.';
  for (const node of document.querySelectorAll('main button, main input, main select')) node.disabled = !['export-storage', 'export-legacy'].includes(node.id);
  element('selected').hidden = true;
}
if (!fatal) {
  for (const id of ['search', 'sort', 'filter']) element(id).addEventListener(id === 'search' ? 'input' : 'change', () => render());
  element('new').onclick = () => { if (!dirty() || confirm('Discard unsaved graph details?')) void action(() => store.create({}, library.revision), { selectNew: true }); };
  element('import').onclick = () => element('import-file').click();
  element('import-file').onchange = async () => {
    const file = element('import-file').files?.[0]; if (!file) return;
    try {
      const graph = JSON.parse(await file.text());
      if (!dirty() || confirm('Discard unsaved graph details?')) await action(() => store.create({ name: file.name.replace(/\.json$/i, '') || 'Imported graph', graph }, library.revision), { selectNew: true });
    } catch (error) { element('errors').textContent = `Cannot import graph: ${error.message}. Existing graphs have been kept.`; }
    finally { element('import-file').value = ''; }
  };
  element('details-form').onsubmit = event => { event.preventDefault(); void action(() => store.rename(selectedId, element('graph-name').value, element('graph-description').value, detailsEntry.revision)).then(() => {
    if (selected()?.name === element('graph-name').value && selected()?.description === element('graph-description').value) render(true);
  }); };
  element('load-details').onclick = () => {
    if (dirty() && !confirm('Discard unsaved graph details and load saved details?')) return;
    try { library = readLibrary(localStorage); render(true); element('errors').textContent = ''; } catch (error) { element('errors').textContent = error.message; }
  };
  element('duplicate').onclick = () => { if (!dirty() || confirm('Discard unsaved graph details?')) void action(() => store.duplicate(selectedId, library.revision), { selectNew: true }); };
  element('export').onclick = () => {
    const entry = selected() || detailsEntry;
    download(exportEntry(entry), `${entry.name.replace(/[^\p{L}\p{N} _-]/gu, '_')}.json`);
  };
  element('delete').onclick = () => {
    const entry = selected(); if (!entry) return;
    if (confirm(`Delete “${entry.name}”? This cannot be undone.`)) void action(() => store.delete(selectedId, library.revision)).then(() => {
      if (!selected()) { selectedId = library.assignments.live; render(true); }
    });
  };
  for (const [target, id] of [['live', 'live-target'], ['webVoice', 'web-target']]) element(id).onchange = () => { void action(() => store.assign(target, element(id).value || null, library.revision)).then(() => render()); };
  element('recover-legacy').onclick = () => { void action(() => store.recoverLegacy(library.revision)); };
  element('check-cache').onclick = async () => {
    const entry = selected(); if (!entry) return;
    const key = JSON.stringify(entry.graph);
    element('check-cache').disabled = true;
    states.set(key, 'Unknown · checking'); render();
    try {
      const requirements = graphModelRequirements(entryGraph(entry));
      const views = await Promise.all(requirements.map(async requirement => new ModelAssetCache(await requirement.manifest()).inspect()));
      const packaged = entryGraph(entry).nodes.some(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type));
      states.set(key, views.some(view => view.state === 'Error') ? 'Error · open Models' : views.some(view => view.state !== 'Ready') ? 'Needs preparation' : packaged ? 'Unknown · packaged models checked by Live' : 'Ready · cached files');
    } catch (error) { states.set(key, 'Error · open Models'); element('errors').textContent = error.message; }
    finally { render(); element('check-cache').disabled = !!entryError(selected()); }
  };
  window.addEventListener('storage', event => {
    if (![LIBRARY_KEY, GRAPH_KEY, null].includes(event.key)) return;
    try {
      library = readLibrary(localStorage);
      if (dirty()) element('errors').textContent = 'Library changed in another page. Unsaved details have been kept; Load saved details before saving if this graph changed.';
      render();
    } catch (error) { element('errors').textContent = `${error.message} Your changes have been kept.`; }
  });
  const cacheUpdates = new BroadcastChannel('model-cache-updates');
  const invalidateCache = () => { states.clear(); render(); };
  cacheUpdates.onmessage = invalidateCache;
  window.addEventListener('focus', invalidateCache);
  window.addEventListener('pagehide', () => cacheUpdates.close());
  window.addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
}
