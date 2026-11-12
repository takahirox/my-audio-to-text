import { webVoiceChoices } from './web-voice-graph.js';
import { readVoiceEnabled, setVoiceEnabled, WEB_VOICE_ORIGINS, WEB_VOICE_KEY, voiceEnabled } from './web-voice-preference.js';
import { GraphLibrary, LIBRARY_KEY, openLibrary, readLibrary, resolvedEntryGraph, entryError, exportEntry, legacyChanged, usable } from './graph-library.js';
import { GRAPH_KEY, ASR_TYPES, nodeDefinition } from './graph.js';
import { graphModelRequirements } from './graph-model-preparation.js';
import { references } from './subgraphs.js';
import { GraphDetailsAutosave, DETAILS_DRAFT_KEY } from './graph-library-details.js';

const element = id => document.getElementById(id), store = new GraphLibrary(localStorage);
const selectionKey = 'graph-library-selection';
const nameCollator = new Intl.Collator('ja', { numeric: true });
let library, selectedId, fatal = false, refreshVoiceStatus = () => {};
let selectionRequest = 0, actionPending = false;
const details = new GraphDetailsAutosave({ store, storage: sessionStorage,
  name: element('graph-name'), description: element('graph-description'), status: element('details-state'), retry: element('retry-details'),
  onSaved() {
    library = readLibrary(localStorage);
    if (selected()?.revision !== details.entry.revision) details.conflict();
    element('selected-title').textContent = details.entry.name; render();
  }
});
new MutationObserver(() => { element('details-error').textContent = element('errors').textContent; })
  .observe(element('errors'), { childList: true });
