// Browser communication belongs to concrete adapters, outside Pipeline.
export class PageConnection {
  constructor(target, onEvent = () => {}) {
    if (!Number.isInteger(target?.tabId) || typeof target.documentId !== 'string') throw Error('Authorize a page target in Live first.');
    this.target = { ...target }; this.pending = new Map(); this.nextRequest = 0;
    this.port = chrome.tabs.connect(target.tabId, { name: 'local-page-target', documentId: target.documentId });
    this.port.onMessage.addListener(message => {
      if (message.event) { onEvent(message); return; }
      const pending = this.pending.get(message.request);
      if (!pending) return;
      this.pending.delete(message.request); clearTimeout(pending.timer);
      if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.result);
    });
    this.port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message;
      this.close(); onEvent({ event: 'ended', error: message || 'Page disconnected. Invoke its toolbar action and reselect the target.' });
    });
  }
  request(action, values = {}) {
    if (this.closed) return Promise.reject(Error('Page target detached. Stop and authorize again.'));
    const request = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(request); reject(Error('Page operation expired. Stop and reselect the target.')); }, action === 'pick' ? 65000 : 10000);
      this.pending.set(request, { resolve, reject, timer });
      try { this.port.postMessage({ ...values, action, request }); }
      catch (error) { clearTimeout(timer); this.pending.delete(request); reject(error); }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(Error('Page target detached.')); }
    this.pending.clear(); this.port.disconnect();
  }
}
export async function authorizePage(tabId) {
  if (!Number.isInteger(tabId)) throw Error('Invoke the toolbar action on the target tab first.');
  // Only the explicitly invoked top-level document. Chrome enforces activeTab.
  const [result] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['extension/page-agent.js'], world: 'ISOLATED' });
  if (!result?.documentId) throw Error('This page cannot be targeted. Use a normal web page and invoke its toolbar action.');
  const target = { tabId, documentId: result.documentId };
  const connection = new PageConnection(target);
  try { const description = await connection.request('describe'); return { ...target, label: `${description.label} · tab ${tabId} · top frame` }; }
  finally { connection.close(); }
}
