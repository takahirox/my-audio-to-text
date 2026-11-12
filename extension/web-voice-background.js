import { readVoiceEnabled, setVoiceEnabled, WEB_VOICE_KEY, WEB_VOICE_ORIGINS, voiceEnabled } from './web-voice-preference.js';
import { webVoiceChoices, webVoiceDefault } from './web-voice-graph.js';

const defaultKey = 'web-microphone-default-v1';
const launchRequests = new Map();
const libraryRequests = new Map(), hostWaiters = new Set();
let choices = [], defaultId = null, selectionWork = Promise.resolve();
const scriptId = 'web-voice-typing';
const controls = new Set();
// One offscreen DOM document, with an independent TabSession per page document.
const sessions = new Map();
let reconciling = Promise.resolve(), host, hostURL, lifecycle = Promise.resolve();
const post = (port, message) => { try { port?.postMessage(message); } catch {} };
const extensionPage = (sender, name) => sender?.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(`extension/${name}`);
const authorized = async () => await readVoiceEnabled() && await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS });
const current = owner => sessions.get(owner.target.documentId) === owner;
const runtimePost = (owner, message) => post(host, { ...message, token: owner.token });
function serialize(operation) { return lifecycle = lifecycle.catch(() => {}).then(operation); }
async function closeDocument() {
  hostURL = null;
  const previous = host; host = null; previous?.disconnect();
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.some(context => context.documentUrl?.split(/[?#]/)[0] === chrome.runtime.getURL('extension/web-voice-runtime.html'))) await chrome.offscreen.closeDocument();
}
function idleCleanup() {
  void serialize(async () => { if (!sessions.size && !libraryRequests.size && !hostWaiters.size && !launchRequests.size) await closeDocument(); }).catch(() => {});
}
function end(owner, reason = '') {
  if (!owner || !current(owner)) return;
  sessions.delete(owner.target.documentId); clearTimeout(owner.timer);
  post(owner.control, { type: 'ended', error: reason });
  runtimePost(owner, { type: 'abort', error: reason });
  owner.output?.disconnect(); owner.relay?.disconnect();
  idleCleanup();
}
function cancelSession(owner, reason) {
  if (!current(owner)) return;
  if (!owner.initialized) { end(owner, reason); return; }
  owner.stopRequested = true; owner.cancelError = reason;
  runtimePost(owner, { type: 'abort', error: reason });
  post(owner.control, { type: 'state', state: 'stopping', error: reason });
}
function endAll(reason) { for (const owner of sessions.values()) end(owner, reason); }
function initialize(owner) {
  if (!current(owner) || !owner.graph || owner.initialized || !host) return;
  owner.initialized = true; clearTimeout(owner.timer);
  runtimePost(owner, { type: 'initialize', target: owner.target, stopRequested: owner.stopRequested === true, graph: owner.graph });
}
async function ensureRuntime(owner) {
  await serialize(async () => {
    if (owner && !current(owner)) return;
    if (!hostURL) {
      hostURL = chrome.runtime.getURL(`extension/web-voice-runtime.html#${crypto.randomUUID()}`);
      try {
        await chrome.offscreen.createDocument({ url: hostURL, reasons: ['WORKERS', 'LOCAL_STORAGE'],
          justification: 'Run explicitly requested local Web dictation with independently owned page PCM source, graph and model Workers.' });
      } catch (error) { hostURL = null; throw error; }
    }
    if (owner) initialize(owner);
  });
}
// Share the offscreen lifecycle; a toolbar read must never close a Web session.
export function requestLaunchLibrary(operation, id) {
  const request = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, result) => {
      const pending = launchRequests.get(request);
      if (!pending) return;
      clearTimeout(pending.timer); launchRequests.delete(request);
      if (error) reject(Error(error)); else resolve(result);
      idleCleanup();
    };
    const pending = { dispatch() { if (host && !this.sent) { this.sent = true; post(host, this.message); } }, message: { type: 'launch-library', request, operation, id }, finish,
      timer: setTimeout(() => finish('Graph Library did not respond. Reopen the toolbar to retry.'), 15000) };
    launchRequests.set(request, pending);
    void ensureRuntime().then(() => { if (launchRequests.has(request)) pending.dispatch(); }, error => finish(error.message));
  });
}
// Read canonical localStorage in the offscreen DOM. This never queries mic
// permission, creates a TabSession, loads a model or starts capture.
async function readVoiceLibrary() {
  const request = crypto.randomUUID();
  let timer;
  const response = new Promise((resolve, reject) => {
    timer = setTimeout(() => { libraryRequests.delete(request); reject(Error('Graph library did not respond. Click the mic to retry.')); idleCleanup(); }, 20000);
    libraryRequests.set(request, { resolve, reject, timer });
  });
  try {
    await ensureRuntime();
    if (!host) await new Promise((resolve, reject) => {
      const waiter = { resolve, reject }; hostWaiters.add(waiter);
      response.catch(error => { if (hostWaiters.delete(waiter)) reject(error); });
    });
    post(host, { type: 'library-read', request });
    return await response;
  } finally { clearTimeout(timer); libraryRequests.delete(request); idleCleanup(); }
}
function catalog(port) { post(port, { type: 'graphs', graphs: choices.map(({ id, name }) => ({ id, name })), defaultId }); }
function refreshChoices(selectId, canSelect = () => true) {
  // Serialize preference writes only. Graph sessions remain independent.
  return selectionWork = selectionWork.catch(() => {}).then(async () => {
    const library = await readVoiceLibrary();
    const next = webVoiceChoices(library);
    const saved = (await chrome.storage.local.get(defaultKey))[defaultKey];
    let id = webVoiceDefault(next, saved, library.assignments.webVoice);
    if (selectId !== undefined) {
      if (!canSelect()) return;
      if (!next.some(choice => choice.id === selectId)) throw Error('Graph is no longer compatible. Choose another graph.');
      id = selectId;
    }
    if (id !== saved) await chrome.storage.local.set({ [defaultKey]: id });
    choices = next; defaultId = id;
    for (const port of controls) catalog(port);
    return next.find(choice => choice.id === id);
  });
}
function refreshCatalog() {
  void authorized().then(ok => ok && refreshChoices()).catch(error => {
    console.warn('Web graph catalog:', error.message);
    choices = []; defaultId = null; for (const port of controls) catalog(port);
  });
}
function reconcile(stop = false) {
  if (stop) {
    // A Library OFF/rollback write can fail. Release active capture without
    // waiting for storage or queued registration work, even in that case.
    endAll('Web voice typing stopped. Retry saving OFF in Graph Library.');
    for (const port of controls) post(port, { type: 'disabled' });
  }
  return reconciling = reconciling.catch(() => {}).then(async () => {
    const enabled = !stop && await authorized();
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] })).length;
    if (!enabled) {
      endAll('Web voice typing disabled or website permission removed.');
      for (const port of controls) post(port, { type: 'disabled' });
      if (registered) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
      // An earlier OFF snapshot may finish after the switch grants access and
      // saves ON. Clear opt-in only if website access is still actually missing.
      if (!stop && await readVoiceEnabled() && !await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS })) await setVoiceEnabled(false);
      return;
    }
    if (!registered) await chrome.scripting.registerContentScripts([{ id: scriptId, matches: WEB_VOICE_ORIGINS,
      js: ['extension/web-voice-capture.js', 'extension/web-voice-content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: false }]);
    // Registration handles future navigations; existing authorized tabs need an
    // explicit one-time install. No query/injection runs for an OFF user.
    const tabs = await chrome.tabs.query({ url: WEB_VOICE_ORIGINS });
    await Promise.allSettled(tabs.map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
      files: ['extension/web-voice-capture.js', 'extension/web-voice-content.js'], world: 'ISOLATED' })));
  });
}
chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name === 'web-voice-control') {
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || !sender.documentId || !/^https?:\/\//.test(sender.url || '')) { port.disconnect(); return; }
    const owner = { tabId: sender.tab.id, documentId: sender.documentId, valid: false };
    controls.add(port);
    void authorized().then(ok => {
      if (!controls.has(port)) return;
      owner.valid = ok; post(port, { type: ok ? 'enabled' : 'disabled' });
      if (ok) refreshCatalog();
    });
    port.onDisconnect.addListener(() => {
      controls.delete(port);
      const session = sessions.get(owner.documentId);
      if (session?.control === port) end(session, 'Target page disconnected.');
    });
    port.onMessage.addListener(message => {
      const existing = sessions.get(owner.documentId);
      if (message.type === 'pcm') {
        if (!existing || existing.control !== port || existing.stopRequested || !existing.recording || message.capability !== existing.target.capability) return;
        if (message.sequence !== (existing.sequence || 0) || typeof message.pcm !== 'string' || !message.pcm.length || message.pcm.length > 6828 ||
            (existing.sequence || 0) - (existing.acknowledged || 0) >= 8) { cancelSession(existing, 'Invalid or overloaded microphone audio relay. Click the mic to retry.'); return; }
        existing.sequence = message.sequence + 1;
        runtimePost(existing, { type: 'pcm', sequence: message.sequence, pcm: message.pcm, capturedAt: message.capturedAt }); return;
      }
      if (message.type === 'cancel' && existing?.control === port) { cancelSession(existing, message.error || 'Voice typing canceled.'); return; }
      if (message.type === 'stop' && existing?.control === port) {
        existing.stopRequested = true; runtimePost(existing, { type: 'stop' });
        post(port, { type: 'state', state: 'stopping' }); return;
      }
      if (message.type === 'select-graph' && owner.valid && !existing && typeof message.id === 'string') {
        void (async () => {
          if (!await authorized()) return;
          const selected = await refreshChoices(message.id, () => !sessions.has(owner.documentId) && controls.has(port));
          if (selected) post(port, { type: 'selection-saved' });
        })().catch(error => post(port, { type: 'selection-error', error: error.message }));
        return;
      }
      if (message.type !== 'start' || !owner.valid || typeof message.capability !== 'string' || message.capability.length !== 36) return;
      if (existing) {
        if (existing.control !== port) post(port, { type: 'ended', error: 'Voice typing already active in this document.' });
        return;
      }
      const session = { control: port, token: crypto.randomUUID(), target: { tabId: owner.tabId, documentId: owner.documentId,
        frameId: 0, portName: 'web-voice-output', capability: message.capability, label: 'Selected Web voice field' } };
      sessions.set(owner.documentId, session);
      session.timer = setTimeout(() => end(session, 'Voice runtime did not respond. Click the mic to retry.'), 20000);
      void (async () => {
        if (!await authorized()) throw Error('Enable Web voice typing and grant website access in Graph Library.');
        const selected = await refreshChoices();
        if (!selected) throw Error('Right-click the mic (or press Shift+F10) to choose a voice graph first.');
        session.graph = structuredClone(selected);
        if (current(session)) await ensureRuntime(session);
      })().catch(error => end(session, error.message));
    });
    return;
  }
  // Offscreen has runtime APIs only. Bind every relay to both the authenticated
  // offscreen generation and a current session, never a caller-supplied tab.
  if (port.name === 'web-voice-host') {
    if (!hostURL || sender?.id !== chrome.runtime.id || sender.url !== hostURL || host) { port.disconnect(); return; }
    host = port;
    for (const waiter of hostWaiters) waiter.resolve();
    hostWaiters.clear();
    for (const pending of launchRequests.values()) pending.dispatch();
    for (const owner of sessions.values()) initialize(owner);
    port.onMessage.addListener(message => {
      if (host !== port) return;
      if (message.type === 'launch-library-result') { launchRequests.get(message.request)?.finish(message.error, message.result); return; }
      if (message.type === 'library') {
        const pending = libraryRequests.get(message.request);
        if (pending) {
          clearTimeout(pending.timer); libraryRequests.delete(message.request);
          if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.library);
        }
        return;
      }
      if (message.type === 'library-changed') { refreshCatalog(); return; }
      if (message.type === 'heartbeat') { post(port, { type: 'heartbeat' }); return; }
      const owner = [...sessions.values()].find(owner => owner.token === message.token);
      if (!owner) return;
      if (message.type === 'pcm-ack') {
        if (message.sequence !== (owner.acknowledged || 0) || message.sequence >= (owner.sequence || 0)) { cancelSession(owner, 'Invalid microphone audio acknowledgment.'); return; }
        owner.acknowledged = message.sequence + 1; post(owner.control, { type: 'pcm-ack', sequence: message.sequence, capability: owner.target.capability }); return;
      }
      if (message.type === 'state' && message.state === 'recording') owner.recording = true;
      if (message.type === 'state' && ['preparing', 'recording', 'stopping', 'error'].includes(message.state)) post(owner.control, message);
      if (message.type === 'ended') end(owner, message.error || owner.cancelError || '');
    });
    port.onDisconnect.addListener(() => {
      if (host !== port) return;
      for (const pending of libraryRequests.values()) { clearTimeout(pending.timer); pending.reject(Error('Graph library disconnected. Click the mic to retry.')); }
      libraryRequests.clear();
      host = null;
      for (const pending of launchRequests.values()) pending.finish('Graph Library disconnected. Reopen the toolbar to retry.');
      endAll('Voice runtime disconnected. Click the mic to retry.');
      // Invalidate this generation even if a retry reserves a new session before
      // idle cleanup runs. A disconnected host must never be reused.
      void serialize(closeDocument).catch(() => {});
    });
    return;
  }
  if (port.name.startsWith('web-voice-output:')) {
    const owner = [...sessions.values()].find(owner => port.name === `web-voice-output:${owner.token}`);
    if (!host || sender?.id !== chrome.runtime.id || sender.url !== hostURL || !owner || owner.output) { port.disconnect(); return; }
    owner.output = port;
    const relay = owner.relay = chrome.tabs.connect(owner.target.tabId, { name: owner.target.portName, documentId: owner.target.documentId });
    port.onMessage.addListener(message => { if (current(owner)) post(relay, message); });
    relay.onMessage.addListener(message => { if (current(owner)) post(port, message); });
    relay.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (current(owner)) { port.disconnect(); if (!owner.stopRequested) cancelSession(owner, 'Output connection lost. Click the mic to retry.'); }
    });
    port.onDisconnect.addListener(() => { relay.disconnect(); });
    return;
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'web-voice-library-changed' && sender?.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('extension/'))) {
    refreshCatalog(); respond({ ok: true }); return;
  }
  if (message.type !== 'web-voice-reconcile' || !extensionPage(sender, 'graph-library.html')) return;
  void reconcile(message.stop === true).then(() => respond({ ok: true }), error => respond({ error: error.message })); return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[WEB_VOICE_KEY]) return;
  // OFF aborts immediately, before serialized registration work completes.
  if (!voiceEnabled(changes[WEB_VOICE_KEY].newValue)) {
    endAll('Web voice typing disabled.');
    for (const port of controls) post(port, { type: 'disabled' });
  }
  void reconcile().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => { endAll('Website access removed.'); void reconcile().catch(() => {}); });
chrome.tabs.onRemoved.addListener(id => {
  for (const owner of sessions.values()) if (owner.target.tabId === id) end(owner, 'Target tab closed.');
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading') for (const owner of sessions.values()) if (owner.target.tabId === id) end(owner, 'Target page navigated.');
});
// A restarted coordinator never adopts unknown capture. Closing its old DOM
// owner releases all tracks/Workers before a new generation can be created.
void serialize(closeDocument).catch(() => {});
void reconcile().catch(() => {});
