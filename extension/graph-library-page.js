import { webVoiceError } from './web-voice-graph.js';
import { readVoiceEnabled, setVoiceEnabled, WEB_VOICE_ORIGINS, WEB_VOICE_KEY, voiceEnabled } from './web-voice-preference.js';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, entryGraph, entryError, exportEntry, legacyChanged, usable } from './graph-library.js';
import { GRAPH_KEY, NODE_TYPES, ASR_TYPES } from './graph.js';
import { graphModelRequirements } from './graph-model-preparation.js';
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
  if (entryError(entry)) return [];
  const graph = entryGraph(entry), requirements = graphModelRequirements(graph);
  return [...new Set([...requirements.map(requirement => requirement.title.split(' · ').filter(part => !/\d[\d.]* (?:MB|GB)|allow |WebGPU|CPU WASM|terms apply|Apache/.test(part)).slice(0, 2).join(' · ')),
    ...graph.nodes.filter(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type)).map(node => NODE_TYPES[node.type].label)])];
}
function state(entry) {
  if (entryError(entry)) return 'Error · needs recovery';
  return states.get(JSON.stringify(entry.graph)) || (models(entry).length ? 'Unknown' : 'Ready · no model files');
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
let detailInvoker;
function showDetails(invoker = document.activeElement) {
  const dialog = element('selected');
  if (!dialog.open) {
    detailInvoker = !invoker || invoker === document.body ? { id: selectedId, menu: false } : invoker;
    dialog.showModal();
  }
  element('selected-title').focus();
}
function select(id, invoker) {
  if (id !== selectedId && dirty() && !confirm('Discard unsaved graph name or description changes?')) return false;
  if (id !== selectedId) { clearDraft(); selectedId = id; render(true); }
  else render();
  try { localStorage.setItem(selectionKey, id); } catch { /* Selection is optional; graph writes report their own errors. */ }
  showDetails(invoker);
  return true;
}
function closeDetails() {
  // Closing preserves the draft; selecting another graph still warns before discarding it.
  keepDraft();
  hideDetails();
}
function hideDetails() {
  const dialog = element('selected');
  if (!dialog.open) return;
  element('graph-more').open = false;
  dialog.close();
  const row = [...element('graph-list').children].find(row => row.dataset.id === (detailInvoker?.id || selectedId));
  const target = detailInvoker instanceof HTMLElement && detailInvoker.isConnected ? detailInvoker
    : row?.querySelector(detailInvoker?.menu ? 'summary' : 'button[data-id]');
  // Restore once, before the queued close event can interrupt subsequent focus changes.
  (target || element('search')).focus();
}
function renderDetails(entry = selected()) {
  if (!entry) hideDetails();
  if (!entry) { detailsEntry = null; return; }
  detailsEntry = structuredClone(entry);
  element('selected-title').textContent = entry.name;
  element('graph-name').value = entry.name; element('graph-description').value = entry.description;
  element('graph-more').open = false;
  element('graph-metadata').open = false;
  updateDetailsState();
  preview(entryError(entry) ? null : entryGraph(entry));
}
function renderSelectedState() {
  const current = selected(), entry = current || detailsEntry;
  if (!entry) return;
  const invalid = entryError(entry), removed = !current;
  element('open').hidden = removed;
  element('open').href = `graph-editor.html?id=${encodeURIComponent(entry.id)}`;
  element('selected-error').textContent = removed ? 'This graph was deleted in another page. Unsaved details have been kept; copy them before selecting another graph. Export JSON still recovers the previous saved graph.'
    : invalid ? `Invalid saved graph: ${invalid} Export the original JSON, repair it, and import as new. The original is kept.` : '';
  element('duplicate').disabled = !!invalid || removed;
  element('check-cache').disabled = !!invalid || removed || state(entry) === 'Unknown · checking';
  element('cache-hint').textContent = removed ? 'This graph was deleted.' : invalid ? 'Repair and import this graph before checking model files.' : '';
  element('save-details').disabled = removed;
  const assigned = Object.values(library.assignments).includes(entry.id);
  const last = !library.graphs.some(other => other.id !== entry.id && usable(other));
  element('delete').disabled = removed || assigned || last;
  element('delete-hint').textContent = removed ? 'This graph was deleted.' : assigned ? 'Used by a launch setting; choose another graph in Launch settings first.' : last ? 'Keep at least one usable graph.' : '';
  element('graph-updated').textContent = new Date(entry.updatedAt).toLocaleString();
  element('graph-models').textContent = invalid ? 'Unknown · repair graph first' : models(entry).join(', ') || 'None';
  element('graph-cache').textContent = state(entry);
}
function preview(graph) {
  const root = element('preview'); root.replaceChildren();
  root.setAttribute('aria-label', graph ? `Graph preview: ${graph.nodes.length} nodes, ${graph.edges.length} connections. ${graph.nodes.map(node => `${node.id}: ${NODE_TYPES[node.type].label}`).join('; ')}` : 'No preview available; repair this saved graph.');
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
    const type = svg('text', { x: p.x + 8, y: p.y + 38 }); type.textContent = NODE_TYPES[node.type].label;
    group.append(name, type); root.append(group);
  }
}
function render(replaceDetails = false) {
  if (!selected() && (!dirty() || replaceDetails)) selectedId = library.assignments.live;
  const search = element('search').value.toLocaleLowerCase(), filter = element('filter').value;
  const rows = library.graphs.filter(entry => `${entry.name} ${entry.description} ${models(entry).join(' ')}`.toLocaleLowerCase().includes(search)
    && (filter === 'all' || filter === 'assigned' && Object.values(library.assignments).includes(entry.id) || filter === 'invalid' && entryError(entry)));
  rows.sort(element('sort').value === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  const focusedRow = document.activeElement?.closest('#graph-list li');
  const focusedId = focusedRow?.dataset.id;
  const focusedMenu = document.activeElement?.tagName === 'SUMMARY';
  element('graph-list').replaceChildren(...rows.map(entry => {
    const row = el('li'), button = el('button'); row.dataset.id = entry.id; button.dataset.id = entry.id;
    button.onclick = () => select(entry.id, { id: entry.id, menu: false });
    button.setAttribute('aria-label', `Open details for ${entry.name}`); button.setAttribute('aria-controls', 'selected'); button.setAttribute('aria-haspopup', 'dialog');
    const name = el('span', entry.name); name.className = 'graph-row-name'; button.append(name);
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
        if (!select(entry.id, { id: entry.id, menu: true })) { summary.focus(); return; }
        if (command) element(command).click();
      };
      actionButton.disabled = ['open', 'duplicate'].includes(command) && !!entryError(entry);
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
  renderLaunchSettings();
  refreshVoiceStatus();
  const changed = legacyChanged(localStorage, library);
  element('recovery').hidden = !changed;
  element('recover-legacy').hidden = !changed;
  element('recovery-message').textContent = changed ? 'The legacy graph changed after migration. Keep it as a separate entry before further edits. Both versions are preserved; no assignment will change.' : '';
}
function launchReason(target, entry) {
  if (!entry) return target === 'webVoice' ? '' : 'Choose a saved graph.';
  if (target === 'webVoice') return webVoiceError(entry.graph);
  return entryError(entry) ? 'Repair and import this graph first.' : !usable(entry) ? 'Connect an executable path in Graph Editor.' : '';
}
function renderLaunchSettings() {
  for (const [target, prefix] of [['live', 'live'], ['webVoice', 'web']]) {
    const select = element(`${prefix}-graph`), assignedId = library.assignments[target];
    const options = library.graphs.map(entry => {
      const reason = launchReason(target, entry);
      const option = el('option', `${entry.name}${reason ? ` — ${reason}` : ''}`);
      option.value = entry.id; option.disabled = !!reason; return option;
    });
    if (target === 'webVoice') { const none = el('option', 'Not assigned'); none.value = ''; options.unshift(none); }
    select.replaceChildren(...options); select.value = assignedId ?? '';
    select.title = library.graphs.find(entry => entry.id === assignedId)?.name || 'Not assigned';
    const reason = launchReason(target, library.graphs.find(entry => entry.id === assignedId));
    element(`${prefix}-launch-status`).textContent = reason;
  }
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
    if (selectNew) showDetails();
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
  if (!library.graphs.some(entry => entry.id === selectedId)) selectedId = library.assignments.live;
  render(true);
  // Per-tab drafts survive refresh without changing library data or revisions.
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    if (draft?.entry?.id && draft.entry.revision && typeof draft.entry.name === 'string' && typeof draft.entry.description === 'string' && typeof draft.name === 'string' && typeof draft.description === 'string') {
      selectedId = draft.entry.id; renderDetails(draft.entry);
      element('graph-name').value = draft.name; element('graph-description').value = draft.description;
      updateDetailsState(); render(); showDetails();
    }
  } catch { element('errors').textContent = 'Could not restore unsaved details. Saved graphs are unchanged.'; }
} catch (error) {
  fatal = true; element('errors').textContent = error.message;
  element('recovery').hidden = false; element('recover-legacy').hidden = true;
  element('recovery-message').textContent = 'Original storage is available for export. No saved data has been overwritten.';
  for (const node of document.querySelectorAll('#new, main button, main input, main select')) node.disabled = !['export-storage', 'export-legacy'].includes(node.id);
  hideDetails();
}
if (!fatal) {
  const toggle = element('web-voice-enabled'), status = element('web-voice-status'), consent = element('voice-consent');
  let voiceMessage = '', hasWebsiteAccess = true, assignmentIdentity;
  const assignedError = () => {
    const entry = library.graphs.find(entry => entry.id === library.assignments.webVoice);
    return entry ? webVoiceError(entry.graph) : 'Choose a graph before turning ON.';
  };
  refreshVoiceStatus = () => {
    const entry = library.graphs.find(entry => entry.id === library.assignments.webVoice);
    const identity = entry ? `${entry.id}:${entry.revision}` : '';
    if (identity !== assignmentIdentity) { voiceMessage = ''; assignmentIdentity = identity; }
    element('voice-switch-state').textContent = toggle.checked ? 'ON' : 'OFF';
    const reason = assignedError();
    // Bound-graph errors are already beside the selector; avoid repeating them.
    status.textContent = voiceMessage || (reason ? entry ? '' : reason : toggle.checked ? hasWebsiteAccess ? 'ON · click a field mic to start.' : 'Website access missing. Turn OFF, then ON to grant access.' : '');
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
        const reason = assignedError(); if (reason) throw Error(reason);
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
    const reason = assignedError();
    if (reason) { voiceMessage = reason; refreshVoiceStatus(); return; }
    refreshVoiceStatus(); consent.showModal();
  };
  element('confirm-voice').onclick = () => {
    const reason = assignedError();
    if (reason) { consent.close(); voiceMessage = reason; refreshVoiceStatus(); return; }
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
  element('back-to-graphs').onclick = closeDetails;
  element('selected').addEventListener('cancel', event => {
    if (element('graph-more').open) {
      event.preventDefault(); element('graph-more').open = false; element('graph-more').querySelector('summary').focus();
    } else { event.preventDefault(); closeDetails(); }
  });
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
    const menu = event.target.closest('.row-menu[open]');
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
      if (!dirty() || confirm('Discard unsaved graph details?')) await action(() => store.create({ name: file.name.replace(/\.json$/i, '') || 'Imported graph', graph }, library.revision), { selectNew: true });
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
    download(exportEntry(entry), `${entry.name.replace(/[^\p{L}\p{N} _-]/gu, '_')}.json`);
  };
  element('delete').onclick = () => {
    const entry = selected(); if (!entry) return;
    if (confirm(`Delete “${entry.name}”? This cannot be undone.${dirty() ? ' Unsaved details will also be discarded.' : ''}`)) void action(() => store.delete(selectedId, library.revision)).then(success => {
      if (success) { clearDraft(); selectedId = library.assignments.live; render(true); }
    });
  };
  for (const [target, prefix] of [['live', 'live'], ['webVoice', 'web']]) {
    const select = element(`${prefix}-graph`), status = element(`${prefix}-launch-status`);
    select.onchange = async () => {
      const id = select.value || null, revision = library.revision;
      const entry = library.graphs.find(entry => entry.id === id);
      const reason = id && !entry ? 'Graph no longer exists. Choose another graph.' : launchReason(target, entry);
      const failed = error => {
        // Refresh bindings after conflicts without replacing an unsaved details draft.
        let readError = '';
        try { library = readLibrary(localStorage); } catch (error) { readError = ` ${error.message}`; }
        render();
        status.textContent = `${error.message} Launch setting was not saved. Review the current choice and try again.${readError}`;
        status.focus();
      };
      if (reason) { failed(Error(reason)); return; }
      const saved = await action(() => store.assign(target, id, revision), { onError: failed });
      if (saved) { status.textContent = 'Saved · applies to the next session.'; select.focus(); }
    };
  }
  element('recover-legacy').onclick = () => { void action(() => store.recoverLegacy(library.revision)); };
  element('check-cache').onclick = async () => {
    const entry = selected(); if (!entry) return;
    const key = JSON.stringify(entry.graph);
    element('graph-metadata').open = true;
    element('check-cache').disabled = true;
    states.set(key, 'Unknown · checking'); render();
    try {
      const requirements = graphModelRequirements(entryGraph(entry));
      const views = await Promise.all(requirements.map(async requirement => new ModelAssetCache(await requirement.manifest()).inspect()));
      const packaged = entryGraph(entry).nodes.some(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type));
      states.set(key, views.some(view => view.state === 'Error') ? 'Error · open Models' : views.some(view => view.state !== 'Ready') ? 'Needs preparation' : packaged ? 'Unknown · packaged models checked by Live' : 'Ready · cached files');
    } catch (error) { states.set(key, 'Error · open Models'); element('errors').textContent = error.message; }
    finally { render(); }
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
  window.addEventListener('beforeunload', event => { keepDraft(); if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
}
