import { Microphone } from '../web/audio.js';
import { BrowserTabAudioNode } from '../web/transcription-nodes.js';
import { displayInputs } from '../web/display-node.js';
import { snapshotItem } from '../web/paired-text.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { graphActions, pressGraphButton } from '../extension/graph-actions.js';
import { prepareGraphModelAssets } from '../extension/graph-model-preparation.js';
import { FOCUSED_OUTPUT, MICROPHONE } from './graph.js';
import { desktopAssetCache, desktopModels } from './models.js';
import { FocusedApplicationTextOutputNode } from './focused-output.js';

const host = window.runtimeHost;
const cachePromises = new Map();
let current, download;

function modelCache(key) {
  const model = desktopModels.find(model => model.key === key);
  if (!model) throw Error('Unknown desktop model.');
  if (!cachePromises.has(key)) cachePromises.set(key, model.manifest().then(desktopAssetCache)
    .catch(error => { cachePromises.delete(key); throw error; }));
  return cachePromises.get(key);
}

class DesktopMicrophoneNode extends BrowserTabAudioNode {
  constructor(fail, onStopped) {
    super({
      onEnded: () => fail('The system microphone disconnected. Check the default input and start again.'),
      sourceFactory: (onAudio, ended) => new Microphone(onAudio, ended),
    });
    this.onStopped = onStopped;
  }

  async start(context) {
    try { await super.start(context); }
    catch (error) {
      throw Error(`Microphone unavailable: ${error.message}. Check the system microphone permission and default input, then retry.`);
    }
  }

  async stop() {
    await super.stop();
    this.onStopped();
  }
}

// The runtime owns delivery and snapshots. Live renders the shared ITEM view.
class DesktopDisplayNode {
  outputs = {};
  constructor(settings, show) { this.inputs = displayInputs(settings.inputCount); this.show = show; }
  start(context) { this.signal = context.signal; }
  receiveInputs(values, context) {
    if (context.signal !== this.signal || context.signal.aborted) return;
    for (const [port, item] of Object.entries(values)) {
      this.show(port, snapshotItem(item), context.provisionalInputs.includes(port));
    }
  }
}

async function start(id, graph) {
  if (current) throw Error('A desktop graph is already running.');
  const controller = new AbortController(), { signal } = controller;
  const owner = { id, controller };
  current = owner;
  const active = () => current === owner && !signal.aborted;
  const fail = message => { if (active()) host.failure(id, message); };
  const status = (node, message, severity, needsActivation) => {
    if (active()) host.status(id, node, message, severity, needsActivation);
  };
  const onEvent = (event, node) => {
    if (event.message) status(node, event.message, event.severity || (event.type === 'error' ? 'error' : undefined));
  };
  try {
    const runtime = buildGraph(graph, {
      preload: true,
      formatterOptions: { separatePreviews: true },
      hostNodes: {
        [MICROPHONE]: () => new DesktopMicrophoneNode(fail, () => host.captureEnded(id)),
        [FOCUSED_OUTPUT]: () => new FocusedApplicationTextOutputNode(text => host.insert(id, text)),
        Display: ({ id: node, settings }) => new DesktopDisplayNode(settings, (port, item, provisional) => {
          if (active()) host.display(id, node, port, item, provisional);
        }),
      },
      onError(error, node) {
        if (runtime.audioSources.has(node) || graph.nodes.some(spec => spec.id === node && spec.type === FOCUSED_OUTPUT)) fail(error.message);
        else { status(node, error.message, 'error'); owner.publishActions?.(); }
      },
      onSpeechEvent(event, node) {
        onEvent(event, node);
        if (event.type === 'error' && owner.pipeline?.state === 'running' && graph.nodes.some(spec => spec.type === FOCUSED_OUTPUT)) fail(event.message);
      },
      onTextProcessingEvent: onEvent,
      onIfConditionEvent: onEvent,
      onTtsState: (message, node, event) => onEvent({ ...event, message }, node),
      onTranslationState: (message, node, severity) => status(node, message, severity),
      onHoldState: (state, node) => status(node, state),
      onSpeakerState: (state, node) => status(node, state.message, state.severity, state.needsActivation),
      onFloatingDisplay: text => { if (active()) host.floatingDisplay(id, text); },
      onSynthesizedAudio: (audio, audioSignal, node) => { if (active() && !audioSignal.aborted) host.audio(id, node, audio); },
      onModelProgress: (node, index, total) => status(node, `Loading local model ${index} of ${total}…`),
    });
    Object.assign(owner, runtime);
    const publishPreparation = throttledProgress((model, view) => host.preparation(id, model.key, model.title, view));
    await prepareGraphModelAssets(runtime.description, {
      signal, createCache: desktopAssetCache, onChange: publishPreparation,
    });
    await runtime.prepareModels();
    signal.throwIfAborted();
    if (runtime.audioSources.size) await host.microphone(id);
    signal.throwIfAborted();
    await runtime.pipeline.start();
    signal.throwIfAborted();
    if (runtime.pipeline.state !== 'running') throw Error('The graph could not start. Check Live for node errors and retry.');
    owner.publishActions = () => host.actions(id, graphActions(owner.description, owner, true));
    owner.publishActions();
  } catch (error) {
    await close(owner);
    throw error;
  }
}

