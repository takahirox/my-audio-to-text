import { ModelAssetCache, defineAssetSet } from './model-asset-cache.js';

// Share each pinned file, not a whole manifest: different voices select distinct
// manifests but still need the same weights. Web Locks retain serialization with
// inspection/deletion and with callers outside this worker.
const preparations = new Map();
const fileKey = file => JSON.stringify({ url: file.url, bytes: file.bytes, sha256Chunks: file.sha256Chunks });

function subscribe(manifest, file, consumer, operation) {
  const key = fileKey(file);
  let task = preparations.get(key);
  if (!task) {
    task = { key, consumers: new Set(), controller: new AbortController() };
    if (operation === 'prepare') preparations.set(key, task);
    const beforeDownload = () => new Promise(resolve => {
      task.persisted = () => { task.persisted = null; resolve(); };
      for (const subscriber of task.consumers) subscriber.send({ type: 'persist' });
      if (task.controller.signal.aborted) task.persisted();
    });
    const singleFile = defineAssetSet({ ...manifest, files: [file], origin: new URL(file.url).origin });
    const cache = new ModelAssetCache(singleFile, { shared: false, beforeDownload });
    task.promise = cache[operation]({ signal: task.controller.signal, onChange: view => {
      task.view = view;
      for (const subscriber of task.consumers) subscriber.update();
    } }).then(view => {
      task.view = view; task.done = true;
      if (preparations.get(key) === task) preparations.delete(key);
      return view;
    });
  }
  task.consumers.add(consumer);
  if (task.persisted) consumer.send({ type: 'persist' });
  return task;
}

function unsubscribe(task, consumer) {
  task.consumers.delete(consumer);
  if (!task.consumers.size && !task.done) {
    if (preparations.get(task.key) === task) preparations.delete(task.key);
    task.controller.abort();
    task.persisted?.();
  }
}

self.onconnect = ({ ports: [port] }) => {
  let started = false, finished = false, downloading = false;
  let tasks = [], cache;
  const controller = new AbortController();
  const send = data => { if (!finished) port.postMessage(data); };
  const snapshot = (state, error = '') => cache.snapshot(tasks.map((task, i) => ({
    path: cache.manifest.files[i].path, cached: task.view?.files[0].cached || false,
  })), state, tasks.reduce((sum, task) => sum + (task.view?.downloadedBytes || 0), 0), error);
  const consumer = { send, update() {
    downloading ||= tasks.some(task => task.view?.state === 'Downloading');
    if (downloading) send({ type: 'progress', view: snapshot('Downloading') });
  } };
  const finish = view => {
    if (finished) return;
    if (view) send({ type: 'result', view });
    finished = true;
    controller.abort();
    for (const task of tasks) unsubscribe(task, consumer);
    port.close();
  };
  port.onmessage = ({ data }) => {
    if (data.type === 'persisted') {
      for (const task of tasks) task.persisted?.();
      return;
    }
    if (data.type === 'cancel') { finish(); return; }
    if (started || finished || !['inspect', 'prepare'].includes(data.type)) return;
    started = true;
    // Revalidate the structured-cloned pinned manifest at the worker boundary.
    let manifest;
    try { manifest = defineAssetSet({ ...data.manifest, origin: new URL(data.manifest.files[0].url).origin }); }
    catch (error) { finish({ state: 'Error', error: error.message }); return; }
    cache = new ModelAssetCache(manifest, { shared: false });
    if (data.type === 'inspect' && (!data.followPreparation
        || !manifest.files.some(file => preparations.has(fileKey(file))))) {
      void cache.inspect({ signal: controller.signal }).then(finish);
      return;
    }
    // Subscribe to every requirement before awaiting any of them, including
    // files queued behind a different voice's active transfer.
    // Inspection can await active files and report their progress without
    // downloading any missing requirements of its own.
    tasks = manifest.files.map(file => subscribe(manifest, file, consumer, data.type));
    consumer.update();
    void Promise.all(tasks.map(task => task.promise.then(view => {
      if (view.state === 'Error') throw view;
    }))).then(async () => {
      if (finished) return;
      // Check the complete manifest again under the model lock so eviction or
      // deletion between individual file preparations cannot produce Ready.
      const view = await cache.inspect({ signal: controller.signal });
      finish(data.type === 'prepare' && view.state === 'Not downloaded'
        ? cache.failure(Error('Cached assets were evicted during preparation.'), view.files) : view);
    }).catch(view => finish(snapshot('Error', view.error)));
  };
};
