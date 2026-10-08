import { TabSession } from './session.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { translationLanguages, readTranslationPreferences, writeTranslationPreferences } from './translation-preferences.js';
import { ModelAssetCache } from './model-asset-cache.js';
import { translationLabel, provisionalLabel, provisionalState } from './translation-view.js';

const element = id => document.getElementById(id);
let renderedUtterances;
const session = new TabSession(view => {
  for (const id of ['status', 'signal', 'partial', 'final']) element(id).textContent = view[id];
  element('errors').textContent = view.error;
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
  element('start').disabled = view.state !== 'idle' || !Number.isInteger(view.tabId);
  element('stop').disabled = !['loading', 'starting', 'running'].includes(view.state);
});
const preferences = readTranslationPreferences(localStorage);
session.setTranslation(preferences.enabled); session.setTranslationDirection(preferences.direction);
const savePreferences = () => writeTranslationPreferences(localStorage, { enabled: session.view.translationEnabled, direction: session.view.translationDirection });
element('translation-enabled').onchange = event => { session.setTranslation(event.target.checked); savePreferences(); };
element('translation-direction').onchange = event => {
  session.setTranslationDirection(event.target.value); savePreferences(); void inspectSelectedModel();
};
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
