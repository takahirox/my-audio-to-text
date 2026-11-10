import { readVoiceEnabled, setVoiceEnabled, WEB_VOICE_KEY, WEB_VOICE_ORIGINS, voiceEnabled } from './web-voice-preference.js';

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
  void serialize(async () => { if (!sessions.size) await closeDocument(); }).catch(() => {});
}
function end(owner, reason = '') {
  if (!owner || !current(owner)) return;
  sessions.delete(owner.target.documentId); clearTimeout(owner.timer);
  post(owner.control, { type: 'ended', error: reason });
  runtimePost(owner, { type: 'abort', error: reason });
  owner.output?.disconnect(); owner.relay?.disconnect();
  if (owner.setupTab) void chrome.tabs.remove(owner.setupTab).catch(() => {});
  idleCleanup();
}
function endAll(reason) { for (const owner of sessions.values()) end(owner, reason); }
function initialize(owner) {
  if (!current(owner) || owner.initialized || !host) return;
  owner.initialized = true; clearTimeout(owner.timer);
  runtimePost(owner, { type: 'initialize', target: owner.target, stopRequested: owner.stopRequested === true });
}
async function ensureRuntime(owner) {
  await serialize(async () => {
    if (!current(owner)) return;
    if (!hostURL) {
      hostURL = chrome.runtime.getURL(`extension/web-voice-runtime.html#${crypto.randomUUID()}`);
      try {
        await chrome.offscreen.createDocument({ url: hostURL, reasons: ['USER_MEDIA', 'WORKERS', 'LOCAL_STORAGE'],
          justification: 'Run explicitly requested local Web dictation with independently owned microphone, graph and model Workers.' });
      } catch (error) { hostURL = null; throw error; }
    }
    initialize(owner);
  });
}
async function permissionSetup(owner) {
  if (!current(owner) || owner.setupPending) return;
  owner.setupPending = true;
  post(owner.control, { type: 'state', state: 'preparing', error: 'Complete the one-time microphone permission setup, or click this mic to cancel.' });
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`extension/web-voice-permission.html#${owner.token}`), active: true });
  if (current(owner)) owner.setupTab = tab.id;
  else await chrome.tabs.remove(tab.id);
}
function reconcile() {
  return reconciling = reconciling.catch(() => {}).then(async () => {
    const enabled = await authorized();
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] })).length;
    if (!enabled) {
      endAll('Web voice typing disabled or website permission removed.');
      for (const port of controls) post(port, { type: 'disabled' });
      if (registered) await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
      if (await readVoiceEnabled()) await setVoiceEnabled(false);
      return;
    }
    if (!registered) await chrome.scripting.registerContentScripts([{ id: scriptId, matches: WEB_VOICE_ORIGINS,
      js: ['extension/web-voice-content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: false }]);
    // Registration handles future navigations; existing authorized tabs need an
    // explicit one-time install. No query/injection runs for an OFF user.
    const tabs = await chrome.tabs.query({ url: WEB_VOICE_ORIGINS });
    await Promise.allSettled(tabs.map(tab => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] },
      files: ['extension/web-voice-content.js'], world: 'ISOLATED' })));
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
    });
    port.onDisconnect.addListener(() => {
      controls.delete(port);
      const session = sessions.get(owner.documentId);
      if (session?.control === port) end(session, 'Target page disconnected.');
    });
    port.onMessage.addListener(message => {
      const existing = sessions.get(owner.documentId);
      if (message.type === 'cancel' && existing?.control === port) { end(existing, message.error || 'Voice typing canceled.'); return; }
      if (message.type === 'stop' && existing?.control === port) {
        existing.stopRequested = true; runtimePost(existing, { type: 'stop' });
        post(port, { type: 'state', state: 'stopping' }); return;
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
    for (const owner of sessions.values()) initialize(owner);
    port.onMessage.addListener(message => {
      if (host !== port) return;
      if (message.type === 'heartbeat') { post(port, { type: 'heartbeat' }); return; }
      const owner = [...sessions.values()].find(owner => owner.token === message.token);
      if (!owner) return;
      if (message.type === 'state' && ['preparing', 'recording', 'stopping', 'error'].includes(message.state)) post(owner.control, message);
      if (message.type === 'permission-needed') void permissionSetup(owner).catch(error => end(owner, error.message));
      if (message.type === 'ended') end(owner, message.error || '');
    });
    port.onDisconnect.addListener(() => {
      if (host !== port) return;
      host = null; endAll('Voice runtime disconnected. Click the mic to retry.');
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
      if (current(owner)) { port.disconnect(); if (!owner.stopRequested) end(owner, 'Output connection lost. Click the mic to retry.'); }
    });
    port.onDisconnect.addListener(() => { relay.disconnect(); });
    return;
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type === 'web-voice-permission-result' && extensionPage(sender, 'web-voice-permission.html')) {
    const owner = [...sessions.values()].find(owner => sender.url?.split('#')[1] === owner.token && owner.setupTab === sender.tab?.id);
    if (!owner) { respond({ error: 'This microphone setup was canceled. Return to the field and click its mic again.' }); return; }
    void (async () => {
      if (!await authorized() || !current(owner)) throw Error('Web voice typing was disabled.');
      if (message.error) { end(owner, message.error); respond({ ok: true }); return; }
      const tabId = owner.setupTab;
      await chrome.tabs.update(owner.target.tabId, { active: true });
      owner.setupTab = null;
      if (current(owner)) runtimePost(owner, { type: 'permission-ready' });
      respond({ ok: true }); await chrome.tabs.remove(tabId).catch(() => {});
    })().catch(error => { end(owner, error.message); respond({ error: error.message }); });
    return true;
  }
  if (message.type !== 'web-voice-reconcile' || !extensionPage(sender, 'graph-library.html')) return;
  void reconcile().then(() => respond({ ok: true }), error => respond({ error: error.message })); return true;
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
  for (const owner of sessions.values()) if (owner.target.tabId === id || owner.setupTab === id) end(owner, owner.setupTab === id ? 'Microphone setup closed. Click the mic to retry.' : 'Target tab closed.');
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === 'loading') for (const owner of sessions.values()) if (owner.target.tabId === id) end(owner, 'Target page navigated.');
});
// A restarted coordinator never adopts unknown capture. Closing its old DOM
// owner releases all tracks/Workers before a new generation can be created.
void serialize(closeDocument).catch(() => {});
void reconcile().catch(() => {});
