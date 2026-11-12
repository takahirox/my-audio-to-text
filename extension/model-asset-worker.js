import { ModelAssetCache, defineAssetSet } from './model-asset-cache.js';

// Only file preparation is shared; inference and session lifetimes stay in
// their windows. Web Locks still serialize inspection/deletion and retries.
const preparations = new Map();

self.onconnect = ({ ports: [port] }) => {
  let task;
  const send = data => port.postMessage(data);
  port.onmessage = ({ data }) => {
    if (data.type === 'persisted') { task?.persisted?.(); return; }
    if (data.type === 'cancel') {
      if (task) {
        task.consumers.delete(port);
        if (!task.consumers.size) {
          if (preparations.get(task.key) === task) preparations.delete(task.key);
          task.controller.abort();
          task.persisted?.();
        }
      }
      port.close(); return;
    }
    if (task || !['inspect', 'prepare'].includes(data.type)) return;
    // Revalidate the structured-cloned pinned manifest at the worker boundary.
    let manifest;
    try { manifest = defineAssetSet({ ...data.manifest, origin: new URL(data.manifest.files[0].url).origin }); }
    catch (error) { send({ type: 'result', view: { state: 'Error', error: error.message } }); port.close(); return; }
    const key = JSON.stringify({ ...manifest, files: [...manifest.files].sort((a, b) => a.url.localeCompare(b.url)) });
    task = preparations.get(key);
    if (task) {
      task.consumers.add(port);
      if (task.view) send({ type: 'progress', view: task.view });
      if (task.persisted) send({ type: 'persist' });
      return;
    }
    task = { key, consumers: new Set([port]), controller: new AbortController() };
    const owner = task;
    if (data.type === 'prepare') preparations.set(key, owner);
    const beforeDownload = () => new Promise(resolve => {
      owner.persisted = () => { owner.persisted = null; resolve(); };
      for (const consumer of owner.consumers) consumer.postMessage({ type: 'persist' });
      if (owner.controller.signal.aborted) owner.persisted();
    });
    const cache = new ModelAssetCache(manifest, { shared: false, beforeDownload });
    const onChange = view => {
      owner.view = view;
      for (const consumer of owner.consumers) consumer.postMessage({ type: 'progress', view });
    };
    void cache[data.type]({ signal: owner.controller.signal, onChange }).then(view => {
      if (preparations.get(key) === owner) preparations.delete(key);
      for (const consumer of owner.consumers) {
        consumer.postMessage({ type: 'result', view }); consumer.close();
      }
      owner.consumers.clear();
    });
  };
};
