import { TabSession } from './session.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { translationLanguages } from './translation-preferences.js';
import { ModelAssetCache } from './model-asset-cache.js';
import { translationLabel, provisionalLabel, provisionalState } from './translation-view.js';

import { readGraph, saveGraph, defaultGraph, GRAPH_KEY, graphPreferences, withTranslation } from './graph.js';
import { GraphEditor } from './graph-editor.js';
import { ttsManifest } from './tts-cache.js';
import { audioToWav } from '../web/synthesized-audio.js';

const element = id => document.getElementById(id);
let renderedUtterances, editor, graphError = '', graph;
try { graph = readGraph(localStorage); } catch (error) { graphError = `Saved graph unavailable: ${error.message}. Load or reset and Save in the editor to recover.`; graph = defaultGraph(); }
const audioURLs = new Set();
function clearAudio() { for (const player of element('audio-outputs').querySelectorAll('audio')) { player.pause(); player.removeAttribute('src'); player.load(); } for (const url of audioURLs) URL.revokeObjectURL(url); audioURLs.clear(); element('audio-outputs').replaceChildren(); }

const session = new TabSession(view => {
  for (const id of ['status', 'signal', 'partial', 'final']) element(id).textContent = view[id];
  element('errors').textContent = graphError || view.error;
  element('tts-status').textContent = view.ttsStatus;
  editor?.setActive(view.activeGraph, view.state);
  const languages = translationLanguages(view.displayDirection);
  element('translation-direction').value = view.translationDirection;
  element('session-direction').textContent = `Transcript direction: ${languages.source} → ${languages.target}${view.state === 'idle' ? ' (last session; next session uses the selection above)' : ' (current session)'}`;
  element('partial-source-label').textContent = `Provisional ${languages.source} original`;
  element('partial-target-label').textContent = `Provisional ${languages.target} translation`;
  element('final-source-label').textContent = `Final ${languages.source} original transcript`;
  element('final-pair-label').textContent = `Final utterances: ${languages.source} original / ${languages.target} translation`;
  element('partial').lang = element('final').lang = languages.sourceCode;
  element('partial-english').lang = languages.targetCode;
  element('translation-enabled').checked = view.translationEnabled;
  element('translation-enabled').disabled = view.state !== 'idle';
  element('translation-status').textContent = view.translationStatus;
  element('partial-english').textContent = provisionalLabel(view.partial, view.interimTranslation, view.displayTranslationEnabled);
  element('partial-english').dataset.status = provisionalState(view.partial, view.interimTranslation, view.displayTranslationEnabled);
  element('cancel-session').disabled = view.state === 'idle';
  if (view.utterances !== renderedUtterances) {
    renderedUtterances = view.utterances;
    element('paired-finals').replaceChildren(...view.utterances.map(row => {
      const entry = document.createElement('li');
      const pairLanguages = translationLanguages(row.direction);
      const original = document.createElement('pre'); original.textContent = row.source; original.lang = pairLanguages.sourceCode;
      original.setAttribute('aria-label', `${pairLanguages.source} original`);
      const translated = document.createElement('pre'); translated.textContent = translationLabel(row); translated.lang = pairLanguages.targetCode;
      translated.setAttribute('aria-label', `${pairLanguages.target} translation`);
      entry.append(original, translated); return entry;
    }));
  }
  element('start').disabled = !!graphError || view.state !== 'idle' || !Number.isInteger(view.tabId);
  element('stop').disabled = !['loading', 'starting', 'running'].includes(view.state);
}, { graph, onSynthesizedAudio: (audio, signal) => {
  if (signal.aborted) return;
  const url = URL.createObjectURL(audioToWav(audio)); audioURLs.add(url);
  const row = document.createElement('li'), player = document.createElement('audio'), link = document.createElement('a');
  player.controls = true; player.src = url; link.href = url; link.download = 'speech.wav'; link.textContent = 'Download WAV';
  row.append(player, link); element('audio-outputs').append(row); session.update({ ttsStatus: 'Audio ready. Press Play to listen or download WAV.' });
} });
function applySaved(next) { const saved = saveGraph(localStorage, next); graphError = ''; session.setGraph(saved); editor?.setSaved(saved); void inspectSelectedModel(); }
element('translation-enabled').onchange = event => {
  try { applySaved(withTranslation(session.graph, { ...graphPreferences(session.graph), enabled: event.target.checked })); }
  catch (error) { session.update({ error: error.message }); }
};
element('translation-direction').onchange = event => {
  try { applySaved(withTranslation(session.graph, { ...graphPreferences(session.graph), direction: event.target.value })); }
  catch (error) { session.update({ error: error.message }); }
};
element('start').onclick = () => { clearAudio(); if (!graphError) void session.start(session.view.tabId); };
element('stop').onclick = () => { void session.stop(); };
element('cancel-session').onclick = () => {
  session.cancel(); clearAudio(); session.update({ status: 'Canceled. Pending recognition and translation discarded.' });
};
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.type === 'invoke' && Number.isInteger(message.tabId)) {
    if (!graphError && !session.session) { clearAudio(); void session.start(message.tabId); }
  }
});
chrome.tabs.onRemoved.addListener(tabId => session.tabEnded(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') session.tabEnded(tabId);
});
// Stream-specific onended callbacks carry a session guard. Global tabCapture
// status events have no session ID and can arrive late after a same-tab restart.
window.addEventListener('pagehide', () => { session.cancel(); clearAudio(); });
window.addEventListener('error', event => session.fail(event.message));
window.addEventListener('unhandledrejection', event => session.fail(event.reason?.message || String(event.reason)));
const params = new URLSearchParams(location.search);
const tabId = params.has('tab') ? Number(params.get('tab')) : NaN;
if (params.has('error')) session.update({ error: params.get('error'), tabId });
else if (Number.isInteger(tabId)) { if (graphError) session.update({ tabId }); else void session.start(tabId); }

