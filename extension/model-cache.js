import { ModelAssetCache, storagePersistence } from './model-asset-cache.js';
import { CACHE_DEMO } from './cache-demo-manifest.js';

const element = id => document.getElementById(id);
const cache = new ModelAssetCache(CACHE_DEMO);
let busy = false, controller;
element('size').textContent = `${CACHE_DEMO.bytes.toLocaleString()} bytes of cache storage, plus browser overhead.`;

function render(view) {
  element('cache-status').textContent = view.state;
  element('cache-error').textContent = view.error;
  element('progress').max = view.totalBytes;
  element('progress').value = view.downloadedBytes;
  element('bytes').textContent = `${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes; ${view.cachedBytes.toLocaleString()} bytes cached.`;
  element('files').replaceChildren(...view.files.map(file => {
    const entry = document.createElement('li');
    entry.textContent = `${file.path}: ${file.cached ? 'Cached' : 'Missing'}`;
    return entry;
  }));
}

async function run(action) {
  if (busy) return;
  busy = true; setButtons();
  try { render(await action()); }
  finally { busy = false; controller = undefined; setButtons(); }
}

function setButtons() {
  for (const id of ['prepare', 'check', 'delete']) element(id).disabled = busy;
  element('cancel').disabled = !controller;
}

element('prepare').addEventListener('click', () => {
  if (busy) return;
  controller = new AbortController();
  void run(() => cache.prepare({ onChange: render, signal: controller.signal }));
});
element('check').addEventListener('click', () => { void run(() => cache.inspect()); });
element('delete').addEventListener('click', () => { void run(() => cache.remove()); });
element('cancel').addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => controller?.abort());

async function showPersistence(request = false) {
  element('persist').disabled = true;
  const result = await storagePersistence(navigator.storage, request);
  element('persistence').textContent = `Persistent storage: ${result}.`;
  element('persist').disabled = result === 'unsupported' || result === 'granted';
}
element('persist').addEventListener('click', () => { void showPersistence(true); });
void showPersistence();
void run(() => cache.inspect());
