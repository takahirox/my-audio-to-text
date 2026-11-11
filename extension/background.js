import { requestLaunchLibrary } from './web-voice-background.js';

const root = 'live-graphs', run = 'live-run:', defaults = 'live-default:';
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
    await createMenu({ id: root, title: 'Live graphs' });
    for (const graph of state?.graphs || []) await createMenu({ id: run + graph.id, parentId: root, title: `Open ${graph.name}` });
    if (!state?.graphs.length) await createMenu({ id: 'live-empty', parentId: root, title: error || 'No runnable graphs — create or repair one in Graph Library', enabled: false });
    await createMenu({ id: 'live-defaults', parentId: root, title: 'Default for left-click' });
    if (!state?.defaultId) await createMenu({ id: 'live-no-default', parentId: 'live-defaults', title: 'Choose a default graph', enabled: false });
    for (const graph of state?.graphs || []) await createMenu({ id: defaults + graph.id, parentId: 'live-defaults', title: graph.name, type: 'radio', checked: graph.id === state.defaultId });
    await createMenu({ id: 'live-library', parentId: root, title: 'Graph Library' });
  });
}
async function launch(tab, graphId, launchError) {
  if (!Number.isInteger(tab?.id)) return;
  // Retain the event's tab, never query the tab active after a focus change.
  const params = new URLSearchParams({ tab: String(tab.id), session: crypto.randomUUID() });
  if (graphId) params.set('graph', graphId);
  try {
    if (launchError) throw launchError;
    if (graphId) await requestLaunchLibrary('live-check', graphId);
    else graphId = (await requestLaunchLibrary('live-list')).defaultId;
    if (!graphId) throw Error('Choose a default: right-click the extension toolbar icon → Live graphs → Default for left-click. Create or repair graphs in Graph Library.');
    params.set('graph', graphId);
  } catch (error) { params.set('error', error.message); }
  await chrome.windows.create({ url: chrome.runtime.getURL(`extension/recorder.html?${params}`), type: 'popup', focused: false, width: 620, height: 800 });
}
chrome.action.onClicked.addListener(tab => { void launch(tab); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (id.startsWith(run)) { void launch(tab, id.slice(run.length)); return; }
  if (id.startsWith(defaults)) {
    void requestLaunchLibrary('live-default', id.slice(defaults.length)).then(refreshMenus, async error => {
      await launch(tab, null, Error(`Live default could not be confirmed: ${error.message}`));
      await refreshMenus();
    });
  }
  if (id === 'live-library') void chrome.tabs.create({ url: chrome.runtime.getURL('extension/graph-library.html') });
});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'graph-library-changed' && sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL('extension/'))) void refreshMenus();
});
chrome.runtime.onInstalled.addListener(() => { void refreshMenus(); });
chrome.runtime.onStartup.addListener(() => { void refreshMenus(); });
void refreshMenus();
