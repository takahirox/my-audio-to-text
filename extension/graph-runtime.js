import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode } from '../web/translation-nodes.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';
import { AudioOutputNode } from '../web/synthesized-audio.js';
import { ExtensionTab } from './tab-source.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';
import { TranslationSchedulerNode } from './translation-scheduler.js';
import { FocusedInputTextOutputNode } from './page-output-node.js';
import { SelectedPageMediaAudioNode, ExtensionMicrophoneAudioNode } from './media-source.js';
import { LiveTextDisplayNode, TextFormatterNode } from '../web/text-nodes.js';
import { executableGraph, INPUT_TYPES, ASR_TYPES } from './graph.js';
import { verifiedTtsCache } from './tts-cache.js';
import { TextNode } from '../web/text-constant-node.js';
import { SpeechToTextWhisperNode } from '../web/whisper-node.js';
import { SpeechToTextZipformerEnNode } from '../web/zipformer-node.js';
import { NumberNode } from '../web/number-node.js';

// Branch-local lifecycle adapter around an actual production TTS Node. Missing
// assets, initialization or synthesis failure must leave transcription usable.
class PreparedTtsNode {
  constructor(node, type, settings, onState, prepare) {
    this.node = node; this.type = type; this.settings = settings; this.onState = onState; this.prepare = prepare;
    this.inputs = node.inputs; this.outputs = node.outputs;
  }
  failure(error) { this.failed = true; this.onState(`Audio unavailable: ${error.message || error}`); return this.node.dispose(); }
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

export function buildGraph(graph, options) {
  const description = executableGraph(graph);
  if (!description.nodes.length) throw Error('No executable path. Connect a source through complete processors to an output destination.');
  let pipeline;
  const nodes = {}, resources = { translations: [], audioSources: new Map(), speechNodes: new Map() };
  const tabSources = description.nodes.filter(spec => spec.type === 'ChromeTabAudio');
  // Toolbar-tab navigation ends every tab subscriber even while a microphone
  // keeps the Pipeline running. Flush before detaching any of those subscribers.
  const tabSourceFactory = sharedTabCapture(options.sourceFactory || ((...args) => new ExtensionTab(...args)),
    () => pipeline.state === 'stopping' || tabSources.every(spec => nodes[spec.id].endRequested));
  for (const spec of description.nodes) {
    let node;
    switch (spec.type) {
      case 'Text': node = new TextNode(spec.settings); break;
      case 'Number': node = new NumberNode(spec.settings); break;
      case 'ChromeTabAudio':
        node = new ExtensionTabAudioNode(options.tabId, { sourceFactory: tabSourceFactory, onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'SelectedPageMediaAudio':
        node = new SelectedPageMediaAudioNode(options.targets?.[spec.id], { onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id), onState: state => options.onTargetState?.(spec.id, state) }); break;
      case 'MicrophoneAudio':
        node = new ExtensionMicrophoneAudioNode(options.microphoneStreams?.get(spec.id), { onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'FocusedInputTextOutputNode':
        node = new FocusedInputTextOutputNode({ target: options.outputTarget?.tabId === options.tabId ? options.outputTarget : undefined, connectionFactory: options.pageConnectionFactory, onState: (state, active) => options.onTargetState?.(spec.id, state, active) }); break;
      case 'SpeechToTextZipformerEn':
        node = new SpeechToTextZipformerEnNode({ workerFactory: options.zipformerWorkerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextWhisper':
        node = new SpeechToTextWhisperNode({ workerFactory: options.whisperWorkerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'SpeechToTextReazonSpeech':
        node = new SpeechToTextNode({ workerFactory: options.workerFactory, onEvent: event => options.onSpeechEvent?.(event, spec.id) }); break;
      case 'LiveTextDisplay': node = new LiveTextDisplayNode(state => options.onDisplay?.(spec.id, state), { appendConnected: description.edges.some(edge => edge.to[0] === spec.id && edge.to[1] === 'append') }); break;
      case 'TextFormatter': node = new TextFormatterNode(spec.settings); break;
      case 'OpusMtJaEn': case 'OpusMtEnJa':
        node = new TranslationSchedulerNode({ prepare: signal => options.prepareTranslation?.(signal, spec.type === 'OpusMtEnJa' ? 'en-ja' : 'ja-en'),
          TranslationNode: spec.type === 'OpusMtEnJa' ? EnglishToJapaneseOpusMtTranslationNode : OpusMtTranslationNode,
          workerFactory: options.translationWorkerFactory, onState: state => options.onTranslationState?.(state, spec.id) }); resources.translations.push(node); break;
      case 'Supertonic3': case 'Kokoro': {
        const Node = spec.type === 'Supertonic3' ? Supertonic3TextToSpeechNode : KokoroTextToSpeechNode;
        const production = new Node({ ...spec.settings, workerFactory: options.ttsWorkerFactory,
          loadOptions: { cacheOnly: true }, onEvent: event => options.onTtsState?.(`${spec.id}: ${event.message || event.type}`) });
        node = new PreparedTtsNode(production, spec.type, spec.settings, state => options.onTtsState?.(`${spec.id}: ${state}`), options.prepareTts || verifiedTtsCache); break;
      }
      case 'AudioOutput': node = new AudioOutputNode(options.onSynthesizedAudio); break;
      default: throw new Error(`Unsupported Node: ${spec.type}`);
    }
    nodes[spec.id] = node;
    if (INPUT_TYPES.includes(spec.type)) resources.audioSources.set(spec.id, node);
    if (ASR_TYPES.includes(spec.type)) resources.speechNodes.set(spec.id, node);
  }
  // Resolve constant configuration edges synchronously from this validated
  // snapshot. Pipeline starts consumers before producers; a normal start-time
  // emission would arrive too late. Only model configuration ports use startup binding,
  // never the audio queue. Other constant edges use ordinary typed delivery.
  const connections = description.edges.filter(edge => {
    const target = nodes[edge.to[0]];
    if ((target instanceof SpeechToTextNode && edge.to[1] === 'maxDuration') || (target instanceof SpeechToTextWhisperNode && edge.to[1] === 'language')) {
      target.receive(edge.to[1], nodes[edge.from[0]].value);
      return false;
    }
    return true;
  });
  pipeline = new Pipeline({ nodes, connections, onError: options.onError });
  return { ...resources, description, pipeline };
}