// Preparation is independent of capture. Only inspect/download the selected
// immutable asset set. Direction changes never relabel another model's progress.
const modelCaches = new Map();
let preparation, hidden = false, inspection = 0;
function cacheView(view, direction) {
  if (hidden || session.view.translationDirection !== direction) return;
  element('model-status').textContent = `${view.state}${view.error ? ': ' + view.error : ''}`;
  element('model-progress').max = view.totalBytes;
  element('model-progress').value = view.downloadedBytes;
  element('model-bytes').textContent = `${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes`;
}
async function selectedModelCache(direction) {
  if (!modelCaches.has(direction)) {
    const manifest = await (direction === 'en-ja' ? englishToJapaneseOpusMtManifest() : opusMtManifest());
    modelCaches.set(direction, new ModelAssetCache(manifest));
  }
  return modelCaches.get(direction);
}
async function inspectSelectedModel() {
  const direction = session.view.translationDirection, ticket = ++inspection;
  const languages = translationLanguages(direction);
  element('model-direction').textContent = `Selected model assets: ${languages.source} → ${languages.target}`;
  element('model-status').textContent = 'Checking cached assets…';
  element('model-progress').value = 0; element('model-bytes').textContent = '';
  try {
    const cache = await selectedModelCache(direction);
    const view = await cache.inspect();
    if (ticket === inspection) cacheView(view, direction);
  } catch (error) {
    if (!hidden && ticket === inspection) element('model-status').textContent = error.message;
  }
}
element('prepare-opus').onclick = async () => {
  if (preparation) return;
  const direction = session.view.translationDirection;
  const controller = new AbortController(); preparation = controller; ++inspection;
  element('prepare-opus').disabled = true; element('cancel-download').disabled = false;
  element('translation-direction').disabled = true;
  try {
    const cache = await selectedModelCache(direction);
    controller.signal.throwIfAborted();
    cacheView(await cache.prepare({ signal: controller.signal, onChange: view => cacheView(view, direction) }), direction);
  } catch (error) { if (!hidden) element('model-status').textContent = error.message; }
  finally {
    preparation = null;
    if (!hidden) {
      element('prepare-opus').disabled = false; element('cancel-download').disabled = true;
      element('translation-direction').disabled = false;
    }
  }
};
element('cancel-download').onclick = () => preparation?.abort();
window.addEventListener('pagehide', () => { hidden = true; ++inspection; preparation?.abort(); });
void inspectSelectedModel();

