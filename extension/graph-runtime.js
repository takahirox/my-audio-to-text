import { ButtonNode } from '../web/button-node.js';
import { HoldNode } from '../web/hold-node.js';
import { TextSummaryNode } from '../web/text-summary-node.js';
import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';
import { verifiedTranslateGemmaCache } from './translategemma-cache.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';
import { AudioOutputNode } from '../web/synthesized-audio.js';
import { SpeakerOutputNode, StreamingSpeakerOutputNode } from '../web/speaker-output.js';
import { Qwen3TtsNode } from '../web/qwen3-tts-node.js';
import { CosyVoice3Node } from '../web/cosyvoice3-node.js';
import { ExtensionTab } from './tab-source.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';
import { TranslationSchedulerNode } from './translation-scheduler.js';
import { FocusedInputTextOutputNode } from './page-output-node.js';
import { SelectedPageMediaAudioNode, ExtensionMicrophoneAudioNode } from './media-source.js';
import { TextAccumulatorNode, TextFormatterNode } from '../web/text-nodes.js';
import { executableGraph, INPUT_TYPES, ASR_TYPES, nodeDefinition } from './graph.js';
import { verifiedTtsCache } from './tts-cache.js';
import { TextNode } from '../web/text-constant-node.js';
import { SpeechToTextWhisperNode } from '../web/whisper-node.js';
import { SpeechToTextZipformerEnNode } from '../web/zipformer-node.js';
import { SpeechToTextParakeetV3Node } from '../web/parakeet-v3-node.js';
import { SpeechToTextMoonshineMediumEnNode } from '../web/moonshine-medium-node.js';
import { IfConditionNode } from '../web/if-condition-node.js';
import { NumberNode } from '../web/number-node.js';
import { DisplayNode } from '../web/display-node.js';
import { KeyedPairedTextAccumulatorNode } from '../web/keyed-paired-text-accumulator-node.js';
import { KeyedTextPairNode } from '../web/keyed-text-pair-node.js';
import { KeyedTextCoalesceNode } from '../web/keyed-text-coalesce-node.js';
import { TextSlidingWindowNode } from '../web/text-sliding-window-node.js';
import { TextWindowNode } from '../web/text-window-node.js';
import { graphModelRequirements } from './graph-model-preparation.js';

// Branch-local lifecycle adapter around an actual production TTS Node. Missing
// assets, initialization or synthesis failure must leave transcription usable.
class PreparedTtsNode {
  constructor(node, type, settings, onState, prepare) {
    this.node = node; this.type = type; this.settings = settings; this.onState = onState; this.prepare = prepare;
    this.inputs = node.inputs; this.outputs = node.outputs;
  }
  failure(error) { this.failed = true; this.onState(`Audio unavailable: ${error.message || error}`, 'error'); return this.node.dispose(); }
  async start(context) {
    this.context = context;
    try {
      await this.prepare(this.type, this.settings, context.signal);
      context.signal.throwIfAborted();
      await this.node.start({ ...context, fail: error => { void this.failure(error); } });
      if (!this.failed) this.onState(`${this.type} ready (local)`);
    } catch (error) { if (!context.signal.aborted) await this.failure(error); }
  }
  async receive(port, text, context) {
    if (this.failed) return;
    try {
      // TTS's size bound belongs to its branch, so TEXT fan-out preserves a
      // whole final utterance for page editing and other string consumers.
      let remaining = text;
      while (remaining && !this.failed && !context.signal.aborted) {
        let end = Math.min(300, remaining.length);
        if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
        await this.node.receive(port, remaining.slice(0, end), context);
        remaining = remaining.slice(end);
      }
    }
    catch (error) { if (!context.signal.aborted) await this.failure(error); }
  }
  async stop() {
    if (!this.failed) try { await this.node.stop(); } catch (error) { if (!this.context.signal.aborted) await this.failure(error); }
  }
  dispose() { return this.node.dispose(); }
}

