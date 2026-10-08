import { TabSession } from './session.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { ModelAssetCache } from './model-asset-cache.js';
import { translationLabel, provisionalLabel, provisionalState } from './translation-view.js';

const element = id => document.getElementById(id);
let renderedUtterances;
const session = new TabSession(view => {
  for (const id of ['status', 'signal', 'partial', 'final']) element(id).textContent = view[id];
  element('errors').textContent = view.error;
  element('translation-enabled').checked = view.translationEnabled;
  element('translation-enabled').disabled = view.state !== 'idle';
  element('translation-status').textContent = view.translationStatus;
  element('partial-english').textContent = provisionalLabel(view.partial, view.interimTranslation, view.translationEnabled);
  element('partial-english').dataset.status = provisionalState(view.partial, view.interimTranslation, view.translationEnabled);
  element('cancel-session').disabled = view.state === 'idle';
  if (view.utterances !== renderedUtterances) {
    renderedUtterances = view.utterances;
    element('paired-finals').replaceChildren(...view.utterances.map(row => {
      const entry = document.createElement('li');
      const japanese = document.createElement('pre'); japanese.textContent = row.source; japanese.lang = 'ja';
      const english = document.createElement('pre'); english.textContent = translationLabel(row); english.lang = 'en';
      entry.append(japanese, english); return entry;
    }));
  }
  element('start').disabled = view.state !== 'idle' || !Number.isInteger(view.tabId);
  element('stop').disabled = !['loading', 'starting', 'running'].includes(view.state);
});
element('translation-enabled').onchange = event => session.setTranslation(event.target.checked);
element('start').onclick = () => { void session.start(session.view.tabId); };
element('stop').onclick = () => { void session.stop(); };
element('cancel-session').onclick = () => {
  session.cancel(); session.update({ status: 'Canceled. Pending recognition and translation discarded.' });
};
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.type === 'invoke' && Number.isInteger(message.tabId)) {
    void session.start(message.tabId);
  }
});
chrome.tabs.onRemoved.addListener(tabId => session.tabEnded(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') session.tabEnded(tabId);
});
// Stream-specific onended callbacks carry a session guard. Global tabCapture
// status events have no session ID and can arrive late after a same-tab restart.
window.addEventListener('pagehide', () => session.cancel());
window.addEventListener('error', event => session.fail(event.message));
window.addEventListener('unhandledrejection', event => session.fail(event.reason?.message || String(event.reason)));
const params = new URLSearchParams(location.search);
const tabId = params.has('tab') ? Number(params.get('tab')) : NaN;
if (params.has('error')) session.update({ error: params.get('error'), tabId });
else if (Number.isInteger(tabId)) void session.start(tabId);

// Preparation is independent of capture and never triggered by enabling inference.
let modelCache, preparation, hidden = false;
function cacheView(view) {
  if (hidden) return;
  element('model-status').textContent = `${view.state}${view.error ? ': ' + view.error : ''}`;
  element('model-progress').max = view.totalBytes;
  element('model-progress').value = view.downloadedBytes;
  element('model-bytes').textContent = `${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes`;
}
const cacheReady = opusMtManifest().then(manifest => {
  modelCache = new ModelAssetCache(manifest); return modelCache.inspect();
}).then(cacheView).catch(error => { if (!hidden) element('model-status').textContent = error.message; });
element('prepare-opus').onclick = async () => {
  if (preparation) return;
  const controller = new AbortController(); preparation = controller;
  element('prepare-opus').disabled = true; element('cancel-download').disabled = false;
  try {
    await cacheReady;
    if (!modelCache) throw new Error('Packaged model manifest unavailable.');
    const view = await modelCache.prepare({ signal: controller.signal, onChange: cacheView });
    cacheView(view);
  } catch (error) { if (!hidden) element('model-status').textContent = error.message; }
  finally {
    preparation = null;
    if (!hidden) { element('prepare-opus').disabled = false; element('cancel-download').disabled = true; }
  }
};
element('cancel-download').onclick = () => preparation?.abort();
window.addEventListener('pagehide', () => { hidden = true; preparation?.abort(); });
