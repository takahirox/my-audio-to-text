import { readVoiceEnabled, setVoiceEnabled, WEB_VOICE_KEY, WEB_VOICE_ORIGINS, voiceEnabled } from './web-voice-preference.js';

const scriptId = 'web-voice-typing';
const controls = new Set();
let active = null, reconciling = Promise.resolve();
const post = (port, message) => { try { port.postMessage(message); } catch { /* Detached documents cannot receive state. */ } };
const extensionPage = (sender, name) => sender.id === chrome.runtime.id && sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL(`extension/${name}`);
const authorized = async () => await readVoiceEnabled() && await chrome.permissions.contains({ origins: WEB_VOICE_ORIGINS });
function end(reason = '') {
  const owner = active;
  if (!owner) return;
  active = null; clearTimeout(owner.timer);
  post(owner.control, { type: 'ended', error: reason });
  post(owner.runtime, { type: 'abort', error: reason });
  // Closing the durable DOM owner also stops pending getUserMedia and Workers.
  if (owner.windowId) void chrome.windows.remove(owner.windowId).catch(() => {});
}
function reconcile() {
  return reconciling = reconciling.catch(() => {}).then(async () => {
    const enabled = await authorized();
    const registered = (await chrome.scripting.getRegisteredContentScripts({ ids: [scriptId] })).length;
    if (!enabled) {
      end('Web voice typing disabled or website permission removed.');
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
    const owner = { port, tabId: sender.tab.id, documentId: sender.documentId, valid: false };
    controls.add(port);
    void authorized().then(ok => {
      if (!controls.has(port)) return;
      owner.valid = ok;
      post(port, { type: ok ? 'enabled' : 'disabled' });
    });
    port.onDisconnect.addListener(() => { controls.delete(port); if (active?.control === port) end('Target page disconnected.'); });
    port.onMessage.addListener(message => {
      if (message.type === 'cancel' && active?.control === port) { end(message.error || 'Voice typing canceled.'); return; }
      if (message.type === 'stop' && active?.control === port) {
        post(active.runtime, { type: 'stop' });
        active.stopRequested = true;
        post(port, { type: 'state', state: 'stopping' });
        return;
      }
      if (message.type !== 'start' || !owner.valid || typeof message.capability !== 'string' || message.capability.length !== 36) return;
      // Reserve synchronously, before async permissions/window creation. Starts
      // from multiple documents cannot race past single-session admission.
      if (active) { post(port, { type: 'ended', error: 'Voice typing busy in another field or tab. Stop that session first.' }); return; }
      const session = active = { control: port, token: crypto.randomUUID(), target: { tabId: owner.tabId, documentId: owner.documentId,
        frameId: 0, portName: 'web-voice-output', capability: message.capability, label: 'Selected Web voice field' } };
      session.timer = setTimeout(() => { if (active === session) end('Recording window did not respond. Click the mic to retry.'); }, 20000);
      void (async () => {
        if (!await authorized()) throw Error('Enable Web voice typing and grant website access in Graph Library.');
        if (active !== session) return;
        const window = await chrome.windows.create({ url: chrome.runtime.getURL(`extension/web-voice-runtime.html#${session.token}`),
          type: 'popup', focused: true, width: 380, height: 240 });
        if (active === session) session.windowId = window.id;
        else await chrome.windows.remove(window.id);
      })().catch(error => { if (active === session) end(error.message); });
    });
  }
  if (port.name === 'web-voice-runtime') {
    if (!extensionPage(sender, 'web-voice-runtime.html') || !active || sender.url?.split('#')[1] !== active.token || active.runtime) { port.disconnect(); return; }
    const owner = active; owner.runtime = port; clearTimeout(owner.timer);
    post(port, { type: 'initialize', target: owner.target, stopRequested: owner.stopRequested === true });
    port.onMessage.addListener(message => {
      if (active !== owner) return;
      if (message.type === 'state' && ['preparing', 'recording', 'stopping', 'error'].includes(message.state)) post(owner.control, message);
      if (message.type === 'ended') end(message.error || '');
    });
    port.onDisconnect.addListener(() => { if (active === owner) end('Recording window closed.'); });
  }
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'web-voice-reconcile' || !extensionPage(sender, 'graph-library.html')) return;
  void reconcile().then(() => respond({ ok: true }), error => respond({ error: error.message })); return true;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[WEB_VOICE_KEY]) return;
  // OFF aborts immediately, before serialized registration work completes.
  if (!voiceEnabled(changes[WEB_VOICE_KEY].newValue)) {
    end('Web voice typing disabled.');
    for (const port of controls) post(port, { type: 'disabled' });
  }
  void reconcile().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => { end('Website access removed.'); void reconcile().catch(() => {}); });
chrome.windows.onRemoved.addListener(id => { if (active?.windowId === id) end('Recording window closed.'); });
chrome.tabs.onRemoved.addListener(id => { if (active?.target.tabId === id) end('Target tab closed.'); });
chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading' && active?.target.tabId === id) end('Target page navigated.'); });
// On service-worker restart old document ports disconnect and abort. Register
// only after reading persisted consent; no inference owner is restored.
void reconcile().catch(() => {});
