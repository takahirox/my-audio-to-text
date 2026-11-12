// Transport and toolbar capabilities only. The offscreen coordinator owns all
// native resources and tab-keyed acquisition/teardown barriers.
export function installTabCaptureBridge({ ensureHost, hostPost, idleCleanup }, chrome = globalThis.chrome) {
  const clients = new Map(), acquisitions = new Map(), epochs = new Map();
  const grantKey = session => `live-tab-grant:${session}`;
  const post = (port, message) => { try { port.postMessage(message); } catch {} };
  function remove(client, error = '') {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    for (const pending of acquisitions.values()) if (pending.client === client) acquire(pending);
    post(client.port, { type: 'ended', error });
    idleCleanup();
  }
  function acquire(pending) {
    const client = [...clients.values()].find(client => client.sent && !client.canceled && client.tabId === pending.tabId);
    if (!client) {
      acquisitions.delete(pending.request);
      hostPost({ type: 'tab-stream-id-result', request: pending.request, error: 'Tab capture canceled before acquisition.' });
      return;
    }
    pending.client = client;
    post(client.port, { type: 'acquire', request: pending.request });
  }
  function release(client, flush = false) {
    client.canceled = true;
    for (const pending of acquisitions.values()) if (pending.client === client) acquire(pending);
    if (client.sent) hostPost({ type: 'tab-unsubscribe', id: client.id, flush });
    else remove(client);
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'live-tab-audio') return;
    const sender = port.sender;
    let url;
    try { url = new URL(sender?.url); } catch { port.disconnect(); return; }
    if (sender.id !== chrome.runtime.id || url.href.split(/[?#]/)[0] !== chrome.runtime.getURL('extension/recorder.html')) {
      port.disconnect(); return;
    }
    let client, disconnected = false;
    port.onDisconnect.addListener(() => { disconnected = true; if (client) release(client); });
    port.onMessage.addListener(message => {
      if (message.type === 'stream-id') {
        const pending = acquisitions.get(message.request);
        if (!pending || pending.client !== client || !client?.sent || client.canceled) return;
        acquisitions.delete(message.request);
        hostPost({ type: 'tab-stream-id-result', request: message.request, streamId: message.streamId, error: message.error });
        return;
      }
      if (message.type === 'unsubscribe') { if (client) release(client, message.flush === true); return; }
      if (message.type === 'ack') {
        if (client?.sent) hostPost({ type: 'tab-ack', id: client.id, sequence: message.sequence });
        return;
      }
      if (message.type !== 'subscribe' || client) return;
      client = { id: crypto.randomUUID(), port, tabId: message.tabId, session: message.session };
      clients.set(client.id, client); // Reserve host lifetime before any await.
      void (async () => {
        const grant = (await chrome.storage.session.get(grantKey(client.session)))[grantKey(client.session)];
        if (!grant || grant.tabId !== client.tabId || !Number.isInteger(client.tabId) ||
            (epochs.has(client.tabId) && epochs.get(client.tabId) !== grant.epoch) ||
            url.searchParams.get('session') !== client.session || url.searchParams.get('tab') !== String(client.tabId)) {
          throw Error('This window is not authorized for that source tab. Invoke the toolbar on the source tab to open a new Live window.');
        }
        if (client.canceled || disconnected) return;
        await ensureHost();
        // Navigation may revoke the capability while the host is starting.
        const current = (await chrome.storage.session.get(grantKey(client.session)))[grantKey(client.session)];
        if (!current || current.tabId !== client.tabId || (epochs.has(client.tabId) && epochs.get(client.tabId) !== current.epoch)) throw Error('Source tab navigated or closed. Invoke its toolbar to open a new Live window.');
        if (client.canceled || disconnected) return;
        client.sent = true;
        hostPost({ type: 'tab-subscribe', id: client.id, tabId: client.tabId });
      })().catch(error => remove(client, error.message));
    });
  });
  async function revoke(tabId, error) {
    const epoch = crypto.randomUUID(); epochs.set(tabId, epoch);
    // Stop promptly, independently of the storage write.
    hostPost({ type: 'tab-ended', tabId, error });
    for (const client of clients.values()) if (client.tabId === tabId) release(client);
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter(key => key.startsWith('live-tab-grant:') && all[key].tabId === tabId && all[key].epoch !== epoch);
    if (keys.length) await chrome.storage.session.remove(keys);
  }
  chrome.tabs.onRemoved.addListener(id => {
    void revoke(id, 'Source tab closed. Invoke the toolbar on a source tab to start again.').finally(() => epochs.delete(id));
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (change.status === 'loading') void revoke(id, 'Source tab navigated. Invoke the toolbar on the source tab and Start again.');
  });
  chrome.windows.onRemoved.addListener(windowId => {
    void chrome.storage.session.get(null).then(all => {
      const keys = Object.keys(all).filter(key => key.startsWith('live-tab-grant:') && all[key].windowId === windowId);
      if (keys.length) return chrome.storage.session.remove(keys);
    });
  });
  return {
    clients,
    async authorize(session, tabId, openWindow) {
      const key = grantKey(session);
      const epoch = epochs.get(tabId) || crypto.randomUUID(); epochs.set(tabId, epoch);
      await chrome.storage.session.set({ [key]: { tabId, epoch } });
      try {
        const window = await openWindow();
        if (epochs.get(tabId) === epoch) await chrome.storage.session.set({ [key]: { tabId, epoch, windowId: window.id } });
        else await chrome.storage.session.remove(key);
      } catch (error) { await chrome.storage.session.remove(key); throw error; }
    },
    message(message) {
      if (!message.type?.startsWith('tab-')) return false;
      if (message.type === 'tab-stream-id-cancel') { acquisitions.delete(message.request); return true; }
      if (message.type === 'tab-stream-id') {
        // Only the authenticated host can request an ID, through an already
        // authorized Live page in its matching cross-origin isolated process.
        const pending = { request: message.request, tabId: message.tabId };
        acquisitions.set(message.request, pending); acquire(pending);
      } else {
        const client = clients.get(message.id);
        if (client) {
          if (message.type === 'tab-ended') remove(client, message.error);
          else post(client.port, { ...message, type: message.type.slice(4) });
        }
      }
      return true;
    },
    disconnected() {
      acquisitions.clear();
      for (const client of [...clients.values()]) remove(client, 'Tab audio host disconnected. Invoke the toolbar and Start again.');
    },
  };
}
