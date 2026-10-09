import { readGraph, saveGraph, defaultGraph, GRAPH_KEY, graphPreferences, withTranslation } from './graph.js';
import { GraphEditor } from './graph-editor.js';

const element = id => document.getElementById(id);
let graph, editor, base, conflict = false;
try { graph = readGraph(localStorage); }
catch (error) { element('errors').textContent = `Saved graph unavailable: ${error.message}. Reset draft and Save to recover.`; graph = defaultGraph(); }
base = localStorage.getItem(GRAPH_KEY);
async function persist(next) {
  return navigator.locks.request('processing-graph-save', async () => {
    if (conflict || localStorage.getItem(GRAPH_KEY) !== base) throw new Error('Saved graph changed in another page. Load saved before saving; your draft has been kept.');
    const saved = saveGraph(localStorage, next); base = localStorage.getItem(GRAPH_KEY);
    element('errors').textContent = ''; return saved;
  });
}
editor = new GraphEditor(element('graph-editor'), graph, { onSave: persist, onDraft: draft => {
  const preferences = graphPreferences(draft);
  element('translation-enabled').checked = preferences.enabled;
  element('translation-direction').value = preferences.direction;
}, onLoad: () => {
  const next = readGraph(localStorage);
  conflict = false; base = localStorage.getItem(GRAPH_KEY); return next;
} });
function translationChange() {
  try {
    editor.draft = withTranslation(editor.draft, { enabled: element('translation-enabled').checked, direction: element('translation-direction').value });
    editor.draw();
  } catch (error) { element('errors').textContent = `Complete the draft connections first: ${error.message}`; }
}
element('translation-enabled').onchange = element('translation-direction').onchange = translationChange;
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY && event.key !== null) return;
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