async function close(owner) {
  owner.controller.abort();
  try { await owner.pipeline?.dispose(); }
  finally { if (current === owner) current = null; }
}

function modelProgress({ state, error, downloadedBytes, totalBytes, cachedBytes }) {
  return { state, error, downloadedBytes, totalBytes, cachedBytes };
}

function throttledProgress(publish) {
  let previous, time = 0;
  return (model, view) => {
    const marker = `${model.key}:${view.state}`;
    if (view.state === 'Downloading' && marker === previous && performance.now() - time < 100) return;
    previous = marker;
    time = performance.now();
    publish(model, modelProgress(view));
  };
}

const commands = {
  start,
  async stop(id) {
    const owner = current;
    if (owner?.id !== id) return;
    try { await owner.pipeline.stop(); }
    finally { await close(owner); }
  },
  async cancel(id) {
    const owner = current;
    if (owner?.id !== id) return;
    owner.controller.abort();
    try { await owner.pipeline?.cancel(); }
    finally { await close(owner); }
  },
  enableSpeakers(id) {
    if (current?.id !== id) return;
    for (const spec of current.description.nodes) {
      if (spec.type === 'SpeakerOutput') current.pipeline.entries.get(spec.id).node.enable();
    }
  },
  press(id, node) {
    const owner = current;
    if (owner?.id !== id) return false;
    return pressGraphButton(owner, node, {
      running: true, owns: () => current === owner, onChange: owner.publishActions,
    });
  },
  async modelStatus(key) { return modelProgress(await (await modelCache(key)).inspect()); },
  async modelPrepare(key) {
    if (download) throw Error('Model preparation is already running.');
    const controller = new AbortController();
    download = controller;
    const status = view => controller.signal.aborted && view.state !== 'Ready'
      ? { ...modelProgress(view), state: 'Canceled', error: 'Model preparation canceled. Retry to finish downloading.' } : modelProgress(view);
    try {
      const cache = await modelCache(key);
      const progress = throttledProgress((_model, view) => host.modelProgress(key, view));
      const result = await cache.prepare({ signal: controller.signal, onChange: view => progress({ key }, status(view)) });
      return status(result);
    } finally { download = null; }
  },
  modelCancel() { download?.abort(); },
  async modelDelete(key) {
    if (current || download) throw Error('Stop the running session or download before deleting the model.');
    return modelProgress(await (await modelCache(key)).remove());
  },
};

host.onCommand(async ({ request, action, args }) => {
  try { host.respond({ request, value: await commands[action](...args) }); }
  catch (error) { host.respond({ request, error: error.message }); }
});
host.ready();
