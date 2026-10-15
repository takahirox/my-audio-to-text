import { TargetControls } from './target-controls.js';
import { TabSession } from './session.js';
import { renderTextRegions } from './live-text-regions.js';
import { readGraph, defaultGraph, GRAPH_KEY, INPUT_TYPES } from './graph.js';
import { audioToWav } from '../web/synthesized-audio.js';

const element = id => document.getElementById(id);
const stateChannel = new BroadcastChannel('live-graph-state');
let targetControls;
let graphError = '', graph, publishedState, closed = false;
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
  for (const id of ['status', 'signal']) element(id).textContent = view[id];
  element('errors').textContent = graphError || view.error;
  const input = (view.state !== 'idle' ? view.activeGraph : view.savedGraph)?.nodes.find(node => INPUT_TYPES.includes(node.type));
  element('tab-status').textContent = input?.type === 'MicrophoneAudio' ? 'Capture target · microphone' : Number.isInteger(view.tabId) ? `Capture target · ${input?.type === 'SelectedPageMediaAudio' ? 'selected media in' : 'whole'} tab ${view.tabId}` : 'Invoke the toolbar action on a tab.';
  element('tts-status').textContent = view.ttsStatus;
  element('target-status').textContent = view.targetStatus;
  targetControls?.render();
  const running = view.state !== 'idle';
  const pending = running && JSON.stringify(view.activeGraph) !== JSON.stringify(view.savedGraph);
  element('saved-state').textContent = pending ? 'Saved graph changed. This session keeps its active graph; changes apply on Start.' : '';
  element('translation-status').hidden = !view.translationStatus || view.translationStatus === 'Translation off';
  renderTextRegions(element('live-displays'), view.activeGraph || view.savedGraph, view.displays);
  element('translation-status').textContent = view.translationStatus;
  element('no-live-displays').hidden = !!element('live-displays').children.length;
  element('tts-output').hidden = !view.ttsStatus && !audioURLs.size;
  element('model-recovery').hidden = !/missing|evict|retry|unavailable/i.test(`${view.translationStatus} ${view.ttsStatus}`);
  element('cancel-session').disabled = !running;
  element('start').disabled = !!graphError || running || !!targetControls?.busy || (!Number.isInteger(view.tabId) && !view.savedGraph.nodes.some(node => node.type === 'MicrophoneAudio'));
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
element('start').onclick = () => { clearAudio(); if (refreshSaved()) void session.start(session.view.tabId, { microphoneGesture: true }); };
element('stop').onclick = () => { void session.stop(); };
element('cancel-session').onclick = () => { session.cancel(); clearAudio(); session.update({ status: 'Canceled. Pending processing discarded.' }); };
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'get-live-graph-state') { respond(graphState(session.view)); return; }
  if (message.type === 'invoke' && Number.isInteger(message.tabId) && !session.session) {
    void invokeTab(message.tabId).then(() => respond?.({ prepared: true }));
    return true;
  }
});
chrome.tabs.onRemoved.addListener(tabId => { targetControls.tabEnded(tabId); session.tabEnded(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') { targetControls.tabEnded(tabId); session.tabEnded(tabId); } });
window.addEventListener('pagehide', () => { session.cancel(); clearAudio(); closed = true; stateChannel.close(); });
window.addEventListener('error', event => session.fail(event.message));
window.addEventListener('unhandledrejection', event => session.fail(event.reason?.message || String(event.reason)));
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY && event.key !== null) return;
  refreshSaved();
});
async function invokeTab(tabId) {
  if (targetControls.busy) return;
  clearAudio();
  session.update({ tabId });
  if (!refreshSaved()) return;
  await targetControls.prepareFocusedOutput(tabId);
  if (!closed && !session.session) void session.start(tabId);
}
const params = new URLSearchParams(location.search), tabId = params.has('tab') ? Number(params.get('tab')) : NaN;
if (params.has('error')) session.update({ error: params.get('error'), tabId });
else if (Number.isInteger(tabId)) {
  // New Live windows open unfocused so tracking is prepared before a page
  // editor can blur on window deactivation. Reused windows do this in background.
  void invokeTab(tabId).then(async () => {
    if (!closed) { const live = await chrome.windows.getCurrent(); await chrome.windows.update(live.id, { focused: true }); }
  });
}
