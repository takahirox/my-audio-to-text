import { japaneseFrontendManifest } from './japanese-frontend-cache.js';
import { textSummaryManifest } from './text-summary-cache.js';
import { TEXT_PROCESSING_TYPES, textProcessingModel } from '../web/text-summary-models.js';
import { ModelAssetCache } from './model-asset-cache.js';
import { translateGemmaManifest } from './translategemma-cache.js';
import { plamoManifest } from './plamo-cache.js';
import { moonshineManifest, moonshineJapaneseManifest } from './optional-asr-cache.js';
import { ifConditionManifest } from './if-condition-cache.js';
import { ttsManifest } from './tts-cache.js';
import { qwen3TtsManifest } from './qwen3-tts-cache.js';
import { cosyVoice3Manifest } from './cosyvoice3-cache.js';

// Follow every saved model-bearing Node, including parked Nodes. Language does
// not change Supertonic's weights; its voice does. Every ASR model follows Auto Save.
export function graphModelRequirements(graph) {
  const requirements = new Map();
  for (const node of graph.nodes) {
    let requirement;
    const add = (key, title, manifest) => requirements.set(key, { key, id: key, title, manifest });
    if (node.type === 'Kokoro' && node.settings.voice === 'jf_alpha') add('kokoro-japanese', 'Kokoro Japanese · OpenJTalk frontend voice', japaneseFrontendManifest);
    if (TEXT_PROCESSING_TYPES.includes(node.type)) {
      const model = textProcessingModel(node.type), type = node.type;
      requirement = { key: model.key, id: model.key, title: model.label + (type === 'TextProcessingLfm2'
        ? ' · 749 MB · allow 2 GB storage, 4 GB free RAM/GPU per Node (estimate) · WebGPU shader-f16 · LFM 1.0 terms apply (Models)'
        : ' · 1.403 GB · allow 3 GB storage, 6 GB free RAM/GPU per Node (estimate) · WebGPU shader-f16 · Apache 2.0 (Models)'), manifest: () => textSummaryManifest(type) };
    }
    else if (node.type === 'IfCondition') requirement = { key: 'if-condition', id: 'if-condition', title: 'IfCondition · XtremeDistil · 14 MB · CPU WASM · allow 250 MB RAM per Node', manifest: ifConditionManifest };
    else if (node.type === 'Plamo3Translate2B') requirement = { key: 'plamo-3-translate-2b', id: 'plamo-3-translate-2b', title: 'Experimental PLaMo 3 Translate 2B · 1.81 GB download · allow 5 GB storage, 6 GB free RAM per Node · CPU WASM · PLaMo Community License: commercial registration/revenue conditions apply (Models)', manifest: plamoManifest };
    else if (node.type === 'TranslateGemma4B') requirement = { key: 'translategemma', id: 'translategemma', title: 'TranslateGemma 4B · 3.112 GB download · several GB RAM/GPU memory · WebGPU · Gemma Terms apply', manifest: translateGemmaManifest };
    else if (node.type === 'SpeechToTextMoonshineMediumEn') requirement = { key: 'moonshine-medium-en', id: 'moonshine-medium-en', title: 'Moonshine Medium Streaming English · 305 MB download · CPU WASM · allow 2 GB RAM, 700 MB storage', manifest: moonshineManifest };
    else if (node.type === 'SpeechToTextMoonshineSmallJa') requirement = { key: 'moonshine-small-ja', id: 'moonshine-small-ja', title: 'Moonshine Small Streaming Japanese · 122 MB download · CPU WASM · allow 2 GB RAM, 300 MB storage', manifest: moonshineJapaneseManifest };
    else if (node.type === 'Qwen3TtsStreaming') requirement = { key: 'qwen3-tts', id: 'qwen3-tts', title: 'Qwen3-TTS 0.6B CustomVoice · 690 MB · desktop WebGPU · allow 2 GB storage, 6 GB free RAM/GPU (estimate) · Apache 2.0', manifest: qwen3TtsManifest };
    else if (node.type === 'CosyVoice3Streaming') requirement = { key: 'cosyvoice3', id: 'cosyvoice3', title: 'CosyVoice3 0.5B · 917 MB · desktop WebGPU · allow 3 GB storage, 6 GB free RAM/GPU (estimate) · Apache 2.0 + CC BY 4.0 voice', manifest: cosyVoice3Manifest };
    else if (['Supertonic3', 'Kokoro'].includes(node.type)) {
      const { type } = node, settings = { ...node.settings }, id = type.toLowerCase();
      requirement = { key: `${id}:${settings.voice}`, id, title: `${type === 'Supertonic3' ? 'Supertonic 3' : 'Kokoro'} · ${settings.voice}`,
        manifest: () => ttsManifest(type, settings) };
    }
    if (requirement) requirements.set(requirement.key, requirement);
  }
  return [...requirements.values()];
}

