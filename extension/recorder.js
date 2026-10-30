import { TargetControls } from './target-controls.js';
import { TabSession } from './session.js';
import { renderTextRegions } from './live-text-regions.js';
import { readGraph, defaultGraph, GRAPH_KEY, INPUT_TYPES, FIELD_TYPES, executableGraph } from './graph.js';
import { audioToWav } from '../web/synthesized-audio.js';

const element = id => document.getElementById(id);
const stateChannel = new BroadcastChannel('live-graph-state');
let targetControls, targetRequired = false;
function renderNotices(view) {
  // Collapse known routine messages only; unfamiliar diagnostics stay visible.
  const routine = /^(?:[^:\n]+: )?(?:Translation (?:off|enabled for the next session|canceled)|Preparing local translation…|Local .+ ready|Audio signal detected\.|Loading .+…|.+ ready · (?:ja|en) · local)$/;
  for (const [id, text] of [['signal', view.signal], ['translation-status', view.translationStatus], ['summary-status', view.summaryStatus], ['condition-status', view.conditionStatus]]) {
    element(id).textContent = text;
    element(id).hidden = !text || (!element('diagnostics').open && text.split('\n').every(line => routine.test(line)));
  }
}
let graphError = '', graph, publishedState, closed = false;
try { graph = readGraph(localStorage); }
catch (error) { graphError = `Saved graph unavailable: ${error.message}${error.recoveryGraph ? ' Open Graph Editor to review and Save the migration draft.' : '. Reset and Save in Graph Editor to recover.'}`; graph = defaultGraph(); }
const audioURLs = new Set();
function clearAudio() {
  for (const player of element('audio-outputs').querySelectorAll('audio')) { player.pause(); player.removeAttribute('src'); player.load(); }
  for (const url of audioURLs) URL.revokeObjectURL(url);
  audioURLs.clear(); element('audio-outputs').replaceChildren();
}
function graphState(view) { return { graph: view.activeSavedGraph, state: view.state, tabId: view.tabId }; }
const session = new TabSession(view => {
  element('status').textContent = view.status;
  element('errors').textContent = graphError || view.error;
  const inputs = (view.state !== 'idle' ? view.activeGraph : view.savedGraph)?.nodes.filter(node => INPUT_TYPES.includes(node.type)) || [];
  element('tab-status').textContent = inputs.length ? inputs.map(node => `${node.id} · ${node.type === 'MicrophoneAudio' ? 'microphone' : `${node.type === 'SelectedPageMediaAudio' ? 'selected media in' : 'whole'} tab ${view.tabId ?? '(invoke toolbar)'}`}`).join('\n') : 'No active audio sources.';
  element('tts-status').textContent = view.ttsStatus;
  renderNotices(view);
  element('target-status').textContent = view.targetStatus;
  targetControls?.render();
  const current = view.state !== 'idle' ? view.activeGraph : view.savedGraph;
  const nextGraph = executableGraph(view.savedGraph);
  element('targets').hidden = !current.nodes.some(node => INPUT_TYPES.includes(node.type) || FIELD_TYPES.includes(node.type));
  const required = view.state === 'idle' && nextGraph.nodes.some(node => node.type === 'SelectedPageMediaAudio' && !targetControls?.session.targets[node.id]);
  if (required && !targetRequired) element('targets').open = true;
  targetRequired = required;
  const running = view.state !== 'idle';
  const pending = running && JSON.stringify(view.activeSavedGraph) !== JSON.stringify(view.savedGraph);
  element('saved-state').textContent = pending ? 'Saved graph changed. This session keeps its active graph; changes apply on Start.' : '';
  renderTextRegions(element('live-displays'), view.activeGraph || view.savedGraph, view.displays);
  element('no-live-displays').hidden = !!element('live-displays').children.length;
  const hasSpeaker = current.nodes.some(node => node.type === 'SpeakerOutput');
  element('speaker-hint').hidden = !hasSpeaker;
  element('speaker-status').textContent = view.speakerStatus;
  element('enable-speaker').hidden = !view.speakerNeedsActivation;
  element('tts-output').hidden = !view.ttsStatus && !audioURLs.size && !view.speakerStatus && !hasSpeaker;
  element('model-recovery').hidden = !/missing|evict|retry|unavailable/i.test(`${view.translationStatus} ${view.ttsStatus} ${view.conditionStatus} ${view.summaryStatus}`);
  element('cancel-session').disabled = !running;
  const needsTab = nextGraph.nodes.some(node => ['ChromeTabAudio', 'SelectedPageMediaAudio'].includes(node.type));
  element('start').disabled = !!graphError || running || !!targetControls?.busy || (needsTab && !Number.isInteger(view.tabId));
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
element('diagnostics').ontoggle = () => renderNotices(session.view);
session.update();
function refreshSaved() {
  try { const next = readGraph(localStorage); graphError = ''; session.setGraph(next); return true; }
  catch (error) { graphError = `Saved graph unavailable: ${error.message}${error.recoveryGraph ? ' Open Graph Editor to review and Save the migration draft.' : '. Reset and Save in Graph Editor to recover.'}`; session.update(); return false; }
}
element('start').onclick = () => { clearAudio(); if (refreshSaved()) void session.start(session.view.tabId, { microphoneGesture: true, speakerGesture: true }); };
element('enable-speaker').onclick = () => session.enableSpeakers();
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
