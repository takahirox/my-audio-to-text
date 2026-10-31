import { TextToDOMNode, PairedTextToDOMNode, DOMAccumulatorNode, DOMCombinerNode } from '../web/dom-nodes.js';
import { MeetingSummaryNode } from '../web/meeting-summary-node.js';
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
import { LiveTextDisplayNode, TextAccumulatorNode, TextFormatterNode } from '../web/text-nodes.js';
import { executableGraph, INPUT_TYPES, ASR_TYPES } from './graph.js';
import { verifiedTtsCache } from './tts-cache.js';
import { TextNode } from '../web/text-constant-node.js';
import { SpeechToTextWhisperNode } from '../web/whisper-node.js';
import { SpeechToTextZipformerEnNode } from '../web/zipformer-node.js';
import { SpeechToTextParakeetV3Node } from '../web/parakeet-v3-node.js';
import { SpeechToTextMoonshineMediumEnNode } from '../web/moonshine-medium-node.js';
import { IfConditionNode } from '../web/if-condition-node.js';
import { NumberNode } from '../web/number-node.js';
import { TextSlidingWindowNode } from '../web/text-sliding-window-node.js';
import { TextWindowNode } from '../web/text-window-node.js';
import { TranslationCommitNode } from '../web/translation-commit-node.js';

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
      case 'MeetingSummaryLfm2': case 'MeetingSummaryQwen35':
        node = new MeetingSummaryNode({ ...spec.settings, type: spec.type, workerFactory: options.meetingSummaryWorkerFactory,
          onEvent: event => options.onMeetingSummaryEvent?.(event, spec.id) }); break;
      case 'IfCondition':
        node = new IfConditionNode({ ...spec.settings, workerFactory: options.ifConditionWorkerFactory,
          onEvent: event => options.onIfConditionEvent?.(event, spec.id) }); break;
      case 'Number': node = new NumberNode(spec.settings); break;
      case 'ChromeTabAudio':
        node = new ExtensionTabAudioNode(options.tabId, { sourceFactory: tabSourceFactory, onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'SelectedPageMediaAudio':
        node = new SelectedPageMediaAudioNode(options.targets?.[spec.id], { onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id), onState: state => options.onTargetState?.(spec.id, state) }); break;
      case 'MicrophoneAudio':
        node = new ExtensionMicrophoneAudioNode(options.microphoneStreams?.get(spec.id), { onAudio: pcm => options.onCapturedAudio?.(pcm, spec.id), onEnded: () => options.onEnded?.(spec.id) }); break;
      case 'FocusedInputTextOutputNode':
        node = new FocusedInputTextOutputNode({ target: options.outputTarget?.tabId === options.tabId ? options.outputTarget : undefined, connectionFactory: options.pageConnectionFactory, onState: (state, active) => options.onTargetState?.(spec.id, state, active) }); break;
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
      case 'LiveTextDisplay': node = new LiveTextDisplayNode(dom => options.onDisplay?.(spec.id, dom)); break;
      case 'TextToDOM': node = new TextToDOMNode(spec.settings); break;
      case 'PairedTextToDOM': node = new PairedTextToDOMNode(); break;
      case 'DOMAccumulator': node = new DOMAccumulatorNode(); break;
      case 'DOMCombiner': node = new DOMCombinerNode(); break;
      case 'TextAccumulator': node = new TextAccumulatorNode(); break;
      case 'TextSlidingWindow': node = new TextSlidingWindowNode(); break;
      case 'TextWindow': node = new TextWindowNode(); break;
      case 'TranslationCommit': node = new TranslationCommitNode(); break;
      case 'TextFormatter': node = new TextFormatterNode(spec.settings); break;
      case 'TranslateGemmaEnJa': case 'TranslateGemmaJaEn':
        node = new TranslationSchedulerNode({ prepare: options.prepareTranslateGemma || verifiedTranslateGemmaCache,
          TranslationNode: spec.type === 'TranslateGemmaEnJa' ? EnglishToJapaneseTranslateGemmaTranslationNode : TranslateGemmaTranslationNode,
          modelName: 'TranslateGemma 4B', workerFactory: options.translationWorkerFactory,
          onState: state => options.onTranslationState?.(state, spec.id) }); resources.translations.push(node); break;
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
      case 'Qwen3TtsStreaming': node = new Qwen3TtsNode({ ...spec.settings, workerFactory: options.ttsWorkerFactory,
        onEvent: event => options.onTtsState?.(`${spec.id}: ${event.message || event.type}`) }); break;
      case 'CosyVoice3Streaming': node = new CosyVoice3Node({ ...spec.settings, workerFactory: options.ttsWorkerFactory,
        onEvent: event => options.onTtsState?.(`${spec.id}: ${event.message || event.type}`) }); break;
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
  pipeline = new Pipeline({ nodes, connections: description.edges, onError: options.onError });
  return { ...resources, description, pipeline };
}