// TTS preparation snapshots a concrete draft Node; moving/editing/saving the
// graph cannot change the selected asset set of a pending download.
let ttsDraft = [], ttsPreparation, ttsInspection = 0, ttsKey = '';
function updateTtsNodes(draft) {
  const nodes = draft.nodes.filter(n => ['Supertonic3', 'Kokoro'].includes(n.type));
  const key = JSON.stringify(nodes.map(({ id, type, settings }) => ({ id, type, settings })));
  if (key === ttsKey) return;
  ttsKey = key; ttsDraft = nodes;
  const selected = element('tts-node').value;
  element('tts-node').replaceChildren(...nodes.map(node => { const option = document.createElement('option'); option.value = node.id; option.textContent = `${node.id}: ${node.type} (${Object.values(node.settings).join(', ')})`; return option; }));
  if (nodes.some(n => n.id === selected)) element('tts-node').value = selected;
  element('prepare-tts').disabled = !nodes.length || !!ttsPreparation;
  void inspectTts();
}
async function inspectTts() {
  const node = ttsDraft.find(n => n.id === element('tts-node').value), ticket = ++ttsInspection;
  if (!node) { element('tts-model-status').textContent = 'Add a TTS Node to inspect its assets.'; return; }
  try {
    const manifest = await ttsManifest(node.type, node.settings);
    const view = await new ModelAssetCache(manifest).inspect();
    if (!hidden && ticket === ttsInspection) element('tts-model-status').textContent = `${node.id}: ${view.state}${view.error ? ': ' + view.error : ''} (${manifest.bytes.toLocaleString()} bytes)`;
  } catch (error) { if (!hidden && ticket === ttsInspection) element('tts-model-status').textContent = error.message; }
}
element('tts-node').onchange = () => { void inspectTts(); };
element('prepare-tts').onclick = async () => {
  const node = ttsDraft.find(n => n.id === element('tts-node').value);
  if (!node || ttsPreparation) return;
  const selected = structuredClone(node), controller = new AbortController(); ttsPreparation = controller; ++ttsInspection;
  element('prepare-tts').disabled = true; element('cancel-tts-download').disabled = false;
  try {
    const manifest = await ttsManifest(selected.type, selected.settings); controller.signal.throwIfAborted();
    const show = view => { if (!hidden) element('tts-model-status').textContent = `${selected.id} (${Object.values(selected.settings).join(', ')}): ${view.state} ${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes${view.error ? ': ' + view.error : ''}`; };
    show(await new ModelAssetCache(manifest).prepare({ signal: controller.signal, onChange: show }));
  } catch (error) { if (!hidden) element('tts-model-status').textContent = error.message; }
  finally { ttsPreparation = null; if (!hidden) { element('prepare-tts').disabled = !ttsDraft.length; element('cancel-tts-download').disabled = true; } }
};
element('cancel-tts-download').onclick = () => ttsPreparation?.abort();
window.addEventListener('pagehide', () => { ++ttsInspection; ttsPreparation?.abort(); });
editor = new GraphEditor(element('graph-editor'), graph, { onSave: applySaved, onDraft: updateTtsNodes });
editor.setActive(session.view.activeGraph, session.view.state);
element('graph-panel').addEventListener('toggle', () => editor.drawWires());
if (graphError) { element('graph-panel').open = true; session.update(); }
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY) return;
  try { applyLoadedGraph(readGraph(localStorage)); } catch (error) { graphError = error.message; session.update(); }
});
function applyLoadedGraph(next) { graphError = ''; session.setGraph(next); editor.setSaved(next); void inspectSelectedModel(); }
