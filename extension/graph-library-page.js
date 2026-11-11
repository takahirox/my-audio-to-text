import { webVoiceChoices } from './web-voice-graph.js';
import { readVoiceEnabled, setVoiceEnabled, WEB_VOICE_ORIGINS, WEB_VOICE_KEY, voiceEnabled } from './web-voice-preference.js';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, entryGraph, resolvedEntryGraph, entryError, exportEntry, legacyChanged, usable } from './graph-library.js';
import { GRAPH_KEY, ASR_TYPES, nodeDefinition } from './graph.js';
import { graphModelRequirements } from './graph-model-preparation.js';
import { references } from './subgraphs.js';
import { ModelAssetCache } from './model-asset-cache.js';

const element = id => document.getElementById(id), store = new GraphLibrary(localStorage);
const selectionKey = 'graph-library-selection', draftKey = 'graph-library-details-draft';
let library, selectedId, detailsEntry, fatal = false, refreshVoiceStatus = () => {};
const states = new Map();
new MutationObserver(() => { element('details-error').textContent = element('errors').textContent; })
  .observe(element('errors'), { childList: true });
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dirty() { return detailsEntry && (element('graph-name').value !== detailsEntry.name || element('graph-description').value !== detailsEntry.description); }
function selected() { return library.graphs.find(entry => entry.id === selectedId); }
function models(entry) {
  if (entryError(entry, library)) return [];
  const graph = resolvedEntryGraph(entry, library), requirements = graphModelRequirements(graph);
  return [...new Set([...requirements.map(requirement => requirement.title.split(' · ').filter(part => !/\d[\d.]* (?:MB|GB)|allow |WebGPU|CPU WASM|terms apply|Apache/.test(part)).slice(0, 2).join(' · ')),
    ...graph.nodes.filter(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type)).map(node => (nodeDefinition(node, graph, library.graphs)?.label || node.type))])];
}
function state(entry) {
  if (entryError(entry, library)) return 'Error · needs recovery';
  return states.get(JSON.stringify(resolvedEntryGraph(entry, library))) || (models(entry).length ? 'Unknown' : 'Ready · no model files');
}
function updateDetailsState() {
  element('details-state').textContent = dirty() ? 'Unsaved changes' : '';
}
function keepDraft() {
  updateDetailsState();
  try {
    if (dirty()) sessionStorage.setItem(draftKey, JSON.stringify({ entry: detailsEntry, name: element('graph-name').value, description: element('graph-description').value }));
    else sessionStorage.removeItem(draftKey);
  } catch { element('details-state').textContent = 'Unsaved changes · refresh recovery unavailable; save before leaving.'; }
}
function clearDraft() { try { sessionStorage.removeItem(draftKey); } catch {} }
function focusDetails() {
  const title = element('selected-title');
  title.focus();
  if (matchMedia('(max-width: 900px)').matches) title.scrollIntoView({ block: 'start' });
}
function select(id, { focus = matchMedia('(max-width: 900px)').matches } = {}) {
  if (id !== selectedId && dirty() && !confirm('Discard unsaved graph name or description changes?')) return false;
  if (id !== selectedId) { clearDraft(); selectedId = id; render(true); }
  else render();
  try { localStorage.setItem(selectionKey, id); } catch { /* Selection is optional; graph writes report their own errors. */ }
  if (focus) focusDetails();
  return true;
}
function renderDetails(entry = selected()) {
  element('selected').hidden = !entry;
  if (!entry) { detailsEntry = null; return; }
  detailsEntry = structuredClone(entry);
  element('selected-title').textContent = entry.name;
  element('graph-name').value = entry.name; element('graph-description').value = entry.description;
  element('graph-more').open = false;
  element('graph-metadata').open = false;
  updateDetailsState();
  preview(entryError(entry, library) ? null : entryGraph(entry, library));
}
function renderSelectedState() {
  const current = selected(), entry = current || detailsEntry;
  if (!entry) return;
  const invalid = entryError(entry, library), removed = !current;
  element('open').hidden = removed;
  element('open').href = `graph-editor.html?id=${encodeURIComponent(entry.id)}`;
  element('selected-error').textContent = removed ? 'This graph was deleted in another page. Unsaved details have been kept; copy them before selecting another graph. Export JSON still recovers the previous saved graph.'
    : invalid ? `Invalid saved graph: ${invalid} Export the original JSON, repair it, and import as new. The original is kept.` : '';
  element('duplicate').disabled = !!invalid || removed;
  element('check-cache').disabled = !!invalid || removed || state(entry) === 'Unknown · checking';
  element('cache-hint').textContent = removed ? 'This graph was deleted.' : invalid ? 'Repair and import this graph before checking model files.' : '';
  element('save-details').disabled = removed;
  const parents = references(library, entry.id);
  const last = !library.graphs.some(other => other.id !== entry.id && usable(other, library));
  element('delete').disabled = removed || last || parents.length > 0;
  element('delete-hint').textContent = removed ? 'This graph was deleted.' : parents.length ? `Referenced by: ${parents.map(parent => parent.name).join(', ')}. Replace or remove instances and save those graphs before deleting.` : last ? 'Keep at least one usable graph.' : '';
  element('graph-updated').textContent = new Date(entry.updatedAt).toLocaleString();
  element('graph-models').textContent = invalid ? 'Unknown · repair graph first' : models(entry).join(', ') || 'None';
  element('graph-cache').textContent = state(entry);
}
function preview(graph) {
  const root = element('preview'); root.replaceChildren();
  root.setAttribute('aria-label', graph ? `Graph preview: ${graph.nodes.length} nodes, ${graph.edges.length} connections. ${graph.nodes.map(node => `${node.id}: ${(nodeDefinition(node, graph, library.graphs)?.label || node.type)}`).join('; ')}` : 'No preview available; repair this saved graph.');
  if (!graph?.nodes.length) { root.setAttribute('viewBox', '0 0 300 100'); root.style.width = '100%'; root.style.height = '160px'; return; }
  const svg = (tag, attributes) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    return node;
  };
  const positions = new Map(graph.nodes.map((node, index) => [node.id, node.position || { x: index * 210, y: 0 }]));
  const xs = [...positions.values()].map(p => p.x), ys = [...positions.values()].map(p => p.y);
  root.style.width = `${Math.max(300, Math.max(...xs) - Math.min(...xs) + 200)}px`;
  root.style.height = `${Math.max(160, Math.max(...ys) - Math.min(...ys) + 70)}px`;
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
    const type = svg('text', { x: p.x + 8, y: p.y + 38 }); type.textContent = (nodeDefinition(node, graph, library.graphs)?.label || node.type);
    group.append(name, type); root.append(group);
  }
}
function render(replaceDetails = false) {
  if (!selected() && (!dirty() || replaceDetails)) selectedId = library.graphs[0].id;
  const search = element('search').value.toLocaleLowerCase(), filter = element('filter').value;
  const rows = library.graphs.filter(entry => `${entry.name} ${entry.description} ${models(entry).join(' ')}`.toLocaleLowerCase().includes(search)
    && (filter === 'all' || filter === 'subgraph' && entry.kind === 'subgraph' || filter === 'graph' && entry.kind !== 'subgraph' || filter === 'invalid' && entryError(entry, library)));
  rows.sort(element('sort').value === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  const focusedRow = document.activeElement?.closest('#graph-list li');
  const focusedId = focusedRow?.dataset.id;
  const focusedMenu = document.activeElement?.tagName === 'SUMMARY';
  element('graph-list').replaceChildren(...rows.map(entry => {
    const row = el('li'), button = el('button'); row.dataset.id = entry.id; button.dataset.id = entry.id;
    button.onclick = () => select(entry.id);
    button.setAttribute('aria-label', `Open details for ${entry.name}`); button.setAttribute('aria-controls', 'selected'); button.setAttribute('aria-pressed', String(entry.id === selectedId));
    row.classList.toggle('selected', entry.id === selectedId);
    const name = el('span', `${entry.name}${entry.kind === 'subgraph' ? ' · Subgraph' : ''}`); name.className = 'graph-row-name'; button.append(name);
    if (entry.description) {
      const description = el('span', entry.description); description.className = 'graph-row-description';
      description.id = `description-${entry.id}`; button.setAttribute('aria-describedby', description.id); button.append(description);
    }
    const hint = el('span', 'View details →'); hint.className = 'graph-row-hint'; hint.setAttribute('aria-hidden', 'true'); button.append(hint);
    const menu = el('details'), summary = el('summary', '⋯'), commands = el('div');
    menu.className = 'row-menu'; summary.setAttribute('aria-label', `Actions for ${entry.name}`); summary.title = `Actions for ${entry.name}`;
    commands.className = 'row-commands';
    for (const [label, command] of [['Graph details', null], ['Edit graph', 'open'], ['Duplicate', 'duplicate'], ['Export JSON', 'export']]) {
      const actionButton = el('button', label);
      actionButton.onclick = () => {
        menu.open = false;
        if (!select(entry.id, { focus: !command })) { summary.focus(); return; }
        if (command) {
          element(command).click();
          [...element('graph-list').children].find(row => row.dataset.id === entry.id)?.querySelector('summary').focus({ preventScroll: true });
        }
      };
      actionButton.disabled = ['open', 'duplicate'].includes(command) && !!entryError(entry, library);
      commands.append(actionButton);
    }
    menu.append(summary, commands);
    menu.addEventListener('toggle', () => {
      if (menu.open) for (const other of element('graph-list').querySelectorAll('.row-menu[open]')) if (other !== menu) other.open = false;
    });
    row.append(button, menu); return row;
  }));
  if (focusedId) {
    const row = [...element('graph-list').children].find(row => row.dataset.id === focusedId);
    row?.querySelector(focusedMenu ? 'summary' : 'button[data-id]')?.focus({ preventScroll: true });
  }
  element('graph-count').textContent = rows.length;
  element('empty').hidden = !!rows.length;
  if (replaceDetails || !dirty() && (detailsEntry?.id !== selectedId || detailsEntry?.revision !== selected()?.revision)) renderDetails();
  renderSelectedState();
  refreshVoiceStatus();
  const changed = legacyChanged(localStorage, library);
  element('recovery').hidden = !changed;
  element('recover-legacy').hidden = !changed;
  element('recovery-message').textContent = changed ? 'The legacy graph changed after migration. Keep it as a separate entry before further edits. Both versions are preserved; no assignment will change.' : '';
}
async function action(work, { selectNew = false, savedDetails = false, onError } = {}) {
  const controls = [...document.querySelectorAll('#new, main button, main input, main select, main textarea')].map(node => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  const restore = () => { for (const [node, disabled] of controls) node.disabled = disabled; };
  try {
    const next = await work();
    restore(); library = next;
    if (selectNew || savedDetails) clearDraft();
    if (selectNew) { selectedId = next.graphs.at(-1).id; try { localStorage.setItem(selectionKey, selectedId); } catch {} }
    element('errors').textContent = ''; render(selectNew || savedDetails);
    if (selectNew) focusDetails();
    return true;
  } catch (error) {
    restore();
    if (onError) onError(error);
    else element('errors').textContent = `${error.message} Nothing was overwritten. Reload or Load saved details to review current data.`;
    return false;
  }
}
element('export-storage').onclick = () => download(localStorage.getItem(LIBRARY_KEY) ?? 'null', 'graph-library-original.json');
element('export-legacy').onclick = () => download(localStorage.getItem(GRAPH_KEY) ?? 'null', 'legacy-graph-original.json');
try {
  const opened = await openLibrary(localStorage); library = opened.library;
  element('library-warning').textContent = opened.warning;
  selectedId = localStorage.getItem(selectionKey);
  if (!library.graphs.some(entry => entry.id === selectedId)) selectedId = library.graphs[0].id;
  render(true);
  // Per-tab drafts survive refresh without changing library data or revisions.
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (draft?.entry?.id && draft.entry.revision && typeof draft.entry.name === 'string' && typeof draft.entry.description === 'string' && typeof draft.name === 'string' && typeof draft.description === 'string') {
      selectedId = draft.entry.id; renderDetails(draft.entry);
      element('graph-name').value = draft.name; element('graph-description').value = draft.description;
      updateDetailsState(); render(); focusDetails();
    }
  } catch { element('errors').textContent = 'Could not restore unsaved details. Saved graphs are unchanged.'; }
} catch (error) {
  fatal = true; element('errors').textContent = error.message;
  element('recovery').hidden = false; element('recover-legacy').hidden = true;
  element('recovery-message').textContent = 'Original storage is available for export. No saved data has been overwritten.';
  for (const node of document.querySelectorAll('#new, main button, main input, main select')) node.disabled = !['export-storage', 'export-legacy', 'web-voice-enabled', 'confirm-voice', 'cancel-voice'].includes(node.id);
  element('selected').hidden = true;
}
// Consent remains revocable even if graph storage needs recovery.
{
  const toggle = element('web-voice-enabled'), status = element('web-voice-status'), consent = element('voice-consent');
  let voiceMessage = '', hasWebsiteAccess = true;
  refreshVoiceStatus = () => {
    element('voice-switch-state').textContent = toggle.checked ? 'ON' : 'OFF';
    const count = library ? webVoiceChoices(library).length : null;
    status.textContent = voiceMessage || (count === 0 ? 'No compatible graphs. Connect MicrophoneAudio through final text processing to FocusedInputTextOutputNode in Graph Editor.' : toggle.checked ? hasWebsiteAccess ? 'ON · click a field mic to start; right-click it to choose a default graph.' : 'Website access missing. Turn OFF, then ON to grant access.' : 'OFF · website microphone controls are disabled.');
  };
  toggle.checked = await readVoiceEnabled();
  const checkWebsiteAccess = async () => {
    hasWebsiteAccess = await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS }); refreshVoiceStatus();
  };
  await checkWebsiteAccess();
  async function changeVoice(enabled, permission) {
    toggle.disabled = true; voiceMessage = '';
    try {
      if (enabled) {
        if (!await permission) throw Error('Website access denied. Microphone buttons remain OFF. Turn ON again to request access.');
        hasWebsiteAccess = true;
      }
      await setVoiceEnabled(enabled); toggle.checked = enabled;
      const reply = await chrome.runtime.sendMessage({ type: 'web-voice-reconcile' });
      if (reply?.error) throw Error(reply.error);
    } catch (error) {
      voiceMessage = error.message; toggle.checked = false;
      try { await setVoiceEnabled(false); } catch (saveError) { voiceMessage += ` ${saveError.message}`; }
    } finally { toggle.disabled = false; refreshVoiceStatus(); toggle.focus(); }
  }
  toggle.onchange = () => {
    voiceMessage = '';
    if (!toggle.checked) { void changeVoice(false); return; }
    toggle.checked = false;
    refreshVoiceStatus(); consent.showModal();
  };
  element('confirm-voice').onclick = () => {
    // Stay in this explicit user gesture for Chrome's native permission flow.
    let permission;
    try { permission = chrome.permissions.request({ origins: WEB_VOICE_ORIGINS }); }
    catch (error) { permission = Promise.reject(error); }
    consent.close(); void changeVoice(true, permission);
  };
  element('cancel-voice').onclick = () => consent.close();
  consent.addEventListener('close', () => toggle.focus());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[WEB_VOICE_KEY]) {
      toggle.checked = voiceEnabled(changes[WEB_VOICE_KEY].newValue); refreshVoiceStatus();
    }
  });
  chrome.permissions.onRemoved.addListener(() => { void checkWebsiteAccess(); });
  chrome.permissions.onAdded.addListener(() => { void checkWebsiteAccess(); });
  refreshVoiceStatus(); toggle.disabled = false;
}
if (!fatal) {
  element('graph-list').onkeydown = event => {
    const buttons = [...element('graph-list').querySelectorAll('button[data-id]')], index = buttons.indexOf(event.target);
    if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  };
  const more = element('graph-more');
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = event.target.closest('.row-menu[open], #graph-more[open]');
    if (menu) { event.preventDefault(); menu.open = false; menu.querySelector('summary').focus(); }
  });
  document.addEventListener('click', event => {
    if (!more.contains(event.target)) more.open = false;
    for (const menu of element('graph-list').querySelectorAll('.row-menu[open]')) if (!menu.contains(event.target)) menu.open = false;
  });
  more.addEventListener('click', event => {
    if (event.target.closest('button')) { more.open = false; more.querySelector('summary').focus(); }
  });
  for (const id of ['graph-name', 'graph-description']) element(id).addEventListener('input', keepDraft);
  for (const id of ['search', 'sort', 'filter']) element(id).addEventListener(id === 'search' ? 'input' : 'change', () => render());
  element('new').onclick = () => { if (!dirty() || confirm('Discard unsaved graph details?')) void action(() => store.create({}, library.revision), { selectNew: true }); };
  element('import').onclick = () => element('import-file').click();
  element('import-file').onchange = async () => {
    const file = element('import-file').files?.[0]; if (!file) return;
    try {
      const graph = JSON.parse(await file.text());
      if (!dirty() || confirm('Discard unsaved graph details?')) await action(() => store.import(graph, file.name.replace(/\.json$/i, '') || 'Imported graph', library.revision), { selectNew: true });
    } catch (error) { element('errors').textContent = `Cannot import graph: ${error.message}. Existing graphs have been kept.`; }
    finally { element('import-file').value = ''; }
  };
  element('details-form').onsubmit = event => {
    event.preventDefault();
    if (!selected()) return;
    void action(() => store.rename(selectedId, element('graph-name').value, element('graph-description').value, detailsEntry.revision), { savedDetails: true });
  };
  element('load-details').onclick = () => {
    if (dirty() && !confirm('Discard unsaved graph details and load saved details?')) return;
    try { library = readLibrary(localStorage); clearDraft(); render(true); element('errors').textContent = ''; } catch (error) { element('errors').textContent = error.message; }
  };
  element('duplicate').onclick = () => { if (!dirty() || confirm('Discard unsaved graph details?')) void action(() => store.duplicate(selectedId, library.revision), { selectNew: true }); };
  element('export').onclick = () => {
    const entry = selected() || detailsEntry;
    download(exportEntry(entry, library), `${entry.name.replace(/[^\p{L}\p{N} _-]/gu, '_')}.json`);
  };
  element('delete').onclick = () => {
    const entry = selected(); if (!entry) return;
    if (confirm(`Delete “${entry.name}”? This cannot be undone.${dirty() ? ' Unsaved details will also be discarded.' : ''}`)) void action(() => store.delete(selectedId, library.revision)).then(success => {
      if (success) { clearDraft(); selectedId = library.graphs[0].id; render(true); focusDetails(); }
    });
  };
  element('recover-legacy').onclick = () => { void action(() => store.recoverLegacy(library.revision)); };
  element('check-cache').onclick = async () => {
    const entry = selected(); if (!entry) return;
    const key = JSON.stringify(resolvedEntryGraph(entry, library));
    element('graph-metadata').open = true;
    element('check-cache').disabled = true;
    states.set(key, 'Unknown · checking'); render();
    try {
      const requirements = graphModelRequirements(resolvedEntryGraph(entry, library));
      const views = await Promise.all(requirements.map(async requirement => new ModelAssetCache(await requirement.manifest()).inspect()));
      const packaged = resolvedEntryGraph(entry, library).nodes.some(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type));
      states.set(key, views.some(view => view.state === 'Error') ? 'Error · open Models' : views.some(view => view.state !== 'Ready') ? 'Needs preparation' : packaged ? 'Unknown · packaged models checked by Live' : 'Ready · cached files');
    } catch (error) { states.set(key, 'Error · open Models'); element('errors').textContent = error.message; }
    finally { render(); }
  };
  window.addEventListener('storage', event => {
    if (![LIBRARY_KEY, GRAPH_KEY, null].includes(event.key)) return;
    try {
      library = readLibrary(localStorage);
      void chrome.runtime.sendMessage({ type: 'web-voice-library-changed' }).catch(() => {});
      if (dirty()) element('errors').textContent = 'Library changed in another page. Unsaved details have been kept; Load saved details before saving if this graph changed.';
      render();
    } catch (error) { element('errors').textContent = `${error.message} Your changes have been kept.`; }
  });
  const cacheUpdates = new BroadcastChannel('model-cache-updates');
  const invalidateCache = () => { states.clear(); render(); };
  cacheUpdates.onmessage = invalidateCache;
  window.addEventListener('focus', invalidateCache);
  window.addEventListener('pagehide', () => cacheUpdates.close());
  window.addEventListener('beforeunload', event => { keepDraft(); if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
}
