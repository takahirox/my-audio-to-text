import { TabSession } from './session.js';
import { readLibrary, entryGraph } from './graph-library.js';
import { webVoiceGraph } from './web-voice-graph.js';
import { readVoiceEnabled } from './web-voice-preference.js';
import { acquireRuntimeLease } from './runtime-lease.js';

const port = chrome.runtime.connect({ name: 'web-voice-runtime' });
const label = document.getElementById('voice-state'), errorLabel = document.getElementById('voice-error'), stop = document.getElementById('voice-stop');
let session, ending = false, initialized = false, state = 'preparing', failure = '';
function publish(next, error = '') {
  state = next; label.textContent = { preparing: 'Preparing…', recording: 'Recording', stopping: 'Stopping…', error: 'Error' }[next];
  errorLabel.textContent = error;
  stop.textContent = next === 'recording' ? 'Stop' : 'Cancel';
  try { port.postMessage({ type: 'state', state: next, error }); } catch { void finish(true); }
}
async function finish(cancel = false, error = '') {
  if (ending) return;
  ending = true;
  // Freeze the snapshot for this one session. Stop must not prepare a new idle
  // graph; cancellation/close must never reacquire models or accept late output.
  if (session) {
    session.livePreparation = false;
    if (cancel) await session.close();
    else { publish('stopping'); await session.stop(); failure ||= session.view.error; await session.close(); }
  }
  try { port.postMessage({ type: 'ended', error: error || failure }); } catch {}
  window.close();
}
port.onDisconnect.addListener(() => { void finish(true); });
port.onMessage.addListener(message => {
  if (message.type === 'abort') { void finish(true, message.error); return; }
  if (message.type === 'stop') { void finish(state !== 'recording'); return; }
  if (message.type !== 'initialize' || initialized) return;
  initialized = true;
  void (async () => {
    if (message.stopRequested) return finish(true);
    if (!await readVoiceEnabled() || ending) throw Error('Web voice typing is OFF. Enable it in Graph Library.');
    const library = readLibrary(localStorage), entry = library.graphs.find(entry => entry.id === library.assignments.webVoice);
    if (!entry) throw Error('No Web voice graph assigned. Select one in Graph Library; Live is never substituted.');
    const snapshot = webVoiceGraph(entryGraph(entry));
    session = new TabSession(view => {
      if (ending) return;
      if (view.error) { failure = view.error.replaceAll('Retry models in Live', 'click the field mic to retry'); publish('error', failure); queueMicrotask(() => { void finish(true, failure); }); }
      else if (view.state === 'running') publish('recording');
      else if (view.state === 'stopping') publish('stopping');
      else publish('preparing');
    }, { graph: snapshot, graphId: entry.id, graphName: entry.name, acquireRuntime: acquireRuntimeLease,
      onSourceEnded: () => { void finish(true, 'Microphone ended or permission was removed. Click the mic to start a new session.'); } });
    session.outputTarget = structuredClone(message.target);
    await session.prepareModels();
    if (ending) return;
    if (session.view.modelState !== 'ready') throw Error(session.view.error || 'Models unavailable. Save the graph or open Models to recover cached files.');
    // The page mic click explicitly requested this getUserMedia call. A visible
    // extension document can present Chrome's native permission prompt; no
    // offscreen-prompt or service-worker DOM capability is assumed.
    await session.start(message.target.tabId, { microphoneGesture: true });
    if (!ending && session.view.state !== 'running') throw Error(session.view.error || 'Microphone could not start. Check Chrome microphone permission.');
  })().catch(error => { publish('error', error.message); void finish(true, error.message); });
});
stop.onclick = () => { void finish(state !== 'recording'); };
window.addEventListener('pagehide', () => { ending = true; void session?.close(); });
window.addEventListener('error', event => { void finish(true, event.message); });
window.addEventListener('unhandledrejection', event => { void finish(true, event.reason?.message || String(event.reason)); });
// Port traffic keeps the MV3 coordinator alive only while the explicit session
// owns resources. A disconnected coordinator always cancels this owner.
const heartbeat = setInterval(() => { try { port.postMessage({ type: 'heartbeat' }); } catch { clearInterval(heartbeat); void finish(true); } }, 20000);
