import { TabSession } from './session.js';

const element = id => document.getElementById(id);
const session = new TabSession(view => {
  for (const id of ['status', 'signal', 'partial', 'final']) element(id).textContent = view[id];
  element('errors').textContent = view.error;
  element('start').disabled = view.state !== 'idle' || !Number.isInteger(view.tabId);
  element('stop').disabled = !['loading', 'starting', 'running'].includes(view.state);
});
element('start').onclick = () => { void session.start(session.view.tabId); };
element('stop').onclick = () => { void session.stop(); };
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message.type === 'invoke' && Number.isInteger(message.tabId)) {
    void session.start(message.tabId);
  }
});
chrome.tabs.onRemoved.addListener(tabId => session.tabEnded(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') session.tabEnded(tabId);
});
// Stream-specific onended callbacks carry a session guard. Global tabCapture
// status events have no session ID and can arrive late after a same-tab restart.
window.addEventListener('pagehide', () => session.cancel());
window.addEventListener('error', event => session.fail(event.message));
window.addEventListener('unhandledrejection', event => session.fail(event.reason?.message || String(event.reason)));
const params = new URLSearchParams(location.search);
const tabId = params.has('tab') ? Number(params.get('tab')) : NaN;
if (params.has('error')) session.update({ error: params.get('error'), tabId });
else if (Number.isInteger(tabId)) void session.start(tabId);
