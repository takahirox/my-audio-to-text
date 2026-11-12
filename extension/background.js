import { requestLaunchLibrary, authorizeLiveTabCapture, readWebVoiceState, changeWebVoiceEnabled, onWebVoiceStateChanged } from './web-voice-background.js';
import { WEB_VOICE_KEY, WEB_VOICE_ORIGINS, WEB_VOICE_POSITION_KEY, WEB_VOICE_POSITIONS, readVoicePosition, setVoicePosition } from './web-voice-preference.js';

const root = 'live-graphs', run = 'live-run:', open = 'live-open';
let refreshing = Promise.resolve();
let microphonePending = false;
let positionWork = Promise.resolve();
let microphoneSync = Promise.resolve();
function syncMicrophoneMenus() {
  return microphoneSync = microphoneSync.catch(() => {}).then(async () => {
    let voice = { enabled: false, pending: false }, position;
    try { voice = await readWebVoiceState(); } catch { /* Unknown enablement is never shown as ON. */ }
    try { position = await readVoicePosition(); } catch { /* Keep the last confirmed radio selection. */ }
    await chrome.contextMenus.update('web-microphone', { checked: voice.enabled, enabled: !voice.pending && !microphonePending });
    if (position) for (const value of WEB_VOICE_POSITIONS) await chrome.contextMenus.update('microphone-position:' + value, { checked: position === value });
  }).catch(() => {}); // A rebuild may briefly remove these IDs; it syncs again.
}
function microphoneError(error, enabled) {
  // Only failures open this small consent/retry surface; no general settings UI.
  const params = new URLSearchParams({ error: error.message });
  if (typeof enabled === 'boolean') params.set('enabled', String(enabled));
  void chrome.windows.create({ url: chrome.runtime.getURL(`extension/web-voice-consent.html?${params}`), type: 'popup', width: 440, height: 270 });
}
const createMenu = properties => new Promise((resolve, reject) => {
  chrome.contextMenus.create({ ...properties, contexts: ['action'] }, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(Error(error.message)); else resolve();
  });
});
function refreshMenus() {
  return refreshing = refreshing.catch(() => {}).then(async () => {
    await chrome.contextMenus.removeAll();
    let voice = { enabled: false, pending: false }, position = 'auto';
    try { voice = await readWebVoiceState(); position = await readVoicePosition(); } catch { /* Fail closed; a click can retry. */ }
    await createMenu({ id: 'web-microphone', title: 'Web microphone', type: 'checkbox', checked: voice.enabled, enabled: !voice.pending && !microphonePending });
    await createMenu({ id: 'microphone-position', title: 'Microphone position' });
    for (const value of WEB_VOICE_POSITIONS) await createMenu({ id: 'microphone-position:' + value, parentId: 'microphone-position', title: value[0].toUpperCase() + value.slice(1), type: 'radio', checked: position === value });
    await syncMicrophoneMenus();
    let state, error;
    try { state = await requestLaunchLibrary('live-list'); } catch (failure) { error = failure.message; }
    // Three action-level items stay below Chrome's menu capacity for large libraries.
    await createMenu({ id: root, title: 'Graphs' });
    await createMenu({ id: open, parentId: root, title: 'Launch' });
    for (const graph of state?.graphs || []) await createMenu({ id: run + graph.id, parentId: open, title: graph.name, type: 'radio', checked: graph.id === state.defaultId });
    if (!state?.graphs.length) await createMenu({ id: 'live-empty', parentId: open, title: error || 'No runnable graphs — create or repair one in Graph Library', enabled: false });
    await createMenu({ id: 'live-library', parentId: root, title: 'Graph Library' });
  });
}
async function launch(tab, graphId) {
  if (!Number.isInteger(tab?.id)) return;
  // Retain the event's tab, never query the tab active after a focus change.
  const params = new URLSearchParams({ tab: String(tab.id), session: crypto.randomUUID() });
  await authorizeLiveTabCapture(params.get('session'), tab.id, async () => {
    try {
      if (graphId) {
        try { await requestLaunchLibrary('live-open', graphId); }
        catch (error) { throw Error(`Graph selection could not be confirmed: ${error.message} Open Graph Library from the toolbar context menu to repair or choose a runnable graph.`); }
      } else graphId = (await requestLaunchLibrary('live-list')).defaultId;
      if (!graphId) throw Error('No runnable graphs. Right-click the extension toolbar icon → Graphs → Graph Library to create or repair a graph.');
      // Error-only windows have no graph ID, so later focus/storage refreshes
      // cannot enable Start after a failed selection commit.
      params.set('graph', graphId);
    } catch (error) { params.set('error', error.message); }
    return chrome.windows.create({ url: chrome.runtime.getURL(`extension/recorder.html?${params}`), type: 'popup', focused: false, width: 620, height: 800 });
  });
  // Also restore the native radio state after a failed explicit selection.
  void refreshMenus();
}
chrome.action.onClicked.addListener(tab => { void launch(tab); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id === 'web-microphone') {
    if (microphonePending) return;
    microphonePending = true;
    const enabled = info.checked === true;
    // Restore Chrome's optimistic check until the canonical operation completes.
    void chrome.contextMenus.update(id, { checked: !enabled, enabled: false }).catch(() => {});
    let permission;
    if (enabled) {
      // No storage/permission inspection or await before this user gesture API.
      try { permission = chrome.permissions.request({ origins: WEB_VOICE_ORIGINS }); }
      catch (error) { permission = Promise.reject(error); }
    }
    void changeWebVoiceEnabled(enabled, permission).catch(error => microphoneError(error, enabled))
      .finally(() => { microphonePending = false; void syncMicrophoneMenus(); });
    return;
  }
  if (id.startsWith('microphone-position:')) {
    positionWork = positionWork.catch(() => {}).then(() => setVoicePosition(id.slice('microphone-position:'.length)))
      .catch(error => console.warn('Microphone position:', error.message)).finally(() => { void syncMicrophoneMenus(); });
    return;
  }
  if (id.startsWith(run)) { void launch(tab, id.slice(run.length)); return; }
  if (id === 'live-library') void chrome.tabs.create({ url: chrome.runtime.getURL('extension/graph-library.html') });
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'graph-library-changed' && sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('extension/'))) void refreshMenus();
});
chrome.runtime.onInstalled.addListener(() => { void refreshMenus(); });
chrome.runtime.onStartup.addListener(() => { void refreshMenus(); });
onWebVoiceStateChanged(() => { void syncMicrophoneMenus(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[WEB_VOICE_KEY] || changes[WEB_VOICE_POSITION_KEY])) void syncMicrophoneMenus();
});
void refreshMenus();
