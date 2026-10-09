import { TargetControls } from './target-controls.js';
import { TabSession } from './session.js';
import { translationLanguages } from './translation-preferences.js';
import { translationLabel, provisionalLabel, provisionalState } from './translation-view.js';
import { readGraph, defaultGraph, GRAPH_KEY, INPUT_TYPES } from './graph.js';
import { audioToWav } from '../web/synthesized-audio.js';

const element = id => document.getElementById(id);
const stateChannel = new BroadcastChannel('live-graph-state');
let targetControls;
let renderedUtterances, graphError = '', graph, publishedState, closed = false;
try { graph = readGraph(localStorage); }
catch (error) { graphError = `Saved graph unavailable: ${error.message}. Reset and Save in Graph Editor to recover.`; graph = defaultGraph(); }
const audioURLs = new Set();
function clearAudio() {
  for (const player of element('audio-outputs').querySelectorAll('audio')) { player.pause(); player.removeAttribute('src'); player.load(); }
  for (const url of audioURLs) URL.revokeObjectURL(url);
  audioURLs.clear(); element('audio-outputs').replaceChildren();
}
function graphState(view) { return { graph: view.activeGraph, state: view.state, tabId: view.tabId }; }
const session = new TabSession(view => {
  for (const id of ['status', 'signal', 'partial', 'final']) element(id).textContent = view[id];
  element('errors').textContent = graphError || view.error;
  const input = (view.state !== 'idle' ? view.activeGraph : view.savedGraph)?.nodes.find(node => INPUT_TYPES.includes(node.type));
  element('tab-status').textContent = input?.type === 'MicrophoneAudio' ? 'Capture target · microphone' : Number.isInteger(view.tabId) ? `Capture target · ${input?.type === 'SelectedPageMediaAudio' ? 'selected media in' : 'whole'} tab ${view.tabId}` : 'Invoke the toolbar action on a tab.';
  element('tts-status').textContent = view.ttsStatus;
  element('target-status').textContent = view.targetStatus;
  targetControls?.render();
  const running = view.state !== 'idle';
  const pending = running && JSON.stringify(view.activeGraph) !== JSON.stringify(view.savedGraph);
  element('saved-state').textContent = pending ? 'Saved graph changed. This session keeps its active graph; changes apply on Start again.' : 'Saved graph applies on the next start.';
  const languages = translationLanguages(view.activeGraph ? view.displayDirection : view.translationDirection);
  element('session-direction').textContent = `${languages.source} → ${languages.target}${running ? ' · current session' : view.activeGraph ? ' · last session' : ' · saved for next session'}`;
  element('partial-source-label').textContent = `Provisional ${languages.source} original`;
  element('partial-target-label').textContent = `Provisional ${languages.target} translation`;
  element('final-source-label').textContent = `Full ${languages.source} original transcript`;
  element('final-pair-label').textContent = `Completed utterances · ${languages.source} original / ${languages.target} translation`;
  element('partial').lang = element('final').lang = languages.sourceCode;
  element('partial-english').lang = languages.targetCode;
  element('translation-status').textContent = view.translationStatus;
  element('partial-english').textContent = provisionalLabel(view.partial, view.interimTranslation, view.displayTranslationEnabled);
  element('partial-english').dataset.status = provisionalState(view.partial, view.interimTranslation, view.displayTranslationEnabled);
  element('provisional-translation').hidden = !view.displayTranslationEnabled;
  element('tts-output').hidden = !view.ttsStatus && !audioURLs.size;
  element('model-recovery').hidden = !/missing|evict|retry|unavailable/i.test(`${view.translationStatus} ${view.ttsStatus}`);
  element('cancel-session').disabled = !running;
  element('copy-final').disabled = !view.final.trim();
  element('empty-history').hidden = !!view.utterances.length;
  if (view.utterances !== renderedUtterances) {
    renderedUtterances = view.utterances;
    element('paired-finals').replaceChildren(...view.utterances.map((row, index) => {
      const entry = document.createElement('li'); entry.className = 'utterance';
      const pairLanguages = translationLanguages(row.direction);
      const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = `${index + 1} · Final · ${pairLanguages.source} original`;
      const original = document.createElement('pre'); original.textContent = row.source; original.lang = pairLanguages.sourceCode;
      original.setAttribute('aria-label', `${pairLanguages.source} original`);
      const translatedLabel = document.createElement('p'); translatedLabel.className = 'eyebrow'; translatedLabel.textContent = `${pairLanguages.target} translation`;
      const translated = document.createElement('pre'); translated.textContent = translationLabel(row); translated.lang = pairLanguages.targetCode; translated.dataset.status = row.status;
      translated.setAttribute('aria-label', `${pairLanguages.target} translation`);
      entry.append(label, original, translatedLabel, translated); return entry;
    }));
  }
  element('start').disabled = !!graphError || running || !!targetControls?.busy || !!targetControls?.pendingOutput || (!Number.isInteger(view.tabId) && !view.savedGraph.nodes.some(node => node.type === 'MicrophoneAudio'));
  element('stop').disabled = !['loading', 'starting', 'running'].includes(view.state);
  const nextState = JSON.stringify(graphState(view));
  if (!closed && nextState !== publishedState) { publishedState = nextState; stateChannel.postMessage(graphState(view)); }
}, { graph, onSynthesizedAudio: (audio, signal) => {
  if (signal.aborted) return;
  const url = URL.createObjectURL(audioToWav(audio)); audioURLs.add(url);
  const row = document.createElement('li'), player = document.createElement('audio'), link = document.createElement('a');
  player.controls = true; player.src = url; player.setAttribute('aria-label', 'Generated speech');
  link.href = url; link.download = 'speech.wav'; link.textContent = 'Download WAV';
  row.append(player, link); element('audio-outputs').append(row); session.update({ ttsStatus: 'Audio ready. Press Play to listen or download WAV.' });
} });
targetControls = new TargetControls(element('target-controls'), session);
function refreshSaved() {
  try { const next = readGraph(localStorage); graphError = ''; session.setGraph(next); return true; }
  catch (error) { graphError = `Saved graph unavailable: ${error.message}. Reset and Save in Graph Editor to recover.`; session.update(); return false; }
}
element('start').onclick = () => { clearAudio(); element('copy-status').textContent = ''; if (refreshSaved()) void session.start(session.view.tabId, { microphoneGesture: true }); };
element('stop').onclick = () => { void session.stop(); };
element('cancel-session').onclick = () => { session.cancel(); clearAudio(); session.update({ status: 'Canceled. Pending recognition and translation discarded.' }); };
element('copy-final').onclick = async () => {
  try { await navigator.clipboard.writeText(session.view.final); element('copy-status').textContent = 'Final original text copied.'; }
  catch { element('transcript-text').open = true; element('copy-status').textContent = 'Clipboard unavailable. Select and copy the full original transcript below.'; }
};
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'get-live-graph-state') { respond(graphState(session.view)); return; }
  if (message.type === 'invoke' && Number.isInteger(message.tabId) && !session.session) {
    clearAudio(); element('copy-status').textContent = '';
    if (targetControls.busy) { session.update({ targetStatus: 'Finish or cancel target selection before starting a session.' }); return; }
    if (targetControls.pendingOutput) { void targetControls.invokeOutput(message.tabId); return; }
    session.update({ tabId: message.tabId });
    if (refreshSaved()) void session.start(message.tabId);
  }
});
chrome.tabs.onRemoved.addListener(tabId => { targetControls.tabEnded(tabId); session.tabEnded(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') { targetControls.tabEnded(tabId); session.tabEnded(tabId); } });
window.addEventListener('pagehide', () => { targetControls.close(); session.cancel(); clearAudio(); closed = true; stateChannel.close(); });
window.addEventListener('error', event => session.fail(event.message));
window.addEventListener('unhandledrejection', event => session.fail(event.reason?.message || String(event.reason)));
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY && event.key !== null) return;
  refreshSaved();
});
const params = new URLSearchParams(location.search), tabId = params.has('tab') ? Number(params.get('tab')) : NaN;
if (params.has('error')) session.update({ error: params.get('error'), tabId });
else if (Number.isInteger(tabId)) { if (graphError) session.update({ tabId }); else { session.update({ tabId }); void session.start(tabId); } }
