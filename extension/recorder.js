import { TabSession } from './session.js';
import { renderTextRegions } from './live-text-regions.js';
import { readGraph, defaultGraph, GRAPH_KEY, INPUT_TYPES, executableGraph } from './graph.js';
import { audioToWav } from '../web/synthesized-audio.js';

const element = id => document.getElementById(id);
const stateChannel = new BroadcastChannel('live-graph-state');
function renderDiagnostics(view) {
  for (const [id, text] of [['signal', view.signal], ['translation-status', view.translationStatus], ['summary-status', view.summaryStatus], ['condition-status', view.conditionStatus], ['hold-status', view.holdStatus], ['tts-status', view.ttsStatus], ['speaker-status', view.speakerStatus], ['output-status', view.outputStatus]]) {
    element(id).textContent = text;
  }
}
let graphError = '', graph, publishedState, closed = false;
try { graph = readGraph(localStorage); }
catch (error) { graphError = `Saved graph unavailable: ${error.message}`; graph = defaultGraph(); }
const audioURLs = new Set();
function clearAudio() {
  for (const player of element('audio-outputs').querySelectorAll('audio')) { player.pause(); player.removeAttribute('src'); player.load(); }
  for (const url of audioURLs) URL.revokeObjectURL(url);
  audioURLs.clear(); element('audio-outputs').replaceChildren();
}
function renderGraphActions(view) {
  const container = element('graph-action-buttons'), actions = view.graphActions || [];
  element('graph-action-area').hidden = !actions.length;
  const byId = new Map([...container.children].map(button => [button.dataset.nodeId, button]));
  for (const [index, action] of actions.entries()) {
    let button = byId.get(action.id);
    if (!button) { button = document.createElement('button'); button.type = 'button'; button.dataset.nodeId = action.id; }
    button.textContent = action.label; button.disabled = action.disabled;
    button.title = `${action.id}${action.reason ? ': ' + action.reason : ''}`;
    if (action.reason) button.setAttribute('aria-description', action.reason);
    else button.removeAttribute('aria-description');
    button.onclick = () => { void action.invoke(); };
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
    byId.delete(action.id);
  }
  for (const button of byId.values()) button.remove();
  element('graph-action-status').textContent = [...new Set(actions.map(action => action.reason).filter(Boolean))].join(' ');
}
function graphState(view) { return { graph: view.activeSavedGraph, state: view.state, tabId: view.tabId }; }
const session = new TabSession(view => {
  renderGraphActions(view);
  // Use the existing lifecycle and terminal status; never infer recording from
  // the presence of text or a configured model. Errors can coexist with capture.
  const state = view.state === 'idle' && (graphError || view.error) ? 'error' : view.state === 'idle'
    ? (/^Canceled\./.test(view.status) ? 'canceled' : /^Stopped[. ]/.test(view.status) ? 'completed' : 'idle') : view.state;
  const labels = { idle: 'Idle', loading: 'Loading', starting: 'Starting', running: view.status === 'Transcription active' ? 'Recording' : 'Running', stopping: 'Stopping', completed: 'Completed', canceled: 'Canceled', error: 'Error' };
  element('session-state').textContent = labels[state];
  element('session-state').dataset.state = state;
  element('model-status').textContent = view.state === 'idle' ? (view.modelStatus || '') : '';
  element('retry-models').hidden = !['error', 'canceled'].includes(view.modelState);
  element('status').textContent = view.status;
  element('session-prompt').textContent = view.prompt;
  element('errors').textContent = graphError || view.error;
  const inputs = (view.state !== 'idle' ? view.activeGraph : view.savedGraph)?.nodes.filter(node => INPUT_TYPES.includes(node.type)) || [];
  element('tab-status').textContent = inputs.length ? inputs.map(node => `${node.id} · ${node.type === 'MicrophoneAudio' ? 'microphone' : `${node.type === 'SelectedPageMediaAudio' ? 'selected media in' : 'whole'} tab ${view.tabId ?? '(invoke toolbar)'}`}`).join('\n') : 'No active audio sources.';
  renderDiagnostics(view);
  const current = view.state !== 'idle' ? view.activeGraph : view.savedGraph;
  const nextGraph = executableGraph(view.savedGraph);
  const running = view.state !== 'idle';
  const pending = running && JSON.stringify(view.activeSavedGraph) !== JSON.stringify(view.savedGraph);
  element('saved-state').textContent = pending ? 'Saved graph changed. This session keeps its active graph; changes apply on Start.' : '';
  renderTextRegions(element('live-displays'), view.activeGraph || nextGraph, view.displays);
  element('no-live-displays').hidden = !!element('live-displays').children.length;
  const hasSpeaker = current.nodes.some(node => ['SpeakerOutput', 'StreamingSpeakerOutput'].includes(node.type));
  element('speaker-hint').hidden = !hasSpeaker;
  element('enable-speaker').hidden = !view.speakerNeedsActivation;
  element('tts-output').hidden = !audioURLs.size && !hasSpeaker;
  element('model-recovery').hidden = !view.modelRecovery;
  const needsTab = nextGraph.nodes.some(node => node.type === 'ChromeTabAudio');
  element('start').disabled = !!graphError || running || view.modelState !== 'ready' || view.preparingOutput || (needsTab && !Number.isInteger(view.tabId));
  element('stop').disabled = view.modelState !== 'preparing' && !['loading', 'starting', 'running'].includes(view.state);
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
session.update();
if (!graphError) void session.prepareModels();
function refreshSaved() {
  try {
    const next = readGraph(localStorage); graphError = ''; session.setGraph(next);
    if (!session.livePreparation) void session.prepareModels();
    return true;
  }
  catch (error) {
    graphError = `Saved graph unavailable: ${error.message}`;
    if (!session.session && session.prepared) session.preparationFailed(session.prepared, error);
    session.update(); return false;
  }
}
element('start').onclick = () => { clearAudio(); if (refreshSaved()) void session.start(session.view.tabId, { microphoneGesture: true, speakerGesture: true }); };
element('enable-speaker').onclick = () => session.enableSpeakers();
element('retry-models').onclick = () => { if (refreshSaved()) void session.prepareModels(); };
element('stop').onclick = () => { void session.stop(); };
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message.type === 'get-live-graph-state') { respond(graphState(session.view)); return; }
  if (message.type === 'invoke' && Number.isInteger(message.tabId) && !session.session) {
    void invokeTab(message.tabId).then(() => respond?.({ prepared: true }));
    return true;
  }
});
chrome.tabs.onRemoved.addListener(tabId => { session.tabEnded(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === 'loading') { session.tabEnded(tabId); } });
window.addEventListener('pagehide', () => { closed = true; void session.close(); clearAudio(); stateChannel.close(); });
window.addEventListener('error', event => session.fail(event.message));
window.addEventListener('unhandledrejection', event => session.fail(event.reason?.message || String(event.reason)));
window.addEventListener('storage', event => {
  if (event.key !== GRAPH_KEY && event.key !== null) return;
  refreshSaved();
});
async function invokeTab(tabId) {
  if (session.view.preparingOutput) return;
  clearAudio();
  session.update({ tabId });
  if (!refreshSaved()) return;
  await session.prepareFocusedOutput(tabId);
  // Toolbar invocation selects the target. Capture and permission requests
  // remain tied to the explicit Start button after model readiness.
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