// Chrome permits one capture of a tab. Repeated tab Source Nodes subscribe to
// the same normalized capture; ending one subscriber must not end its peers.
function sharedTabCapture(factory, stopping) {
  let capture;
  return (tabId, onAudio, onEnded) => {
    const listener = { onAudio, onEnded };
    let owned;
    return {
      start() {
        if (!capture) {
          const listeners = new Set();
          const shared = { listeners };
          shared.source = factory(tabId,
            audio => { for (const item of listeners) item.onAudio(audio); },
            () => {
              shared.ended = true;
              for (const item of [...listeners]) item.onEnded();
            });
          capture = shared;
        }
        owned = capture; owned.listeners.add(listener);
        return owned.starting ??= Promise.resolve().then(() => owned.source.start());
      },
      async stop(flush = true) {
        if (!owned || !owned.listeners.has(listener)) return;
        if (owned.listeners.size > 1 && !owned.ended && !stopping()) { owned.listeners.delete(listener); return; }
        if (capture === owned) capture = null;
        // Whole-graph Stop and native end flush before any subscriber closes.
        // Pipeline drains sources sequentially, so waiting for the last one
        // would lose the final worklet/resampler PCM in earlier branches.
        // Cancellation must still interrupt an in-progress graceful flush.
        if (flush) await (owned.stopping ??= Promise.resolve().then(() => owned.source.stop(true)));
        else await owned.source.stop(false);
        owned.listeners.delete(listener);
      },
    };
  };
}

// Evaluate only configuration ancestors, with fresh data-node state and the
// ordinary Pipeline delivery/grouping/sampling semantics. Resource owners,
// buttons, triggered gates and sinks are inert declarations: this pass cannot
// capture, infer, fire a trigger or publish output. Dispose even timer-backed
// data nodes before initializing models; Start gets untouched processing state.
const startupDataNodes = { Text: TextNode, Number: NumberNode, TextFormatter: TextFormatterNode,
  TextAccumulator: TextAccumulatorNode, TextSlidingWindow: TextSlidingWindowNode, TextWindow: TextWindowNode,
  KeyedTextCoalesce: KeyedTextCoalesceNode, KeyedTextPair: KeyedTextPairNode,
  KeyedPairedTextAccumulator: KeyedPairedTextAccumulatorNode, Hold: HoldNode };
