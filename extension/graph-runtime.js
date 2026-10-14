import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode } from '../web/transcription-nodes.js';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode } from '../web/translation-nodes.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';
import { AudioOutputNode } from '../web/synthesized-audio.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';
import { TranslationSchedulerNode } from './translation-scheduler.js';
import { FocusedInputTextOutputNode } from './page-output-node.js';
import { SelectedPageMediaAudioNode, ExtensionMicrophoneAudioNode } from './media-source.js';
import { LiveTextDisplayNode, TextFormatterNode } from '../web/text-nodes.js';
import { PairedTextFormatterNode } from './paired-text-formatter.js';
import { assertGraph } from './graph.js';
import { verifiedTtsCache } from './tts-cache.js';

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

export function buildGraph(graph, options) {
  const description = assertGraph(graph);
  const nodes = {}, resources = { translations: [] };
  for (const spec of description.nodes) {
    let node;
    switch (spec.type) {
      case 'ChromeTabAudio':
        node = resources.audio = new ExtensionTabAudioNode(options.tabId, { sourceFactory: options.sourceFactory, onAudio: options.onCapturedAudio, onEnded: options.onEnded }); break;
      case 'SelectedPageMediaAudio':
        node = resources.audio = new SelectedPageMediaAudioNode(options.targets?.[spec.id], { onAudio: options.onCapturedAudio, onEnded: options.onEnded, onState: state => options.onTargetState?.(spec.id, state) }); break;
      case 'MicrophoneAudio':
        node = resources.audio = new ExtensionMicrophoneAudioNode(options.microphoneStream, { onAudio: options.onCapturedAudio, onEnded: options.onEnded }); break;
      case 'FocusedInputTextOutputNode':
        node = new FocusedInputTextOutputNode({ target: options.outputTarget?.tabId === options.tabId ? options.outputTarget : undefined, connectionFactory: options.pageConnectionFactory, onState: (state, active) => options.onTargetState?.(spec.id, state, active) }); break;
      case 'SpeechToText':
        node = resources.speech = new SpeechToTextNode({ workerFactory: options.workerFactory, onEvent: options.onSpeechEvent }); break;
      case 'LiveTextDisplay': node = new LiveTextDisplayNode(state => options.onDisplay?.(spec.id, state), { appendConnected: description.edges.some(edge => edge.to[0] === spec.id && edge.to[1] === 'append') }); break;
      case 'TextFormatter': node = new TextFormatterNode(spec.settings); break;
      case 'PairedTextFormatter': node = new PairedTextFormatterNode(spec.settings); break;
      case 'OpusMtJaEn': case 'OpusMtEnJa':
        node = resources.translation = new TranslationSchedulerNode({ prepare: signal => options.prepareTranslation?.(signal, spec.type === 'OpusMtEnJa' ? 'en-ja' : 'ja-en'),
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
  }
  return { ...resources, description, pipeline: new Pipeline({ nodes, connections: description.edges, onError: options.onError }) };
}
