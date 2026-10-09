import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode, TranscriptOutputNode, TRANSCRIPT } from '../web/transcription-nodes.js';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TEXT } from '../web/translation-nodes.js';
import { Supertonic3TextToSpeechNode, KokoroTextToSpeechNode } from '../web/tts-nodes.js';
import { AudioOutputNode } from '../web/synthesized-audio.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';
import { TranslationSchedulerNode, TRANSLATION } from './translation-scheduler.js';
import { FocusedInputTextOutputNode, SelectedFormFieldTextOutputNode } from './page-output-node.js';
import { SelectedPageMediaAudioNode, ExtensionMicrophoneAudioNode } from './media-source.js';
import { assertGraph, graphPreferences } from './graph.js';
import { verifiedTtsCache } from './tts-cache.js';

// Explicit final-only adapters: production TTS takes plain strings, never a
// transcript object, provisional text or translation status notification.
export class FinalTextNode {
  outputs = { text: TEXT };
  constructor(translated = false) { this.translated = translated; this.inputs = { final: translated ? TRANSLATION : TRANSCRIPT }; }
  receive(port, value, context) {
    if (port !== 'final' || (this.translated && value.status !== 'complete')) return;
    const text = value.text.trim();
    // Keep every final utterance; each chunk respects production TTS's bound.
    let remaining = text;
    while (remaining) {
      let end = Math.min(300, remaining.length);
      if (end < remaining.length && /[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
      context.emit('text', remaining.slice(0, end)); remaining = remaining.slice(end);
    }
  }
}

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
    try { await this.node.receive(port, text, context); }
    catch (error) { if (!context.signal.aborted) await this.failure(error); }
  }
  async stop() {
    if (!this.failed) try { await this.node.stop(); } catch (error) { if (!this.context.signal.aborted) await this.failure(error); }
  }
  dispose() { return this.node.dispose(); }
}

export function buildGraph(graph, options) {
  const description = assertGraph(graph), preferences = graphPreferences(description);
  const nodes = {}, resources = {};
  for (const spec of description.nodes) {
    let node;
    switch (spec.type) {
      case 'ChromeTabAudio':
        node = resources.audio = new ExtensionTabAudioNode(options.tabId, { sourceFactory: options.sourceFactory, onAudio: options.onCapturedAudio, onEnded: options.onEnded }); break;
      case 'SelectedPageMediaAudio':
        node = resources.audio = new SelectedPageMediaAudioNode(options.targets?.[spec.id], { onAudio: options.onCapturedAudio, onEnded: options.onEnded, onState: state => options.onTargetState?.(spec.id, state) }); break;
      case 'MicrophoneAudio':
        node = resources.audio = new ExtensionMicrophoneAudioNode(options.microphoneStream, { onAudio: options.onCapturedAudio, onEnded: options.onEnded }); break;
      case 'FocusedInputTextOutputNode': case 'SelectedFormFieldTextOutputNode':
        node = new (spec.type === 'FocusedInputTextOutputNode' ? FocusedInputTextOutputNode : SelectedFormFieldTextOutputNode)({ target: options.targets?.[spec.id], connectionFactory: options.pageConnectionFactory, onState: state => options.onTargetState?.(spec.id, state) }); break;
      case 'SpeechToText':
        node = resources.speech = new SpeechToTextNode({ workerFactory: options.workerFactory, onEvent: options.onSpeechEvent }); break;
      case 'TranscriptView': node = new TranscriptOutputNode(options.onTranscript); break;
      case 'OpusMtJaEn': case 'OpusMtEnJa':
        node = resources.translation = new TranslationSchedulerNode({ prepare: signal => options.prepareTranslation(signal, preferences.direction),
          TranslationNode: spec.type === 'OpusMtEnJa' ? EnglishToJapaneseOpusMtTranslationNode : OpusMtTranslationNode,
          workerFactory: options.translationWorkerFactory, onState: options.onTranslationState }); break;
      case 'TranslationView':
        node = { inputs: { provisional: TRANSLATION, final: TRANSLATION }, outputs: {}, receive: options.onTranslation }; break;
      case 'FinalText': node = new FinalTextNode(); break;
      case 'TranslatedFinalText': node = new FinalTextNode(true); break;
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