async function startupValues(graph, configurations, signal, timeoutMs) {
  const needed = new Set(), pending = [...configurations.values()].map(route => route.from[0]);
  while (pending.length) {
    const id = pending.pop();
    if (needed.has(id)) continue;
    needed.add(id);
    for (const route of graph.edges) if (route.to[0] === id) pending.push(route.from[0]);
  }
  const nodes = {}, connections = graph.edges.filter(route => needed.has(route.from[0]) && needed.has(route.to[0]));
  for (const spec of graph.nodes.filter(node => needed.has(node.id))) {
    const Node = startupDataNodes[spec.type];
    const triggered = spec.type === 'Hold' && graph.edges.some(route => route.to[0] === spec.id && route.to[1] === 'trigger');
    const definition = nodeDefinition(spec, graph);
    nodes[spec.id] = Node && !triggered ? new Node(spec.settings)
      : { inputs: definition.inputs, outputs: definition.outputs, receive() {} };
  }
  const values = new Map();
  let wake;
  for (const [id, route] of configurations) {
    let sink = `${id}:startup`;
    while (Object.hasOwn(nodes, sink)) sink += ':';
    nodes[sink] = { inputs: { value: nodeDefinition(graph.nodes.find(node => node.id === id), graph).inputs[route.to[1]] },
      outputs: {}, receive: (_, value) => { values.set(id, value); wake?.(); } };
    connections.push({ from: route.from, to: [sink, 'value'] });
  }
  const startup = new Pipeline({ nodes, connections, onError: () => wake?.() });
  const abort = () => { void startup.dispose(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await startup.start();
    const deadline = Date.now() + timeoutMs;
    while (true) {
      // Settle startup deliveries without Stop's synthetic tail flushes. A
      // constant-fed TextWindow may legitimately deliver after its own timer.
      for (const entry of startup.order) await startup.wait(entry, entry.queue);
      if (startup.errors.length || values.size === configurations.size || !startup.order.some(entry => entry.node.timer != null)) break;
      let timer;
      try {
        await startup.wait(startup.order[0], new Promise(resolve => {
          wake = resolve; timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }));
      } finally { wake = null; clearTimeout(timer); }
      if (Date.now() >= deadline && values.size !== configurations.size) throw Error('Startup configuration timed out. Supply configuration before capture in Graph Editor and Save.');
    }
    signal.throwIfAborted();
    if (startup.errors.length) throw startup.errors[0];
    return values;
  } finally {
    signal.removeEventListener('abort', abort);
    await startup.dispose();
  }
}

export function buildGraph(graph, options) {
  const description = executableGraph(graph);
  if (!description.nodes.length) throw Error('No executable path. Connect a source through complete processors to an output destination.');
  // Defer summary resources on event-gated paths. Ordinary graphs retain
  // their startup/preflight behavior, including startup failure reporting.
  const gatedAncestor = id => {
    const pending = [id], visited = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      if (description.nodes.some(node => node.id === current && node.type === 'Hold') &&
        description.edges.some(route => route.to[0] === current && route.to[1] === 'trigger')) return true;
      for (const route of description.edges) if (route.to[0] === current) pending.push(route.from[0]);
    }
    return false;
  };
  let pipeline;
  const nodes = {}, resources = { translations: [], audioSources: new Map(), speechNodes: new Map() };
  const tabSources = description.nodes.filter(spec => spec.type === 'ChromeTabAudio');
  // Toolbar-tab navigation ends every tab subscriber even while a microphone
  // keeps the Pipeline running. Flush before detaching any of those subscribers.
  // Share only among tab-source Nodes inside this execution. Another graph
  // gets a fresh capture factory, nodes, Workers and Pipeline.
  const tabSourceFactory = sharedTabCapture(options.sourceFactory || ((...args) => new ExtensionTab(...args)),
    () => pipeline.state === 'stopping' || tabSources.every(spec => nodes[spec.id].endRequested));
  for (const spec of description.nodes) {
    let node;
    switch (spec.type) {
      case 'Button': node = new ButtonNode(); break;
      case 'Hold': node = new HoldNode({ onState: state => options.onHoldState?.(state, spec.id) }); break;
      case 'Text': node = new TextNode(spec.settings); break;
      case 'TextSummaryLfm2': case 'TextSummaryQwen35':
        node = new TextSummaryNode({ ...spec.settings, lazy: !options.preload && gatedAncestor(spec.id), type: spec.type, workerFactory: options.textSummaryWorkerFactory,
          onEvent: event => options.onTextSummaryEvent?.(event, spec.id) }); break;
      case 'IfCondition':
        node = new IfConditionNode({ ...spec.settings, workerFactory: options.ifConditionWorkerFactory,
          onEvent: event => options.onIfConditionEvent?.(event, spec.id) }); break;
      case 'Number': node = new NumberNode(spec.settings); break;
      case 'ChromeTabAudio':
        node = new ExtensionTabAudioNode(options.tabId, { sourceFactory: tabSourceFactory, onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'SelectedPageMediaAudio':
        node = new SelectedPageMediaAudioNode({ onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'MicrophoneAudio':
        node = new ExtensionMicrophoneAudioNode(options.microphoneStreams?.get(spec.id), { microphoneSourceFactory: options.microphoneSourceFactory, onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'FocusedInputTextOutputNode':
        node = new FocusedInputTextOutputNode({ target: options.outputTarget?.tabId === options.tabId ? options.outputTarget : undefined, connectionFactory: options.pageConnectionFactory, onState: (state, active, severity) => options.onTargetState?.(spec.id, state, active, severity) }); break;
      case 'SpeechToTextParakeetV3':
        node = new SpeechToTextParakeetV3Node({ workerFactory: options.parakeetWorkerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextMoonshineMediumEn':
        node = new SpeechToTextMoonshineMediumEnNode({ workerFactory: options.moonshineWorkerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextZipformerEn':
        node = new SpeechToTextZipformerEnNode({ workerFactory: options.zipformerWorkerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextWhisper':
        node = new SpeechToTextWhisperNode({ configurationConnected: graph.edges.some(route => route.to[0] === spec.id && route.to[1] === 'language'), workerFactory: options.whisperWorkerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextReazonSpeech':
        node = new SpeechToTextNode({ configurationConnected: graph.edges.some(route => route.to[0] === spec.id && route.to[1] === 'maxDuration'), workerFactory: options.workerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'KeyedTextPair': node = new KeyedTextPairNode(); break;
      case 'KeyedPairedTextAccumulator': node = new KeyedPairedTextAccumulatorNode(); break;
      case 'Display': node = new DisplayNode((dom, port) => options.onDisplay?.(spec.id, dom, port), spec.settings); break;
      case 'TextAccumulator': node = new TextAccumulatorNode(); break;
      case 'TextSlidingWindow': node = new TextSlidingWindowNode(); break;
      case 'TextWindow': node = new TextWindowNode(); break;
      case 'TextFormatter': node = new TextFormatterNode(spec.settings); break;
      case 'KeyedTextCoalesce': node = new KeyedTextCoalesceNode(); break;
      case 'TranslateGemmaEnJa': case 'TranslateGemmaJaEn':
        node = new TranslationSchedulerNode({ prepare: options.prepareTranslateGemma || verifiedTranslateGemmaCache,
          TranslationNode: spec.type === 'TranslateGemmaEnJa' ? EnglishToJapaneseTranslateGemmaTranslationNode : TranslateGemmaTranslationNode,
          modelName: 'TranslateGemma 4B', workerFactory: options.translationWorkerFactory,
          onState: (state, severity) => options.onTranslationState?.(state, spec.id, severity) }); resources.translations.push(node); break;
      case 'OpusMtJaEn': case 'OpusMtEnJa':
        node = new TranslationSchedulerNode({ prepare: signal => options.prepareTranslation?.(signal, spec.type === 'OpusMtEnJa' ? 'en-ja' : 'ja-en'),
          TranslationNode: spec.type === 'OpusMtEnJa' ? EnglishToJapaneseOpusMtTranslationNode : OpusMtTranslationNode,
          workerFactory: options.translationWorkerFactory, onState: (state, severity) => options.onTranslationState?.(state, spec.id, severity) }); resources.translations.push(node); break;
      case 'Supertonic3': case 'Kokoro': {
        const Node = spec.type === 'Supertonic3' ? Supertonic3TextToSpeechNode : KokoroTextToSpeechNode;
        const production = new Node({ ...spec.settings, workerFactory: options.ttsWorkerFactory,
          loadOptions: { cacheOnly: true }, onEvent: event => options.onTtsState?.(`${spec.id}: ${event.message || event.type}`, spec.id, event) });
        node = new PreparedTtsNode(production, spec.type, spec.settings, (state, severity) => options.onTtsState?.(`${spec.id}: ${state}`, spec.id, { severity, message: state }), options.prepareTts || verifiedTtsCache); break;
      }
      case 'AudioOutput': node = new AudioOutputNode(options.onSynthesizedAudio); break;
      case 'Qwen3TtsStreaming': node = new Qwen3TtsNode({ ...spec.settings, workerFactory: options.ttsWorkerFactory,
        onEvent: event => options.onTtsState?.(`${spec.id}: ${event.message || event.type}`, spec.id, event) }); break;
      case 'CosyVoice3Streaming': node = new CosyVoice3Node({ ...spec.settings, workerFactory: options.ttsWorkerFactory,
        onEvent: event => options.onTtsState?.(`${spec.id}: ${event.message || event.type}`, spec.id, event) }); break;
      case 'StreamingSpeakerOutput': node = options.speakers?.get(spec.id) || new StreamingSpeakerOutputNode({
        contextFactory: options.speakerContextFactory, onState: state => options.onSpeakerState?.(state, spec.id),
      }); break;
      case 'SpeakerOutput': node = options.speakers?.get(spec.id) || new SpeakerOutputNode({
        contextFactory: options.speakerContextFactory, onState: state => options.onSpeakerState?.(state, spec.id),
      }); break;
      default: throw new Error(`Unsupported Node: ${spec.type}`);
    }
    nodes[spec.id] = node;
    if (INPUT_TYPES.includes(spec.type)) resources.audioSources.set(spec.id, node);
    if (ASR_TYPES.includes(spec.type)) resources.speechNodes.set(spec.id, node);
  }
  // Resolve startup data on isolated composition nodes, without running the
  // Live graph's hooks. Remove just these deliveries in the Live runtime
  // so Start cannot run a second configuration pass against already warm ASR.
  const configurations = new Map();
  if (options.preload) for (const [id, node] of resources.speechNodes) {
    // Preserve intent even if the configuration producer is incomplete/parked.
    const route = graph.edges.find(route => route.to[0] === id && route.to[1] === node.configurationPort);
    if (route) configurations.set(id, route);
  }
  const connections = description.edges.filter(route => configurations.get(route.to[0])?.to[1] !== route.to[1]);
  pipeline = new Pipeline({ nodes, connections, onError: options.onError });
  let preparing;
  const prepareModels = () => preparing ??= (async () => {
    const values = configurations.size ? await startupValues(graph, configurations, pipeline.order[0].controller.signal, options.modelLoadTimeoutMs ?? 180000) : new Map();
    const models = description.nodes.filter(spec => ASR_TYPES.includes(spec.type) || graphModelRequirements({ nodes: [spec] }).length);
    for (const [index, spec] of models.entries()) {
      const entry = pipeline.entries.get(spec.id), node = entry.node;
      options.onModelProgress?.(spec.id, index + 1, models.length);
      let timeout;
      try {
        entry.controller.signal.throwIfAborted();
        const bounded = work => pipeline.wait(entry, Promise.race([work, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(Error('Model initialization timed out. Check browser support and free RAM/GPU memory, then Retry models.')), options.modelLoadTimeoutMs ?? 180000);
        })]));
        if (resources.speechNodes.has(spec.id)) {
          const route = configurations.get(spec.id);
          if (route) {
            if (!values.has(spec.id)) throw Error('Startup configuration is unavailable before capture. Connect startup data in Graph Editor and Save; audio, model output and button-triggered values are not available yet.');
            node.receive(node.configurationPort, values.get(spec.id));
          }
          node.configurationConnected = false;
          node.preconfigured = true;
          await bounded(node.load());
          if (node.unavailable || node.core?.state !== 'ready') throw Error('ASR model did not become ready. Check model assets, browser support and available memory.');
        } else {
          // These hooks only initialize owned inference resources. Keep their
          // exact context/signal for Start, and never call the hook twice.
          await bounded(Promise.resolve(node.start(entry.context)).then(() => node.ready));
          if (node.failed || node.disposed || node.error || entry.failed) throw Error(node.error?.message || node.error || 'Model initialization failed.');
          node.start = context => {
            context.signal.throwIfAborted();
            if (context !== entry.context) throw Error('Prepared model belongs to another runtime.');
          };
        }
        entry.controller.signal.throwIfAborted();
      } catch (cause) {
        if (!entry.controller.signal.aborted) pipeline.fail(entry, cause);
        throw Error(`${spec.id} (${spec.type}): ${cause.message || cause}`, { cause });
      } finally { clearTimeout(timeout); }
    }
  })();
  return { ...resources, description, pipeline, prepareModels };
}
