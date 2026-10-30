import { readGraph, saveGraph, defaultGraph, GRAPH_KEY, GRAPH_RECOVERY_KEY } from './graph.js';
import { GraphEditor } from './graph-editor.js';
import { graphModelStatus } from './graph-model-status.js';

const element = id => document.getElementById(id);
const preparation = graphModelStatus(element('graph-models'));
let graph, editor, base, recoveryGraph, migrationError, conflict = false;
try { graph = readGraph(localStorage); }
catch (error) {
  recoveryGraph = error.recoveryGraph; migrationError = true;
  element('errors').textContent = `Saved graph unavailable: ${error.message}${recoveryGraph ? ' Review the unsaved repair draft, then Save.' : ' Reset draft and Save to recover.'} The original is available under Graph actions → Recovery.`;
  graph = defaultGraph();
}
base = localStorage.getItem(GRAPH_KEY);
// A plain-text recovery copy is accessible before and after the reviewed Save.
const recoveryCopy = document.createElement('details');
recoveryCopy.className = 'graph-recovery';
const recoveryTitle = document.createElement('summary'); recoveryTitle.textContent = 'Recovery';
const recoveryText = document.createElement('textarea'); recoveryText.readOnly = true;
recoveryText.setAttribute('aria-label', 'Original saved graph JSON');
const recoveryKeys = Object.keys(localStorage).filter(key => /^processing-graph-before-v\d+(?:-\d+)?$/.test(key)).sort();
const recoverySelect = document.createElement('select'); recoverySelect.setAttribute('aria-label', 'Graph recovery version');
const copies = [...(migrationError && base ? [['Unsaved original', base]] : []),
  ...recoveryKeys.map(key => [key, localStorage.getItem(key)])];
for (const [index, [label]] of copies.entries()) {
  const option = document.createElement('option'); option.value = String(index); option.textContent = label; recoverySelect.append(option);
}
const preferred = Math.max(0, copies.findIndex(([key]) => key === GRAPH_RECOVERY_KEY));
recoverySelect.value = String(migrationError ? 0 : preferred);
const originalRecovery = () => copies[Number(recoverySelect.value)]?.[1] || '';
const showRecovery = () => { recoveryText.value = originalRecovery(); };
recoverySelect.onchange = showRecovery; showRecovery();
recoveryCopy.hidden = !copies.length; recoverySelect.hidden = copies.length < 2;
const copyRecovery = document.createElement('button'); copyRecovery.type = 'button'; copyRecovery.textContent = 'Copy JSON';
const recoveryStatus = document.createElement('p'); recoveryStatus.setAttribute('role', 'status');
copyRecovery.onclick = async () => {
  try { await navigator.clipboard.writeText(originalRecovery()); recoveryStatus.textContent = 'Original JSON copied.'; }
  catch { recoveryStatus.textContent = 'Select and copy the original JSON below.'; recoveryText.focus(); recoveryText.select(); }
};
const exportRecovery = document.createElement('button'); exportRecovery.type = 'button'; exportRecovery.textContent = 'Download JSON';
exportRecovery.onclick = () => {
  const url = URL.createObjectURL(new Blob([originalRecovery()], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'graph-recovery.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
recoveryCopy.append(recoveryTitle, recoverySelect, copyRecovery, exportRecovery, recoveryStatus, recoveryText);
async function persist(next) {
  const saved = await navigator.locks.request('processing-graph-save', async () => {
    if (conflict || localStorage.getItem(GRAPH_KEY) !== base) throw new Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
    const saved = saveGraph(localStorage, next); base = localStorage.getItem(GRAPH_KEY);
    element('errors').textContent = ''; return saved;
  });
  // Keep preparation outside the persistence transaction and its error path.
  // The immutable saved snapshot, never the editable draft, chooses assets.
  preparation.replace(saved);
  return saved;
}
editor = new GraphEditor(element('graph-editor'), graph, { recoveryGraph, onSave: persist, onLoad: () => {
  const next = readGraph(localStorage);
  conflict = false; base = localStorage.getItem(GRAPH_KEY); return next;
} });
editor.actions.querySelector('.graph-command-list').append(recoveryCopy);
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY && event.key !== null) return;
  // Another page now owns the saved snapshot. Stop preparing this page's old
  // requirements; opening/loading a saved graph must not start downloads.
  preparation.clear();
  try {
    const next = readGraph(localStorage), dirty = editor.isDirty();
    conflict = dirty; editor.receiveSaved(next);
    if (!dirty) base = localStorage.getItem(GRAPH_KEY);
  } catch (error) { conflict = true; element('errors').textContent = `Saved graph changed but is invalid: ${error.message}. Reload to recover.`; }
});
const stateChannel = new BroadcastChannel('live-graph-state');
stateChannel.onmessage = ({ data }) => editor.setActive(data.graph, data.state, data.tabId);
async function refreshActive() {
  try {
    const live = await chrome.runtime.sendMessage({ type: 'get-live-graph-state' });
    editor.setActive(live?.graph, live?.state || 'idle', live?.tabId);
  } catch { editor.setActive(null, 'idle'); }
}
window.addEventListener('focus', () => { void refreshActive(); });
window.addEventListener('pagehide', () => stateChannel.close());
void refreshActive();
