import { TabCaptureCoordinator } from './tab-capture-coordinator.js';
import { CapturedTabSource } from './tab-capture-source.js';

export function createTabCaptureHost(port) {
  const requests = new Map();
  const send = message => { try { port.postMessage(message); } catch {} };
  const coordinator = new TabCaptureCoordinator((tabId, audio, ended) => new CapturedTabSource(tabId, audio, ended, tabId => {
    const request = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(request); send({ type: 'tab-stream-id-cancel', request }); reject(Error('Tab capture authorization timed out')); }, 15000);
      requests.set(request, { resolve, reject, timer });
      send({ type: 'tab-stream-id', request, tabId });
    });
  }), (id, message) => send({ ...message, type: `tab-${message.type}`, id }));
  return {
    coordinator,
    message(message) {
      if (!message.type?.startsWith('tab-')) return false;
      if (message.type === 'tab-stream-id-result') {
        const pending = requests.get(message.request);
        if (pending) {
          requests.delete(message.request); clearTimeout(pending.timer);
          if (message.error) pending.reject(Error(message.error)); else pending.resolve(message.streamId);
        }
      }
      if (message.type === 'tab-subscribe') void coordinator.subscribe(message.id, message.tabId);
      if (message.type === 'tab-unsubscribe') void coordinator.unsubscribe(message.id, message.flush);
      if (message.type === 'tab-ack') coordinator.acknowledge(message.id, message.sequence);
      if (message.type === 'tab-ended') coordinator.endTab(message.tabId, message.error);
      return true;
    },
    dispose() {
      for (const pending of requests.values()) { clearTimeout(pending.timer); pending.reject(Error('Tab capture host disconnected')); }
      requests.clear(); coordinator.dispose();
    },
  };
}
