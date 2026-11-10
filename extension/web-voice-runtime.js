import { TabSession } from './session.js';
import { PageConnection } from './page-target.js';
import { readLibrary, resolvedEntryGraph } from './graph-library.js';
import { webVoiceGraph } from './web-voice-graph.js';

// Chrome permits one offscreen document per profile. Only this inert host is
// shared: every owner has its own graph, models, tracks and output connection.
const port = chrome.runtime.connect({ name: 'web-voice-host' });
const owners = new Map();
let disconnected = false, lastHeartbeat = Date.now();
function send(owner, message) {
  if (disconnected) return;
  try { port.postMessage({ ...message, token: owner.token }); }
  catch { disconnect(); }
}
function publish(owner, state, error = '') {
  owner.state = state;
  send(owner, { type: 'state', state, error });
}
async function finish(owner, cancel = false, error = '') {
  if (owner.ending) {
    // Navigation/OFF can interrupt a graceful drain while peers keep this DOM
    // alive. Cancellation must still release this owner's tracks and Workers.
    if (cancel && !owner.canceling) { owner.canceling = true; void owner.session?.close().catch(() => {}); }
    return;
  }
  owner.ending = true; owner.canceling = cancel;
  owner.permission?.removeEventListener('change', owner.permissionChanged);
  owner.resumePermission?.();
  try {
    if (owner.session) {
      owner.session.livePreparation = false;
      if (!cancel) { publish(owner, 'stopping'); await owner.session.stop(); owner.failure ||= owner.session.view.error; }
      await owner.session.close();
    }
  } catch (failure) {
    error ||= failure.message;
    await owner.session?.close().catch(() => {});
  } finally {
    owners.delete(owner.token);
    send(owner, { type: 'ended', error: error || owner.failure || '' });
  }
}
async function start(owner, target) {
  try {
    const library = readLibrary(localStorage), entry = library.graphs.find(entry => entry.id === library.assignments.webVoice);
    if (!entry) throw Error('No Web voice graph assigned. Select one in Graph Library; Live is never substituted.');
    // Snapshot before awaiting permission or models; Library edits are future-only.
    const snapshot = webVoiceGraph(resolvedEntryGraph(entry, library));
    const permission = owner.permission = await navigator.permissions.query({ name: 'microphone' });
    if (owner.ending) return;
    if (permission.state === 'prompt') {
      const ready = new Promise(resolve => { owner.resumePermission = resolve; });
      send(owner, { type: 'permission-needed' });
      await ready;
    }
    if (owner.ending) return;
    if (permission.state !== 'granted') throw Error('Microphone permission is blocked. Allow this extension in Chrome microphone settings, then click the field mic to retry.');
    owner.permissionChanged = () => {
      if (permission.state !== 'granted') void finish(owner, true, 'Microphone permission removed. Allow it in Chrome settings and click the field mic to retry.');
    };
    permission.addEventListener('change', owner.permissionChanged);
    owner.session = new TabSession(view => {
      if (owner.ending) return;
      if (view.error) {
        owner.failure = view.error.replaceAll('Retry models in Live', 'click the field mic to retry');
        publish(owner, 'error', owner.failure);
        queueMicrotask(() => { void finish(owner, true, owner.failure); });
      } else publish(owner, view.state === 'running' ? 'recording' : view.state === 'stopping' ? 'stopping' : 'preparing');
    }, { graph: snapshot, graphId: entry.id, graphName: entry.name,
      pageConnectionFactory: (target, onEvent) => new PageConnection(target, onEvent,
        chrome.runtime.connect({ name: `web-voice-output:${owner.token}` })),
      onSourceEnded: () => { void finish(owner, true, 'Microphone ended or permission was removed. Click the mic to start a new session.'); } });
    owner.session.outputTarget = structuredClone(target);
    await owner.session.prepareModels();
    if (owner.ending) return;
    if (owner.session.view.modelState !== 'ready') throw Error(owner.session.view.error || 'Models unavailable. Save the graph or open Models to recover cached files.');
    // Permission was already granted, either previously or in the setup page.
    // The explicit field click authorizes capture; offscreen never prompts.
    await owner.session.start(target.tabId, { microphoneGesture: true });
    if (!owner.ending && owner.session.view.state !== 'running') throw Error(owner.session.view.error || 'Microphone could not start. Check Chrome microphone permission.');
  } catch (error) {
    if (!owner.ending) { publish(owner, 'error', error.message); await finish(owner, true, error.message); }
  }
}
port.onMessage.addListener(message => {
  if (message.type === 'heartbeat') { lastHeartbeat = Date.now(); return; }
  const owner = owners.get(message.token);
  if (message.type === 'abort' && owner) { void finish(owner, true, message.error); return; }
  if (message.type === 'stop' && owner) { void finish(owner, owner.state !== 'recording'); return; }
  if (message.type === 'permission-ready' && owner) { owner.resumePermission?.(); return; }
  if (message.type !== 'initialize' || owner || disconnected) return;
  if (message.stopRequested) { send({ token: message.token }, { type: 'ended' }); return; }
  const next = { token: message.token, state: 'preparing' };
  owners.set(next.token, next);
  void start(next, message.target);
});
function disconnect() {
  if (disconnected) return;
  disconnected = true; clearInterval(heartbeat);
  for (const owner of owners.values()) void finish(owner, true);
  // Invalidated coordinator generations can never reconnect or resume output.
  try { port.disconnect(); } catch {}
}
port.onDisconnect.addListener(disconnect);
window.addEventListener('pagehide', disconnect);
window.addEventListener('error', event => { for (const owner of owners.values()) void finish(owner, true, event.message); });
window.addEventListener('unhandledrejection', event => { for (const owner of owners.values()) void finish(owner, true, event.reason?.message || String(event.reason)); });
// Traffic keeps the MV3 coordinator alive while its DOM owner exists. An ack
// watchdog also releases capture if a coordinator disappears without a callback.
const heartbeat = setInterval(() => {
  if (Date.now() - lastHeartbeat > 65000) { disconnect(); return; }
  try { port.postMessage({ type: 'heartbeat' }); } catch { disconnect(); }
}, 20000);