new MutationObserver(renderRecoveryAction).observe(element('details-state'), { childList: true });
const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function dirty() { return details.editing; }
function renderRecoveryAction() {
  element('load-details').hidden = !details.entry || !details.failure && !details.reviewRequired && !!selected();
}
function selected() { return library.graphs.find(entry => entry.id === selectedId); }
function models(entry) {
  if (entryError(entry, library)) return [];
  const graph = resolvedEntryGraph(entry, library), requirements = graphModelRequirements(graph);
  return [...new Set([...requirements.map(requirement => requirement.title.split(' · ').filter(part => !/\d[\d.]* (?:MB|GB)|allow |WebGPU|CPU WASM|terms apply|Apache/.test(part)).slice(0, 2).join(' · ')),
    ...graph.nodes.filter(node => ASR_TYPES.includes(node.type) && !['SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'].includes(node.type)).map(node => (nodeDefinition(node, graph, library.graphs)?.label || node.type))])];
}
function rowButton(id = selectedId) {
  return [...element('graph-list').querySelectorAll('button[data-id]')].find(button => button.dataset.id === id);
}
function focusDetails() { rowButton()?.focus(); }
function rememberSelection() {
  try {
    if (selectedId) localStorage.setItem(selectionKey, selectedId);
    else localStorage.removeItem(selectionKey);
  } catch { /* Selection is optional; graph writes report their own errors. */ }
}
async function select(id) {
  if (actionPending) return false;
  const request = ++selectionRequest, nextId = id === selectedId ? null : id;
  if (!await details.flush()) {
    if (request === selectionRequest) rowButton()?.focus({ preventScroll: true });
    return false;
  }
  if (request !== selectionRequest) return false;
  details.clearDraft(); selectedId = nextId; render(true); rememberSelection();
  (rowButton(id) || element('search')).focus({ preventScroll: true });
  return true;
}
function renderDetails(entry = selected()) {
  element('selected').hidden = !entry;
  details.load(entry);
  if (!entry) return;
  element('selected-title').textContent = entry.name;
}
function renderSelectedState() {
  const current = selected(), entry = current || details.entry;
  if (!entry) return;
  const invalid = entryError(entry, library), removed = !current;
  element('open').hidden = removed;
  element('open').href = `graph-editor.html?id=${encodeURIComponent(entry.id)}`;
  element('selected-error').textContent = removed ? 'This graph was deleted in another page. Unsaved details have been kept; copy them before selecting another graph. Export JSON still recovers the previous saved graph.'
    : invalid ? `Invalid saved graph: ${invalid} Export the original JSON, repair it, and import as new. The original is kept.` : '';
  element('duplicate').disabled = !!invalid || removed;
  const parents = references(library, entry.id);
  const last = !library.graphs.some(other => other.id !== entry.id && usable(other, library));
  element('delete').disabled = removed || last || parents.length > 0;
  element('delete-hint').textContent = removed ? 'This graph was deleted.' : parents.length ? `Referenced by: ${parents.map(parent => parent.name).join(', ')}. Replace or remove instances and save those graphs before deleting.` : last ? 'Keep at least one usable graph.' : '';
  element('graph-models').textContent = invalid ? 'Unknown · repair graph first' : models(entry).join(', ') || 'None';
  renderRecoveryAction();
}
function render(replaceDetails = false) {
  if (selectedId && !selected() && (!dirty() || replaceDetails)) selectedId = null;
  const search = element('search').value.toLocaleLowerCase();
  const rows = library.graphs.filter(entry => `${entry.name} ${entry.description} ${models(entry).join(' ')}`.toLocaleLowerCase().includes(search));
  const matches = rows.length;
  // Keep the expanded row and its draft reachable even when it stops matching.
  const expanded = selected() || (dirty() ? details.entry : null);
  if (expanded && !rows.some(entry => entry.id === expanded.id)) rows.push(expanded);
  rows.sort((a, b) => nameCollator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const list = element('graph-list'), region = element('selected'), focused = document.activeElement;
  if (replaceDetails || !dirty() && (details.entry?.id !== selectedId || details.entry?.revision !== selected()?.revision)) renderDetails();
  const existing = new Map([...list.children].map(row => [row.dataset.id, row]));
  const nextRows = rows.map(entry => {
    let row = existing.get(entry.id);
    if (!row) {
      row = el('li'); row.dataset.id = entry.id;
      const button = el('button'); button.type = 'button'; button.dataset.id = entry.id;
      button.id = `graph-row-${entry.id}`;
      button.onclick = () => { void select(entry.id); };
      button.setAttribute('aria-controls', 'selected');
      const chevron = el('span'); chevron.className = 'graph-row-chevron'; chevron.setAttribute('aria-hidden', 'true');
      const text = el('span'); text.className = 'graph-row-text';
      const name = el('span'); name.className = 'graph-row-name';
      const description = el('span'); description.className = 'graph-row-description'; description.id = `description-${entry.id}`;
      text.append(name, description); button.append(chevron, text); row.append(button);
    }
    const button = row.querySelector('button[data-id]'), open = entry.id === selectedId;
    button.setAttribute('aria-label', `Open details for ${entry.name}${entry.kind === 'subgraph' ? ' · Subgraph' : ''}`);
    button.setAttribute('aria-expanded', String(open));
    row.classList.toggle('selected', open);
    row.querySelector('.graph-row-chevron').textContent = open ? '▾' : '▸';
    row.querySelector('.graph-row-name').textContent = `${entry.name}${entry.kind === 'subgraph' ? ' · Subgraph' : ''}`;
    const description = row.querySelector('.graph-row-description');
    description.textContent = entry.description; description.hidden = !entry.description;
    if (entry.description) button.setAttribute('aria-describedby', description.id);
    else button.removeAttribute('aria-describedby');
    if (open && region.parentElement !== row) row.append(region);
    return row;
  });
  if (!selectedId) { region.hidden = true; element('graphs').append(region); }
  for (const row of existing.values()) if (!nextRows.includes(row)) row.remove();
  // Reorder siblings around the expanded row without detaching its live inputs.
  // This preserves focus, the caret and an active IME session during refreshes.
  const anchor = nextRows.find(row => row.dataset.id === selectedId);
  if (anchor && anchor.parentElement !== list) list.append(anchor);
  let afterAnchor = !anchor;
  for (const row of nextRows) {
    if (row === anchor) { afterAnchor = true; continue; }
    if (afterAnchor) list.append(row);
    else list.insertBefore(row, anchor);
  }
  if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  element('graph-count').textContent = matches;
  element('empty').hidden = !!matches;
  renderSelectedState();
  refreshVoiceStatus();
  const changed = legacyChanged(localStorage, library);
  element('recovery').hidden = !changed;
  element('recover-legacy').hidden = !changed;
  element('recovery-message').textContent = changed ? 'The legacy graph changed after migration. Keep it as a separate entry before further edits. Both versions are preserved; no assignment will change.' : '';
}
async function action(work, { selectNew = false, recover = false, onError } = {}) {
  if (actionPending) return false;
  actionPending = true; ++selectionRequest;
  if (!recover && !await details.flush()) { actionPending = false; return false; }
  const controls = [...document.querySelectorAll('#new, main button, main input:not(#web-voice-enabled), main select, main textarea')].map(node => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  const restore = () => { for (const [node, disabled] of controls) node.disabled = disabled; };
  try {
    const next = await work();
    restore(); library = next;
    if (selectNew) details.clearDraft();
    if (selectNew) { selectedId = next.graphs.at(-1).id; try { localStorage.setItem(selectionKey, selectedId); } catch {} }
    element('errors').textContent = ''; render(selectNew);
    if (selectNew) focusDetails();
    return true;
  } catch (error) {
    restore();
    if (onError) onError(error);
    else element('errors').textContent = `${error.message} Nothing was overwritten. Reload or Load saved details to review current data.`;
    return false;
  } finally { actionPending = false; }
}
element('export-storage').onclick = () => download(localStorage.getItem(LIBRARY_KEY) ?? 'null', 'graph-library-original.json');
element('export-legacy').onclick = () => download(localStorage.getItem(GRAPH_KEY) ?? 'null', 'legacy-graph-original.json');
try {
  const opened = await openLibrary(localStorage); library = opened.library;
  element('library-warning').textContent = opened.warning;
  selectedId = localStorage.getItem(selectionKey);
  if (!library.graphs.some(entry => entry.id === selectedId)) selectedId = null;
  render(true);
  // Per-tab drafts survive refresh without changing library data or revisions.
  try {
    const draft = JSON.parse(sessionStorage.getItem(DETAILS_DRAFT_KEY));
    if (draft?.entry?.id && draft.entry.revision && typeof draft.entry.name === 'string' && typeof draft.entry.description === 'string' && typeof draft.name === 'string' && typeof draft.description === 'string') {
      selectedId = draft.entry.id; renderDetails(draft.entry);
      details.restore(draft); render(); focusDetails();
    }
  } catch { element('errors').textContent = 'Could not restore unsaved details. Saved graphs are unchanged.'; }
} catch (error) {
  fatal = true; element('errors').textContent = error.message;
  element('recovery').hidden = false; element('recover-legacy').hidden = true;
  element('recovery-message').textContent = 'Original storage is available for export. No saved data has been overwritten.';
  for (const node of document.querySelectorAll('#new, main button, main input:not(#web-voice-enabled), main select')) node.disabled = !['export-storage', 'export-legacy'].includes(node.id);
  element('selected').hidden = true;
}
// Consent remains revocable even if graph storage needs recovery.
{
  const help = element('web-voice-help');
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && help.open) {
      help.open = false; help.querySelector('summary').focus();
    }
  });
  document.addEventListener('click', event => { if (!help.contains(event.target)) help.open = false; });
  const toggle = element('web-voice-enabled'), status = element('web-voice-status');
  let voiceMessage = '', hasWebsiteAccess = true, voicePending = false, enableCanceled = false, savedEnabled = false, accessCheck = 0, preferenceChange = 0;
  let observedPreference, pendingEnabled;
  refreshVoiceStatus = () => {
    element('voice-switch-state').textContent = toggle.checked ? 'ON' : 'OFF';
    const count = library ? webVoiceChoices(library).length : null;
    status.textContent = voiceMessage || (toggle.checked && !hasWebsiteAccess ? 'Website access missing. Turn OFF, then ON to grant access.' : count === 0 ? 'No compatible graphs. Connect MicrophoneAudio through final text processing to FocusedInputTextOutputNode in Graph Editor.' : '');
  };
  const checkWebsiteAccess = async () => {
    const check = ++accessCheck;
    try {
      const granted = await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS });
      if (check === accessCheck) hasWebsiteAccess = granted;
    } catch { voiceMessage = 'Could not check website access. Turn ON to retry, or reload Graph Library.'; }
    refreshVoiceStatus();
  };
  async function reconcileVoice(stop = false) {
    const reply = await chrome.runtime.sendMessage({ type: 'web-voice-reconcile', stop });
    if (!reply?.ok) throw Error(reply?.error || 'Web microphone did not respond.');
  }
  async function changeVoice(enabled, permission) {
    const restoreFocus = document.activeElement === toggle;
    const operationId = crypto.randomUUID();
    const previousOperationId = observedPreference?.operationId;
    // Keep the last confirmed state visible until persistence and reconciliation finish.
    pendingEnabled = savedEnabled;
    voicePending = true; enableCanceled = false; toggle.disabled = true; toggle.checked = pendingEnabled;
    toggle.setAttribute('aria-busy', 'true');
    refreshVoiceStatus();
    try {
      if (enabled) {
        if (!await permission) throw Error('Website access denied or dismissed.');
        // A grant can be removed, or another Library can turn OFF, while the
        // native prompt is pending. Never overwrite that newer OFF decision.
        if (!await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS })) throw Error('Website access changed.');
        hasWebsiteAccess = true;
      }
      if (enabled && enableCanceled) throw Error('Website access or opt-in changed.');
      await navigator.locks.request(WEB_VOICE_KEY, async () => {
        if (enabled && enableCanceled) throw Error('Website access or opt-in changed.');
        await setVoiceEnabled(enabled, operationId);
      });
      await reconcileVoice();
      savedEnabled = await readVoiceEnabled();
      if (enabled) {
        const granted = await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS });
        if (enableCanceled || !savedEnabled || !granted) throw Error('Website access or opt-in changed.');
      }
      toggle.checked = savedEnabled; voiceMessage = '';
    } catch (error) {
      let failure = error.message, stateKnown = true;
      let superseded = enabled && enableCanceled;
      await navigator.locks.request(WEB_VOICE_KEY, async () => {
        // Serialize the ownership check, rollback and cleanup with other Library
        // writes. Even ON -> ON needs a unique owner so an older rejection cannot
        // erase a newer opt-in, including when both native prompts overlap.
        if (!superseded) {
          let current;
          try {
            current = (await chrome.storage.local.get(WEB_VOICE_KEY))[WEB_VOICE_KEY];
          } catch {
            // Storage events still identify a newer opt-in when reads fail.
            // Without one, continue rollback and cleanup rather than leaving
            // this operation's partially enabled controls running.
            stateKnown = false; current = observedPreference;
          }
          // A rejected OFF write can still see the original ON owner; only
          // an intervening opt-in supersedes that OFF intent.
          superseded = voiceEnabled(current) && current.operationId !== operationId
            && (enabled || current.operationId !== previousOperationId);
        }
        if (superseded) return;
        try { await setVoiceEnabled(false); savedEnabled = false; }
        catch (saveError) { failure += ` Could not save OFF: ${saveError.message}`; }
        // Stop controls even if an OFF write fails; later reconciliation may
        // restore them until OFF can be saved successfully.
        try { await reconcileVoice(true); }
        catch (stopError) { failure += ` Could not stop page controls: ${stopError.message} Close affected tabs to stop them.`; }
      });
      try { savedEnabled = await readVoiceEnabled(); }
      catch { stateKnown = false; }
      toggle.checked = savedEnabled;
      voiceMessage = superseded && stateKnown && savedEnabled ? '' : `${failure} ${!stateKnown
        ? 'Could not verify saved settings. Web microphone may still be ON. Reload Graph Library to retry.'
        : savedEnabled ? 'Web microphone is still ON in saved settings and may restart. Turn OFF to retry, or reload Graph Library.'
          : 'Web microphone is OFF. Turn ON to retry, or reload Graph Library.'}`;
    } finally {
      voicePending = false; toggle.disabled = false; toggle.removeAttribute('aria-busy'); refreshVoiceStatus();
      if (restoreFocus && [document.body, toggle].includes(document.activeElement)) toggle.focus({ preventScroll: true });
    }
  }
  toggle.onchange = () => {
    if (voicePending) { toggle.checked = pendingEnabled; return; }
    if (!toggle.checked) { void changeVoice(false); return; }
    // Request synchronously in the switch gesture, before any storage read,
    // contains check, messaging or await can consume Chrome's user activation.
    let permission;
    try { permission = chrome.permissions.request({ origins: WEB_VOICE_ORIGINS }); }
    catch (error) { permission = Promise.reject(error); }
    void changeVoice(true, permission);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[WEB_VOICE_KEY]) {
      ++preferenceChange;
      observedPreference = changes[WEB_VOICE_KEY].newValue;
      savedEnabled = voiceEnabled(observedPreference);
      if (voicePending && !savedEnabled) enableCanceled = true;
      if (!voicePending) { toggle.checked = savedEnabled; voiceMessage = ''; }
      refreshVoiceStatus();
    }
  });
  chrome.permissions.onRemoved.addListener(() => { if (voicePending) enableCanceled = true; void checkWebsiteAccess(); });
  chrome.permissions.onAdded.addListener(() => { void checkWebsiteAccess(); });
  try {
    const change = preferenceChange, preference = (await chrome.storage.local.get(WEB_VOICE_KEY))[WEB_VOICE_KEY];
    if (change === preferenceChange) { observedPreference = preference; savedEnabled = voiceEnabled(preference); toggle.checked = savedEnabled; }
  }
  catch { voiceMessage = 'Could not read Web microphone settings. Reload Graph Library to retry.'; }
  await checkWebsiteAccess();
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
  element('search').addEventListener('input', () => render());
  element('new').onclick = () => { void action(() => store.create({}, library.revision), { selectNew: true }); };
  element('import').onclick = () => element('import-file').click();
  element('import-file').onchange = async () => {
    const file = element('import-file').files?.[0]; if (!file) return;
    try {
      const graph = JSON.parse(await file.text());
      await action(() => store.import(graph, file.name.replace(/\.json$/i, '') || 'Imported graph', library.revision), { selectNew: true });
    } catch (error) { element('errors').textContent = `Cannot import graph: ${error.message}. Existing graphs have been kept.`; }
    finally { element('import-file').value = ''; }
  };
  element('details-form').onsubmit = event => { event.preventDefault(); void details.flush(); };
  element('load-details').onclick = async () => {
    if (actionPending) return;
    actionPending = true; ++selectionRequest;
    try {
      if (details.pending) await details.pending;
      if (dirty() && !confirm('Discard unsaved graph details and load saved details?')) return;
      library = readLibrary(localStorage); details.clearDraft(); render(true); element('errors').textContent = '';
    } catch (error) { element('errors').textContent = error.message; }
    finally { actionPending = false; }
  };
  element('open').onclick = async event => {
    event.preventDefault();
    if (actionPending) return;
    const request = ++selectionRequest, id = selectedId;
    if (await details.flush() && request === selectionRequest && id === selectedId) location.href = element('open').href;
  };
  element('duplicate').onclick = () => { void action(() => store.duplicate(selectedId, library.revision), { selectNew: true }); };
  element('export').onclick = async () => {
    if (actionPending) return;
    const request = ++selectionRequest, id = selectedId;
    // Recovery export may use the last saved graph, but must retain a failed draft.
    const saved = await details.flush();
    if (request !== selectionRequest || id !== selectedId || !saved && !details.failure && !details.reviewRequired) return;
    const entry = selected() || details.entry;
    download(exportEntry(entry, library), `${entry.name.replace(/[^\p{L}\p{N} _-]/gu, '_')}.json`);
  };
  element('delete').onclick = () => {
    const entry = selected(); if (!entry) return;
    if (confirm(`Delete “${entry.name}”? This cannot be undone.`)) void action(() => store.delete(selectedId, library.revision)).then(success => {
      if (success) { details.clearDraft(); selectedId = null; rememberSelection(); render(true); element('new').focus(); }
    });
  };
  element('recover-legacy').onclick = () => { void action(() => store.recoverLegacy(library.revision), { recover: true }); };
  window.addEventListener('storage', event => {
    if (![LIBRARY_KEY, GRAPH_KEY, null].includes(event.key)) return;
    try {
      library = readLibrary(localStorage);
      void chrome.runtime.sendMessage({ type: 'web-voice-library-changed' }).catch(() => {});
      if (dirty() && details.entry?.revision !== selected()?.revision) details.conflict();
      render();
    } catch (error) { element('errors').textContent = `${error.message} Your changes have been kept.`; }
  });
  window.addEventListener('pagehide', () => { details.keepDraft(); });
  window.addEventListener('beforeunload', event => { details.keepDraft(); if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
}
