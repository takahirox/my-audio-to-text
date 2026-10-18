import { ModelAssetCache } from './model-asset-cache.js';
import { opusMtManifest } from './opus-mt-manifest.js';
import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { translateGemmaManifest } from './translategemma-cache.js';
import { parakeetManifest, moonshineManifest } from './optional-asr-cache.js';
import { ifConditionManifest } from './if-condition-cache.js';
import { ttsManifest } from './tts-cache.js';

// Follow every saved model-bearing Node, including parked Nodes. Language does
// not change Supertonic's weights; its voice does. Existing ASR assets stay packaged; optional ASR weights follow Save.
export function graphModelRequirements(graph) {
  const requirements = new Map();
  for (const node of graph.nodes) {
    let requirement;
    if (node.type === 'IfCondition') requirement = { key: 'if-condition', id: 'if-condition', title: 'IfCondition · XtremeDistil · 14 MB · CPU WASM · allow 250 MB RAM per Node', manifest: ifConditionManifest };
    else if (node.type === 'OpusMtJaEn') requirement = { key: 'opus-ja-en', id: 'opus-ja-en', title: 'OPUS-MT · Japanese → English', manifest: opusMtManifest };
    else if (node.type === 'OpusMtEnJa') requirement = { key: 'opus-en-ja', id: 'opus-en-ja', title: 'OPUS-MT · English → Japanese', manifest: englishToJapaneseOpusMtManifest };
    else if (['TranslateGemmaEnJa', 'TranslateGemmaJaEn'].includes(node.type)) requirement = { key: 'translategemma', id: 'translategemma', title: 'TranslateGemma 4B · 3.112 GB download · several GB RAM/GPU memory · WebGPU · Gemma Terms apply', manifest: translateGemmaManifest };
    else if (node.type === 'SpeechToTextParakeetV3') requirement = { key: 'parakeet-v3', id: 'parakeet-v3', title: 'Parakeet v3 · 1.26 GB download · WebGPU shader-f16 · allow 6 GB RAM/GPU memory, 3 GB storage', manifest: parakeetManifest };
    else if (node.type === 'SpeechToTextMoonshineMediumEn') requirement = { key: 'moonshine-medium-en', id: 'moonshine-medium-en', title: 'Moonshine Medium English Streaming · 305 MB download · CPU WASM · allow 2 GB RAM, 700 MB storage', manifest: moonshineManifest };
    else if (['Supertonic3', 'Kokoro'].includes(node.type)) {
      const { type } = node, settings = { ...node.settings }, id = type.toLowerCase();
      requirement = { key: `${id}:${settings.voice}`, id, title: `${type === 'Supertonic3' ? 'Supertonic 3' : 'Kokoro'} · ${settings.voice}`,
        manifest: () => ttsManifest(type, settings) };
    }
    if (requirement) requirements.set(requirement.key, requirement);
  }
  return [...requirements.values()];
}

// Asset preparation only. Call replace only after validation and persistence.
// Each run owns its signal, so a new Save or teardown cannot publish stale state.
export class GraphModelPreparation {
  constructor({ createCache = manifest => new ModelAssetCache(manifest), onChange = () => {}, onComplete = () => {} } = {}) {
    Object.assign(this, { createCache, onChange, onComplete });
    this.entries = []; this.closed = false;
  }
  replace(graph) {
    if (this.closed) return;
    for (const entry of this.entries) entry.controller?.abort();
    this.entries = graphModelRequirements(graph).map(requirement => ({ ...requirement, view: { state: 'Queued', downloadedBytes: 0, totalBytes: 0, error: '' } }));
    this.onChange(this.entries);
    for (const entry of this.entries) void this.run(entry);
  }
  publish(entry, view) {
    if (this.closed || !this.entries.includes(entry)) return;
    entry.view = view; this.onChange(this.entries);
  }
  cancel(entry) { entry.controller?.abort(); }
  async run(entry, inspect = false) {
    if (this.closed || entry.controller || !this.entries.includes(entry)) return;
    const controller = new AbortController(); entry.controller = controller;
    this.publish(entry, { ...entry.view, state: 'Checking', error: '' });
    try {
      if (!entry.cache) entry.cache = this.createCache(await entry.manifest());
      controller.signal.throwIfAborted();
      const update = view => this.publish(entry, controller.signal.aborted ? { ...view, state: 'Canceled', error: 'Preparation canceled. Retry or open Models to recover.' } : view);
      const view = await (inspect ? entry.cache.inspect({ signal: controller.signal })
        : entry.cache.prepare({ signal: controller.signal, onChange: update }));
      update(view);
    } catch (error) {
      this.publish(entry, { ...entry.view, state: controller.signal.aborted ? 'Canceled' : 'Error',
        error: controller.signal.aborted ? 'Preparation canceled. Retry or open Models to recover.' : `${error.message} Retry or open Models to recover.` });
    } finally {
      entry.controller = null;
      if (!this.closed && this.entries.includes(entry)) {
        this.onChange(this.entries);
        if (!inspect) this.onComplete(entry.id);
      }
    }
  }
  inspect(id) {
    for (const entry of this.entries) if (!id || entry.id === id) void this.run(entry, true);
  }
  clear() {
    if (this.closed) return;
    for (const entry of this.entries) entry.controller?.abort();
    this.entries = []; this.onChange(this.entries);
  }
  close() {
    this.closed = true;
    for (const entry of this.entries) entry.controller?.abort();
  }
}
