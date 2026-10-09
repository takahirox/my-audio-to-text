import { ModelAssetCache, storagePersistence } from './model-asset-cache.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { ttsManifest } from './tts-cache.js';
import { readGraph } from './graph.js';

const el = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const channel = new BroadcastChannel('model-cache-updates');
const cards = [];
let closed = false, savedNodes = [];
try { savedNodes = readGraph(localStorage).nodes; } catch { /* Models can recover assets even with a broken saved graph. */ }
const definitions = [
  { id: 'opus-ja-en', title: 'OPUS-MT · Japanese → English', size: 'About 239 MB', manifest: opusMtManifest, terms: 'Helsinki-NLP / ONNX Community · CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  { id: 'opus-en-ja', title: 'OPUS-MT · English → Japanese', size: 'About 253 MB', manifest: englishToJapaneseOpusMtManifest, terms: 'Helsinki-NLP / Kadonox ONNX conversion · Apache 2.0', url: 'https://huggingface.co/Helsinki-NLP/opus-tatoeba-en-ja' },
  { id: 'supertonic3', type: 'Supertonic3', title: 'Supertonic 3', size: 'About 399 MB', voices: ['F1', 'M1'], terms: 'OpenRAIL-M weights and voices', url: '../web/licenses/tts-notices.txt' },
  { id: 'kokoro', type: 'Kokoro', title: 'Kokoro 82M', size: 'About 93 MB', voices: ['jf_alpha', 'af_heart'], terms: 'Apache-2.0 weights; frontends have separate notices', url: '../web/licenses/tts-notices.txt' },
];
class ModelCard {
  constructor(definition) {
    this.definition = definition; this.ticket = 0; this.caches = new Map();
    const root = el('section'); root.className = 'panel model-card'; root.id = definition.id;
    root.setAttribute('aria-label', definition.title); this.root = root;
    root.append(el('h3', definition.title), el('p', `${definition.size}, plus cache overhead. Runtime is packaged.`));
    if (definition.voices) {
      const label = el('label', 'Voice '); this.voice = el('select'); this.voice.setAttribute('aria-label', `${definition.title} voice`);
      for (const voice of definition.voices) { const option = el('option', voice === 'jf_alpha' ? 'jf_alpha · Japanese' : voice === 'af_heart' ? 'af_heart · English' : voice); option.value = voice; this.voice.append(option); }
      this.voice.value = savedNodes.find(node => node.type === definition.type)?.settings.voice || definition.voices[0];
      label.append(this.voice); root.append(label);
      this.voice.onchange = () => { void this.inspect(); };
      root.append(el('p', definition.type === 'Supertonic3' ? 'F1 / M1 voices support Japanese and English. Select language in Graph Editor.' : 'Match the connected text language to the selected voice in Graph Editor.'));
    }
    this.status = el('p', 'Checking cached assets…'); this.status.className = 'model-status'; this.status.setAttribute('role', 'status');
    this.error = el('p'); this.error.className = 'model-error'; this.error.setAttribute('role', 'alert');
    this.progress = el('progress'); this.progress.max = 1; this.progress.value = 0; this.progress.setAttribute('aria-label', `${definition.title} download progress`);
    this.bytes = el('p'); this.bytes.className = 'muted';
    this.files = el('ul'); const details = el('details'); details.append(el('summary', 'Verified files'), this.files);
    const controls = el('div'); controls.className = 'actions';
    const button = (text, action) => { const control = el('button', text); control.type = 'button'; control.onclick = action; controls.append(control); return control; };
    this.prepare = button('Download / retry', () => { void this.run('prepare'); });
    this.cancel = button('Cancel download', () => this.controller?.abort());
    this.check = button('Check cache', () => { void this.inspect(); });
    this.remove = button('Delete cached assets', () => { void this.run('remove'); });
    const terms = el('a', definition.terms); terms.href = definition.url;
    root.append(this.status, this.error, this.progress, this.bytes, controls, details, terms);
    document.getElementById('models').append(root); this.buttons(); void this.inspect();
  }
  settings() { return { language: 'ja', voice: this.voice?.value }; }
  async cache() {
    const key = this.voice?.value || 'default';
    if (!this.caches.has(key)) this.caches.set(key, (async () => new ModelAssetCache(await (this.definition.manifest ? this.definition.manifest() : ttsManifest(this.definition.type, this.settings()))))());
    return this.caches.get(key);
  }
  buttons() {
    for (const control of [this.prepare, this.check, this.remove, this.voice].filter(Boolean)) control.disabled = !!this.busy;
    this.cancel.disabled = !this.controller;
  }
  render(view) {
    if (closed) return;
    this.status.textContent = view.state === 'Ready' ? 'Ready · Cached and verified' : view.state;
    this.root.dataset.state = view.state; this.error.textContent = view.error;
    this.progress.max = view.totalBytes; this.progress.value = view.downloadedBytes;
    this.bytes.textContent = `${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes · ${view.cachedBytes.toLocaleString()} bytes verified cached`;
    this.files.replaceChildren(...view.files.map(file => el('li', `${file.path}: ${file.cached ? 'Cached' : 'Missing'}`)));
  }
  fail(error) { if (!closed) { this.status.textContent = 'Error'; this.root.dataset.state = 'Error'; this.error.textContent = `${error.message} Retry checking or rebuild the extension if its manifest is missing.`; } }
  async inspect() {
    if (this.busy || closed) return;
    const ticket = ++this.ticket;
    this.status.textContent = 'Checking cached assets…';
    try { const cache = await this.cache(), view = await cache.inspect(); if (ticket === this.ticket && !this.busy) this.render(view); }
    catch (error) { if (ticket === this.ticket) this.fail(error); }
  }
  async run(action) {
    if (this.busy || closed) return;
    this.busy = true; ++this.ticket;
    if (action === 'prepare') this.controller = new AbortController();
    this.buttons(); this.status.textContent = action === 'prepare' ? 'Downloading · verifying existing files…' : 'Deleting cached assets…';
    try {
      const cache = await this.cache(); this.controller?.signal.throwIfAborted();
      this.render(await (action === 'prepare' ? cache.prepare({ signal: this.controller.signal, onChange: view => this.render(view) }) : cache.remove()));
    } catch (error) { this.fail(error); }
    finally {
      this.busy = false; this.controller = null; this.buttons();
      if (!closed) { channel.postMessage({ id: this.definition.id }); for (const card of cards) if (card !== this && card.definition.id === this.definition.id) void card.inspect(); }
    }
  }
}
for (const definition of definitions) cards.push(new ModelCard(definition));
channel.onmessage = ({ data }) => { for (const card of cards) if (card.definition.id === data.id) void card.inspect(); };
window.addEventListener('focus', () => { for (const card of cards) void card.inspect(); });
window.addEventListener('pagehide', () => { closed = true; for (const card of cards) { ++card.ticket; card.controller?.abort(); } channel.close(); });
async function showPersistence(request = false) {
  const button = document.getElementById('persist'); button.disabled = true;
  const result = await storagePersistence(navigator.storage, request);
  document.getElementById('persistence').textContent = `Persistent storage: ${result}.`;
  button.disabled = result === 'unsupported' || result === 'granted';
}
document.getElementById('persist').onclick = () => { void showPersistence(true); };
void showPersistence();
