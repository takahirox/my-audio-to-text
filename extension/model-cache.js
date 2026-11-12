import { reazonManifest, sileroManifest, whisperManifest, zipformerManifest, japaneseFrontendManifest } from './local-asr-cache.js';
import { textSummaryManifest } from './text-summary-cache.js';
import { ModelAssetCache } from './model-asset-cache.js';
import { parakeetManifest, moonshineManifest } from './optional-asr-cache.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { ifConditionManifest } from './if-condition-cache.js';
import { translateGemmaManifest } from './translategemma-cache.js';
import { ttsManifest } from './tts-cache.js';
import { qwen3TtsManifest } from './qwen3-tts-cache.js';
import { cosyVoice3Manifest } from './cosyvoice3-cache.js';
import { readLibrary, entryGraph } from './graph-library.js';
import { compareModelDefinitions } from './model-order.js';

const el = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };
const channel = new BroadcastChannel('model-cache-updates');
const cards = [];
let closed = false, savedNodes = [];
try { savedNodes = readLibrary(localStorage).graphs.flatMap(entry => {
  try { return entryGraph(entry).nodes; } catch { return []; }
}); } catch { /* Global asset recovery remains available with broken library storage. */ }
const definitions = [
  { id: 'reazon', linkLabel: 'License & source', title: 'ReazonSpeech ja-en', size: 'About 77 MB · Japanese/English speech recognition', requirements: 'Graph preparation also requires the shared Silero VAD entry.', manifest: reazonManifest, url: '../web/third-party-notices.txt' },
  { id: 'silero', linkLabel: 'License & source', title: 'Silero VAD', size: '644 KB · shared voice activity detection for ReazonSpeech and Whisper', requirements: 'Deleting this entry affects preparation of both ASR paths.', manifest: sileroManifest, url: '../web/third-party-notices.txt' },
  { id: 'whisper', linkLabel: 'License & source', title: 'Whisper tiny · multilingual q8', size: 'About 44 MB', requirements: 'Requires shared Silero VAD for segmentation.', manifest: whisperManifest, url: '../web/third-party-notices.txt' },
  { id: 'zipformer', linkLabel: 'License & source', title: 'Zipformer English · streaming', size: 'About 45 MB', requirements: 'Owns segmentation; does not require Silero.', manifest: zipformerManifest, url: '../web/third-party-notices.txt' },
  { id: 'kokoro-japanese', linkLabel: 'License & source', title: 'Kokoro Japanese · OpenJTalk frontend voice', size: 'About 1 MB', requirements: 'Statistical voice required only by the Japanese frontend, in addition to Kokoro weights.', manifest: japaneseFrontendManifest, url: '../web/licenses/kokoro-japanese.txt' },
  { id: 'qwen3-tts', linkLabel: 'License & source', title: 'Qwen3-TTS 0.6B CustomVoice · streaming', size: '690 MB', requirements: 'Shared by Japanese/English and both voices. Desktop Worker WebGPU required; allow 2 GB storage, 6 GB free RAM/GPU memory (planning estimate). No CPU/cloud fallback.', manifest: qwen3TtsManifest, url: '../web/licenses/qwen3-tts.txt' },
  { id: 'cosyvoice3', linkLabel: 'License & source', title: 'CosyVoice3 0.5B · streaming', size: '917 MB', requirements: 'Shared by English/Japanese. Desktop Worker WebGPU; allow 3 GB storage and 6 GB free RAM/GPU per Node (planning estimates). One reviewed reference voice. No CPU/cloud fallback; other languages/mobile unqualified.', manifest: cosyVoice3Manifest, url: '../web/licenses/cosyvoice3.txt' },
  { id: 'meeting-summary-lfm2', linkLabel: 'License / terms', title: 'Text Summary · LFM2.5 1.2B JP', size: '749 MB download', requirements: 'Allow 2 GB storage and 4 GB free RAM/GPU per Node (estimate). WebGPU shader-f16. Summary history is lossy.', manifest: () => textSummaryManifest('TextSummaryLfm2'), url: '../web/licenses/meeting-summary-lfm2.txt' },
  { id: 'meeting-summary-qwen35', linkLabel: 'License & source', title: 'Text Summary · Qwen3.5 2B', size: '1.403 GB download', requirements: 'Allow 3 GB storage and 6 GB free RAM/GPU per Node (estimate). WebGPU shader-f16. Summary history is lossy.', manifest: () => textSummaryManifest('TextSummaryQwen35'), url: '../web/licenses/meeting-summary-qwen35.txt' },
  { id: 'if-condition', linkLabel: 'License & source', title: 'IfCondition · XtremeDistil', size: '14 MB download', requirements: 'Allow 40 MB storage and 250 MB free RAM per active Node. CPU WASM.', manifest: ifConditionManifest, url: '../web/licenses/if-condition-model.txt' },
  { id: 'parakeet-v3', linkLabel: 'License & source', title: 'Parakeet TDT 0.6B v3', size: '1.26 GB download', requirements: 'Allow 3 GB storage, 6 GB free RAM/GPU memory. WebGPU shader-f16 required.', manifest: parakeetManifest, url: '../web/third-party-notices.txt' },
  { id: 'moonshine-medium-en', linkLabel: 'License & source', title: 'Moonshine Medium Streaming English (245M)', size: '305 MB download', requirements: 'Allow 700 MB storage, 2 GB free RAM. CPU WASM.', manifest: moonshineManifest, url: '../web/third-party-notices.txt' },
  { id: 'opus-ja-en', linkLabel: 'License & source', title: 'OPUS-MT · Japanese → English', size: 'About 239 MB', manifest: opusMtManifest, url: '../web/third-party-notices.txt' },
  { id: 'opus-en-ja', linkLabel: 'License & source', title: 'OPUS-MT · English → Japanese', size: 'About 253 MB', manifest: englishToJapaneseOpusMtManifest, url: '../web/third-party-notices.txt' },
  { id: 'translategemma', title: 'TranslateGemma 4B · English ↔ Japanese', size: '3.112 GB download shared by both directions', requirements: 'Allow 7 GB free storage and several GB free RAM/GPU memory. Worker WebGPU required; no CPU/cloud fallback.', manifest: translateGemmaManifest, linkLabel: 'License / terms', url: '../web/licenses/gemma-notices.txt' },
  { id: 'supertonic3', linkLabel: 'License & source', type: 'Supertonic3', title: 'Supertonic 3', size: 'About 399 MB', voices: ['F1', 'M1'], url: '../web/licenses/tts-notices.txt' },
  { id: 'kokoro', linkLabel: 'License & source', type: 'Kokoro', title: 'Kokoro 82M', size: 'About 93 MB', requirements: 'Japanese jf_alpha also needs the separate Kokoro Japanese frontend voice entry.', voices: ['jf_alpha', 'af_heart'], url: '../web/licenses/tts-notices.txt', links: [{ label: 'eSpeak NG source / build bundle (GPL-3.0-or-later)', url: '../web/tts-assets/phonemizer-source.tar.gz' }] },
];
class ModelCard {
  constructor(definition) {
    this.definition = definition; this.ticket = 0; this.caches = new Map(); this.failures = new Map();
    const root = el('section'); root.className = 'panel model-card'; root.id = definition.id;
    root.setAttribute('aria-label', definition.title); this.root = root;
    const heading = el('div'); heading.className = 'model-heading';
    heading.append(el('h3', definition.title));
    const metadata = el('p', definition.size); metadata.className = 'model-metadata';
    root.append(heading, metadata);
    if (definition.voices) {
      const label = el('label', 'Voice '); this.voice = el('select'); this.voice.setAttribute('aria-label', `${definition.title} voice`);
      for (const voice of definition.voices) { const option = el('option', voice === 'jf_alpha' ? 'jf_alpha · Japanese' : voice === 'af_heart' ? 'af_heart · English' : voice); option.value = voice; this.voice.append(option); }
      this.voice.value = savedNodes.find(node => node.type === definition.type)?.settings.voice || definition.voices[0];
      label.append(this.voice); root.append(label);
      this.voice.onchange = () => { void this.inspect(); };
    }
    this.status = el('p', 'Checking cached assets…'); this.status.className = 'model-status'; this.status.setAttribute('role', 'status'); heading.append(this.status);
    this.error = el('p'); this.error.className = 'model-error'; this.error.setAttribute('role', 'alert');
    this.progress = el('progress'); this.progress.hidden = true; this.progress.max = 1; this.progress.value = 0; this.progress.setAttribute('aria-label', `${definition.title} download progress`);
    this.bytes = el('p'); this.bytes.className = 'muted';
    this.files = el('ul'); const details = el('details'); details.className = 'model-details';
    details.append(el('summary', 'Details'), el('h4', 'Verified files and size'), this.bytes, this.files);
    if (definition.requirements) details.append(el('p', definition.requirements));
    const controls = el('div'); controls.className = 'actions';
    const button = (text, action) => { const control = el('button', text); control.type = 'button'; control.onclick = action; controls.append(control); return control; };
    this.prepare = button('Download', () => { void this.run('prepare'); });
    this.prepare.className = 'primary';
    this.cancel = button('Cancel download', () => this.controller?.abort());
    this.remove = button('Delete cached assets', () => { void this.run('remove'); });
    this.remove.className = 'danger';
    // Unknown destinations default to Source rather than promising license coverage.
    const linkLabel = definition.linkLabel || 'Source';
    const link = el('a', linkLabel); link.href = definition.url;
    link.setAttribute('aria-label', `${linkLabel} for ${definition.title}`);
    const license = el('div'); license.className = 'model-license'; license.append(link);
    for (const extra of definition.links || []) {
      const anchor = el('a', extra.label); anchor.href = extra.url;
      license.append(' · ', anchor);
    }
    details.append(license);
    // Keep the Gemma usage warning visible before the download controls.
    if (definition.id === 'translategemma') {
      const notice = el('p', 'Google Gemma use restrictions apply. Read the '); notice.className = 'model-license';
      const terms = el('a', 'Gemma Terms of Use'); terms.href = 'https://ai.google.dev/gemma/terms';
      const policy = el('a', 'Prohibited Use Policy'); policy.href = 'https://ai.google.dev/gemma/prohibited_use_policy';
      notice.append(terms, ' and ', policy, ' before downloading or using.'); root.append(notice);
    }
    root.append(this.error, this.progress, controls, details);
    document.getElementById('models').append(root); this.buttons(); void this.inspect();
  }
  settings() { return { language: 'ja', voice: this.voice?.value }; }
  key() { return this.voice?.value || 'default'; }
  async cache() {
    const key = this.key();
    if (!this.caches.has(key)) this.caches.set(key, (async () => new ModelAssetCache(await (this.definition.manifest ? this.definition.manifest() : ttsManifest(this.definition.type, this.settings()))))());
    try { return await this.caches.get(key); }
    catch (error) { this.caches.delete(key); throw error; }
  }
  buttons() {
    const returnFocus = !this.controller && document.activeElement === this.cancel;
    this.prepare.textContent = this.root.dataset.state === 'Error' ? 'Retry' : 'Download';
    this.prepare.hidden = !!this.busy || !['Not downloaded', 'Error'].includes(this.root.dataset.state);
    for (const control of [this.prepare, this.remove, this.voice].filter(Boolean)) control.disabled = !!this.busy;
    this.cancel.disabled = !this.controller;
    this.cancel.hidden = !this.controller;
    if (returnFocus) (this.prepare.hidden ? this.remove : this.prepare).focus({ preventScroll: true });
  }
  state(state, text = state, error = '') {
    this.root.dataset.state = state; this.status.textContent = text; this.error.textContent = error;
    this.progress.hidden = !['Downloading', 'Checking'].includes(state);
    this.buttons();
  }
  render(view) {
    if (closed) return;
    if (view.state === 'Error') this.failures.set(this.key(), view.error);
    if (view.state === 'Ready') this.failures.delete(this.key());
    this.state(view.state, view.state === 'Ready' ? 'Ready · Cached and verified' : view.state, view.error);
    this.progress.max = view.totalBytes; this.progress.value = view.downloadedBytes;
    this.bytes.textContent = `${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes · ${view.cachedBytes.toLocaleString()} bytes verified cached`;
    this.files.replaceChildren(...view.files.map(file => el('li', `${file.path}: ${file.cached ? 'Cached' : 'Missing'}`)));
  }
  fail(error) {
    if (closed) return;
    const message = `${error.message} Retry to prepare assets; rebuild the extension if its manifest is missing.`;
    this.failures.set(this.key(), message); this.state('Error', 'Error', message);
  }
  async inspect() {
    if (closed) return;
    if (this.busy) { this.pendingInspection = true; return; }
    const ticket = ++this.ticket;
    this.state('Checking', 'Checking cached assets…');
    try {
      const cache = await this.cache();
      if (ticket !== this.ticket || closed) return;
      const view = await cache.inspect();
      if (ticket === this.ticket && !this.busy) {
        // Inspection knows which files exist, but cannot recover a failed download.
        // Keep its actionable error until preparation succeeds or assets are deleted.
        const error = this.failures.get(this.key());
        this.render(view.state === 'Not downloaded' && error ? { ...view, state: 'Error', error } : view);
      }
    }
    catch (error) { if (ticket === this.ticket) this.fail(error); }
  }
  async run(action) {
    if (this.busy || closed || (action === 'prepare' && this.prepare.hidden)) return;
    this.busy = true; ++this.ticket;
    if (action === 'prepare') this.controller = new AbortController();
    this.state(action === 'prepare' ? 'Downloading' : 'Deleting', action === 'prepare' ? 'Downloading · verifying existing files…' : 'Deleting cached assets…');
    try {
      const cache = await this.cache(); this.controller?.signal.throwIfAborted();
      if (action === 'prepare') {
        let announced = false;
        this.render(await cache.prepare({ signal: this.controller.signal, onChange: view => {
          this.render(view);
          // Notify once the cache lock is held, so other pages hide their action
          // while their automatic inspection waits for this preparation.
          if (!announced && !closed) { announced = true; channel.postMessage({ id: this.definition.id }); }
        } }));
      } else {
        const view = await cache.remove();
        if (view.state === 'Error') this.render(view);
        else {
          this.failures.delete(this.key());
          // Only successful explicit deletion retires this variant's old error.
          // Notify before reinspection can wait on another consumer's download.
          if (!closed) channel.postMessage({ id: this.definition.id, deletedKey: this.key() });
          this.state('Checking', 'Checking cached assets…');
          this.render(await cache.inspect());
        }
      }
    } catch (error) { this.fail(error); }
    finally {
      this.busy = false; this.controller = null; this.buttons();
      if (!closed) { channel.postMessage({ id: this.definition.id }); for (const card of cards) if (card !== this && card.definition.id === this.definition.id) void card.inspect(); }
      if (this.pendingInspection) { this.pendingInspection = false; void this.inspect(); }
    }
  }
}
// Sort only the display copy, once. State updates keep these card instances in place.
for (const definition of [...definitions].sort(compareModelDefinitions)) cards.push(new ModelCard(definition));
channel.onmessage = ({ data }) => {
  for (const card of cards) if (card.definition.id === data.id) {
    if (typeof data.deletedKey === 'string') card.failures.delete(data.deletedKey);
    void card.inspect();
  }
};
window.addEventListener('focus', () => { for (const card of cards) void card.inspect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const card of cards) void card.inspect(); });
window.addEventListener('pagehide', () => { closed = true; for (const card of cards) { ++card.ticket; card.controller?.abort(); } channel.close(); });