// Requirement keys already include model-affecting settings such as voice.
// Order, duplicate Nodes, connections and layout do not change shared assets.
export function graphModelRequirementsFingerprint(graph) {
  return JSON.stringify(graphModelRequirements(graph).map(requirement => requirement.key).sort());
}

// The caller supplies the resolved executable snapshot. Unlike Auto Save this
// must finish successfully before inference resources are initialized. prepare
// checks hashes under the shared model lock and fetches only missing files.
export async function prepareGraphModelAssets(graph, { signal, onChange = () => {},
  createCache = manifest => new ModelAssetCache(manifest) } = {}) {
  for (const requirement of graphModelRequirements(graph)) {
    signal?.throwIfAborted();
    let reportedState;
    const report = view => {
      if (signal?.aborted) return;
      reportedState = view.state;
      onChange(requirement, view);
    };
    report({ state: 'Checking' });
    try {
      const manifest = await requirement.manifest();
      signal?.throwIfAborted();
      const cache = createCache(manifest);
      let view = await cache.inspect({ signal, onChange: report });
      signal?.throwIfAborted();
      // Cached graphs take the read-only fast path. A missing-file prepare
      // rechecks under the same lock in case another consumer finished first.
      if (view.state === 'Not downloaded') view = await cache.prepare({ signal, onChange: report });
      signal?.throwIfAborted();
      if (view.state !== reportedState) report(view);
      if (view.state !== 'Ready') throw Error(view.error || 'Model files did not become ready.');
    } catch (error) {
      signal?.throwIfAborted();
      if (reportedState !== 'Error') report({ state: 'Error', error: error.message || String(error) });
      throw Error(`${requirement.title}: ${error.message || error}`, { cause: error });
    }
  }
}

// Asset preparation only. Call replace only after validation and persistence.
// Each run owns its signal, so new requirements or teardown cannot publish stale state.
export class GraphModelPreparation {
  constructor({ createCache = manifest => new ModelAssetCache(manifest), onChange = () => {}, onComplete = () => {} } = {}) {
    Object.assign(this, { createCache, onChange, onComplete });
    this.entries = []; this.closed = false; this.runs = new Map(); this.requirementsFingerprint = null;
  }
  replace(graph, { inspect = false } = {}) {
    if (this.closed) return;
    const fingerprint = graphModelRequirementsFingerprint(graph);
    if (fingerprint === this.requirementsFingerprint) return;
    const requirements = graphModelRequirements(graph), previous = new Map(this.entries.map(entry => [entry.key, entry]));
    this.requirementsFingerprint = fingerprint;
    for (const entry of this.entries) if (!requirements.some(item => item.key === entry.key)) entry.controller?.abort();
    this.entries = requirements.map(requirement => previous.get(requirement.key) || { ...requirement, view: { state: 'Queued', downloadedBytes: 0, totalBytes: 0, error: '' } });
    this.onChange(this.entries);
    for (const entry of this.entries) {
      if (!inspect && entry.inspecting) entry.wantsPrepare = true;
      if (entry.view.state === 'Queued' || (!inspect && entry.view.state === 'Not downloaded')) void this.run(entry, inspect);
    }
  }
  publish(entry, view) {
    if (this.closed || !this.entries.includes(entry)) return;
    entry.view = view; this.onChange(this.entries);
  }
  cancel(entry) { entry.controller?.abort(); }
  run(entry, inspect = false) {
    if (this.closed || entry.controller || !this.entries.includes(entry)) return;
    const controller = new AbortController(); entry.controller = controller; entry.inspecting = inspect;
    const previous = this.runs.get(entry.key);
    const task = (async () => {
      this.publish(entry, { ...entry.view, state: 'Checking', error: '' });
      try {
        if (previous) await previous;
        controller.signal.throwIfAborted();
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
        const prepareNext = inspect && entry.wantsPrepare && entry.view.state === 'Not downloaded';
        entry.inspecting = false; entry.wantsPrepare = false;
        if (prepareNext) queueMicrotask(() => { void this.run(entry); });
        if (!this.closed && this.entries.includes(entry)) {
          this.onChange(this.entries);
          if (!inspect) this.onComplete(entry.id);
        }
      }
    })();
    this.runs.set(entry.key, task);
    void task.finally(() => { if (this.runs.get(entry.key) === task) this.runs.delete(entry.key); });
    return task;
  }
  inspect(id) {
    for (const entry of this.entries) if (!id || entry.id === id) void this.run(entry, true);
  }
  clear() {
    if (this.closed) return;
    for (const entry of this.entries) entry.controller?.abort();
    this.entries = []; this.requirementsFingerprint = null; this.onChange(this.entries);
  }
  close() {
    this.closed = true;
    for (const entry of this.entries) entry.controller?.abort();
  }
}
