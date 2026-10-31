import { meetingSummaryManifest } from './meeting-summary-cache.js';
import { ModelAssetCache, storagePersistence } from './model-asset-cache.js';
import { parakeetManifest, moonshineManifest } from './optional-asr-cache.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { ifConditionManifest } from './if-condition-cache.js';
import { translateGemmaManifest } from './translategemma-cache.js';
import { ttsManifest } from './tts-cache.js';
import { qwen3TtsManifest } from './qwen3-tts-cache.js';
import { cosyVoice3Manifest } from './cosyvoice3-cache.js';
import { readGraph } from './graph.js';

const el = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const channel = new BroadcastChannel('model-cache-updates');
const cards = [];
let closed = false, savedNodes = [];
try { savedNodes = readGraph(localStorage).nodes; } catch { /* Models can recover assets even with a broken saved graph. */ }
const definitions = [
  { id: 'qwen3-tts', title: 'Qwen3-TTS 0.6B CustomVoice · streaming', size: '690 MB shared by Japanese/English and both voices. Desktop Worker WebGPU required; allow 2 GB storage, 6 GB free RAM/GPU memory (planning estimate). No CPU/cloud fallback.', manifest: qwen3TtsManifest, terms: 'Qwen Team / Danyal Malik ONNX conversion · Apache 2.0. Includes a separately pinned Qwen speech decoder. Choose language and voice in Graph Node settings.', url: '../web/licenses/qwen3-tts.txt' },
  { id: 'cosyvoice3', title: 'CosyVoice3 0.5B · streaming', size: '917 MB shared by English/Japanese. Desktop Worker WebGPU; allow 3 GB storage and 6 GB free RAM/GPU per Node (planning estimates). One reviewed reference voice. No CPU/cloud fallback; other languages/mobile unqualified.', manifest: cosyVoice3Manifest, terms: 'FunAudioLLM / Danyal Malik ONNX conversion · Apache 2.0. LibriTTS-R reference features: Koizumi et al., speaker 4446, CC BY 4.0. Language follows input text; spell out numbers and symbols. See attribution and exact pins.', url: '../web/licenses/cosyvoice3.txt' },
  { id: 'meeting-summary-lfm2', title: 'Meeting Summary · LFM2.5 1.2B JP', size: '749 MB download; allow 2 GB storage and 4 GB free RAM/GPU per Node (estimate). WebGPU shader-f16. Summary history is lossy.', manifest: () => meetingSummaryManifest('MeetingSummaryLfm2'), terms: 'Liquid AI · LFM Open License 1.0. Commercial use above the $10M annual revenue threshold needs a separate license; redistribution requires the license and preserved notices.', url: '../web/licenses/meeting-summary-lfm2.txt' },
  { id: 'meeting-summary-qwen35', title: 'Meeting Summary · Qwen3.5 2B', size: '1.403 GB download; allow 3 GB storage and 6 GB free RAM/GPU per Node (estimate). WebGPU shader-f16. Text-only ONNX Community optimized conversion of Qwen/Qwen3.5-2B; export card has no conversion details. Summary history is lossy.', manifest: () => meetingSummaryManifest('MeetingSummaryQwen35'), terms: 'Qwen Team · Apache 2.0 source license. See Help documentation for pinned conversion provenance and evidence.', url: '../web/licenses/meeting-summary-qwen35.txt' },
  { id: 'if-condition', title: 'IfCondition · XtremeDistil', size: '14 MB download; allow 40 MB storage and 250 MB free RAM per active Node. CPU WASM.', manifest: ifConditionManifest, terms: 'Moritz Laurer / Microsoft · MIT', url: '../web/licenses/if-condition-model.txt' },
  { id: 'parakeet-v3', title: 'Parakeet TDT 0.6B v3', size: '1.26 GB download; allow 3 GB storage, 6 GB free RAM/GPU memory. WebGPU shader-f16 required.', manifest: parakeetManifest, terms: 'NVIDIA · CC BY 4.0 · ysdede/istupakov ONNX conversion', url: 'https://huggingface.co/ysdede/parakeet-tdt-0.6b-v3-onnx' },
  { id: 'moonshine-medium-en', title: 'Moonshine Medium Streaming English (245M)', size: '305 MB download; allow 700 MB storage, 2 GB free RAM. CPU WASM.', manifest: moonshineManifest, terms: 'Moonshine AI / Useful Sensors · MIT', url: 'https://moonshine-voice.readthedocs.io/en/latest/models/available-models/' },
  { id: 'opus-ja-en', title: 'OPUS-MT · Japanese → English', size: 'About 239 MB', manifest: opusMtManifest, terms: 'Helsinki-NLP / ONNX Community · CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  { id: 'opus-en-ja', title: 'OPUS-MT · English → Japanese', size: 'About 253 MB', manifest: englishToJapaneseOpusMtManifest, terms: 'Helsinki-NLP / Kadonox ONNX conversion · Apache 2.0', url: 'https://huggingface.co/Helsinki-NLP/opus-tatoeba-en-ja' },
  { id: 'translategemma', title: 'TranslateGemma 4B · English ↔ Japanese', size: '3.112 GB download shared by both directions; allow 7 GB free storage and several GB free RAM/GPU memory. Worker WebGPU required; no CPU/cloud fallback.', manifest: translateGemmaManifest, terms: 'Google / ONNX Community · Gemma Terms of Use and Prohibited Use Policy apply to this conversion. Read before downloading or using.', url: '../web/licenses/gemma-notices.txt' },
  { id: 'supertonic3', type: 'Supertonic3', title: 'Supertonic 3', size: 'About 399 MB', voices: ['F1', 'M1'], terms: 'OpenRAIL-M weights and voices', url: '../web/licenses/tts-notices.txt' },
  { id: 'kokoro', type: 'Kokoro', title: 'Kokoro 82M', size: 'About 93 MB', voices: ['jf_alpha', 'af_heart'], terms: 'Apache-2.0 weights; frontends have separate notices', url: '../web/licenses/tts-notices.txt' },
];
class ModelCard {
  constructor(definition) {
    this.definition = definition; this.ticket = 0; this.caches = new Map();
    const root = el('section'); root.className = 'panel model-card'; root.id = definition.id;
    root.setAttribute('aria-label', definition.title); this.root = root;
    root.append(el('h3', definition.title), el('p', definition.size));
    if (definition.voices) {
      const label = el('label', 'Voice '); this.voice = el('select'); this.voice.setAttribute('aria-label', `${definition.title} voice`);
      for (const voice of definition.voices) { const option = el('option', voice === 'jf_alpha' ? 'jf_alpha · Japanese' : voice === 'af_heart' ? 'af_heart · English' : voice); option.value = voice; this.voice.append(option); }
      this.voice.value = savedNodes.find(node => node.type === definition.type)?.settings.voice || definition.voices[0];
      label.append(this.voice); root.append(label);
      this.voice.onchange = () => { void this.inspect(); };
      root.append(el('p', 'Configure voice and language in Graph Node settings.'));
    }
    this.status = el('p', 'Checking cached assets…'); this.status.className = 'model-status'; this.status.setAttribute('role', 'status');
    this.error = el('p'); this.error.className = 'model-error'; this.error.setAttribute('role', 'alert');
    this.progress = el('progress'); this.progress.max = 1; this.progress.value = 0; this.progress.setAttribute('aria-label', `${definition.title} download progress`);
    this.bytes = el('p'); this.bytes.className = 'muted';
    this.files = el('ul'); const details = el('details'); details.append(el('summary', 'Verified files and size'), this.bytes, this.files);
    const controls = el('div'); controls.className = 'actions';
    const button = (text, action) => { const control = el('button', text); control.type = 'button'; control.onclick = action; controls.append(control); return control; };
    this.prepare = button('Download / retry', () => { void this.run('prepare'); });
    this.cancel = button('Cancel download', () => this.controller?.abort());
    this.check = button('Check cache', () => { void this.inspect(); });
    this.remove = button('Delete cached assets', () => { void this.run('remove'); });
    const terms = el('a', definition.terms); terms.href = definition.url;
    root.append(this.status, this.error, this.progress, controls, details, terms);
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
    if (!this.controller && document.activeElement === this.cancel) this.prepare.focus({ preventScroll: true });
    this.cancel.disabled = !this.controller;
    this.cancel.hidden = !this.controller;
  }
  render(view) {
    if (closed) return;
    this.status.textContent = view.state === 'Ready' ? 'Ready · Cached and verified' : view.state;
    this.root.dataset.state = view.state; this.error.textContent = view.error;
    this.progress.max = view.totalBytes; this.progress.value = view.downloadedBytes;
    this.progress.hidden = !['Downloading', 'Checking'].includes(view.state);
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
