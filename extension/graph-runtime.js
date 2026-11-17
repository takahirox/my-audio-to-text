import { ButtonNode } from '../web/button-node.js';
import { HoldNode } from '../web/hold-node.js';
import { TextProcessingNode } from '../web/text-summary-node.js';
import { Pipeline } from '../web/pipeline.js';
import { TranslateGemmaTranslationNode, Plamo3Translate2BTranslationNode } from '../web/translation-nodes.js';
import { verifiedPlamoCache } from './plamo-cache.js';
import { verifiedTranslateGemmaCache } from './translategemma-cache.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';
import { AudioOutputNode } from '../web/synthesized-audio.js';
import { SpeakerOutputNode } from '../web/speaker-output.js';
import { Qwen3TtsNode } from '../web/qwen3-tts-node.js';
import { CosyVoice3Node } from '../web/cosyvoice3-node.js';
import { ExtensionTab } from './tab-source.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';
import { TranslationSchedulerNode } from './translation-scheduler.js';
import { FocusedInputTextOutputNode } from './page-output-node.js';
import { ExtensionMicrophoneAudioNode } from './media-source.js';
import { TextAccumulatorNode, TextFormatterNode } from '../web/text-nodes.js';
import { executableGraph, INPUT_TYPES, ASR_TYPES } from './graph.js';
import { verifiedTtsCache } from './tts-cache.js';
import { TextNode } from '../web/text-constant-node.js';
import { SpeechToTextMoonshineSmallJaNode } from '../web/moonshine-small-ja-node.js';
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
            audio => { for (const item of listeners) item.onAudio(audio.slice()); },
            error => {
              shared.ended = true;
              for (const item of [...listeners]) item.onEnded(error);
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

export function buildGraph(graph, options) {
  const description = executableGraph(graph);
  if (!description.nodes.length) throw Error('No executable path. Connect a source through complete processors to an output destination.');
  // Defer text processing resources on event-gated paths. Ordinary graphs retain
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
  // Repeated Nodes share one subscription inside this execution. The offscreen
  // owner shares only native tab PCM across windows, never graphs or Workers.
  const tabSourceFactory = sharedTabCapture(options.sourceFactory || ((...args) => new ExtensionTab(...args)),
    () => pipeline.state === 'stopping' || tabSources.every(spec => nodes[spec.id].endRequested));
  for (const spec of description.nodes) {
    let node;
    switch (spec.type) {
      case 'Button': node = new ButtonNode(); break;
      case 'Hold': node = new HoldNode({ onState: state => options.onHoldState?.(state, spec.id) }); break;
      case 'Text': node = new TextNode(spec.settings); break;
      case 'TextProcessingLfm2': case 'TextProcessingQwen35':
        node = new TextProcessingNode({ ...spec.settings, lazy: !options.preload && gatedAncestor(spec.id), type: spec.type, workerFactory: options.textProcessingWorkerFactory,
          onEvent: event => options.onTextProcessingEvent?.(event, spec.id) }); break;
      case 'IfCondition':
        node = new IfConditionNode({ ...spec.settings, workerFactory: options.ifConditionWorkerFactory,
          onEvent: event => options.onIfConditionEvent?.(event, spec.id) }); break;
      case 'Number': node = new NumberNode(spec.settings); break;
      case 'ChromeTabAudio':
        node = new ExtensionTabAudioNode(options.tabId, { sourceFactory: tabSourceFactory, onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'MicrophoneAudio':
        node = new ExtensionMicrophoneAudioNode(options.microphoneStreams?.get(spec.id), { microphoneSourceFactory: options.microphoneSourceFactory, onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'FocusedInputTextOutputNode':
        node = new FocusedInputTextOutputNode({ target: options.outputTarget?.tabId === options.tabId ? options.outputTarget : undefined, connectionFactory: options.pageConnectionFactory, onState: (state, active, severity) => options.onTargetState?.(spec.id, state, active, severity) }); break;
      case 'SpeechToTextMoonshineSmallJa':
        node = new SpeechToTextMoonshineSmallJaNode({ workerFactory: options.moonshineJapaneseWorkerFactory || options.workerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextMoonshineMediumEn':
        node = new SpeechToTextMoonshineMediumEnNode({ workerFactory: options.moonshineWorkerFactory || options.workerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'KeyedTextPair': node = new KeyedTextPairNode(); break;
      case 'KeyedPairedTextAccumulator': node = new KeyedPairedTextAccumulatorNode(); break;
      case 'Display': node = new DisplayNode((dom, port) => options.onDisplay?.(spec.id, dom, port), spec.settings); break;
      case 'TextAccumulator': node = new TextAccumulatorNode(); break;
      case 'TextSlidingWindow': node = new TextSlidingWindowNode(); break;
      case 'TextWindow': node = new TextWindowNode(); break;
      case 'TextFormatter': node = new TextFormatterNode(spec.settings); break;
      case 'KeyedTextCoalesce': node = new KeyedTextCoalesceNode(); break;
      case 'Plamo3Translate2B':
        node = new TranslationSchedulerNode({ prepare: options.preparePlamo || verifiedPlamoCache,
          TranslationNode: Plamo3Translate2BTranslationNode, modelName: 'PLaMo 3 Translate 2B', workerFactory: options.translationWorkerFactory,
          onState: (state, severity) => options.onTranslationState?.(state, spec.id, severity) }); resources.translations.push(node); break;
      case 'TranslateGemma4B':
        node = new TranslationSchedulerNode({ prepare: options.prepareTranslateGemma || verifiedTranslateGemmaCache,
          TranslationNode: TranslateGemmaTranslationNode,
          modelName: 'TranslateGemma 4B', workerFactory: options.translationWorkerFactory,
          onState: (state, severity) => options.onTranslationState?.(state, spec.id, severity) }); resources.translations.push(node); break;
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
      case 'SpeakerOutput': node = options.speakers?.get(spec.id) || new SpeakerOutputNode({
        contextFactory: options.speakerContextFactory, onState: state => options.onSpeakerState?.(state, spec.id),
      }); break;
      default: throw new Error(`Unsupported Node: ${spec.type}`);
    }
    nodes[spec.id] = node;
    if (INPUT_TYPES.includes(spec.type)) resources.audioSources.set(spec.id, node);
    if (ASR_TYPES.includes(spec.type)) resources.speechNodes.set(spec.id, node);
  }
  pipeline = new Pipeline({ nodes, connections: description.edges, onError: options.onError });
  let preparing;
  const prepareModels = () => preparing ??= (async () => {
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
