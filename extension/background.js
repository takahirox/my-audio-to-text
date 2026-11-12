import { requestLaunchLibrary } from './web-voice-background.js';

const root = 'live-graphs', run = 'live-run:', open = 'live-open';
let refreshing = Promise.resolve();
const createMenu = properties => new Promise((resolve, reject) => {
  chrome.contextMenus.create({ ...properties, contexts: ['action'] }, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(Error(error.message)); else resolve();
  });
});
function refreshMenus() {
  return refreshing = refreshing.catch(() => {}).then(async () => {
    let state, error;
    try { state = await requestLaunchLibrary('live-list'); } catch (failure) { error = failure.message; }
    await chrome.contextMenus.removeAll();
    // One action-level item stays below Chrome's menu capacity for large libraries.
    await createMenu({ id: root, title: 'Graphs' });
    await createMenu({ id: open, parentId: root, title: 'Open' });
    for (const graph of state?.graphs || []) await createMenu({ id: run + graph.id, parentId: open, title: graph.name, type: 'radio', checked: graph.id === state.defaultId });
    if (!state?.graphs.length) await createMenu({ id: 'live-empty', parentId: open, title: error || 'No runnable graphs — create or repair one in Graph Library', enabled: false });
    await createMenu({ id: 'live-library', parentId: root, title: 'Graph Library' });
  });
}
async function launch(tab, graphId) {
  if (!Number.isInteger(tab?.id)) return;
  // Retain the event's tab, never query the tab active after a focus change.
  const params = new URLSearchParams({ tab: String(tab.id), session: crypto.randomUUID() });
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
  await chrome.windows.create({ url: chrome.runtime.getURL(`extension/recorder.html?${params}`), type: 'popup', focused: false, width: 620, height: 800 });
  // Also restore the native radio state after a failed explicit selection.
  void refreshMenus();
}
chrome.action.onClicked.addListener(tab => { void launch(tab); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith(run)) { void launch(tab, id.slice(run.length)); return; }
  if (id === 'live-library') void chrome.tabs.create({ url: chrome.runtime.getURL('extension/graph-library.html') });
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'graph-library-changed' && sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('extension/'))) void refreshMenus();
});
chrome.runtime.onInstalled.addListener(() => { void refreshMenus(); });
chrome.runtime.onStartup.addListener(() => { void refreshMenus(); });
void refreshMenus();
