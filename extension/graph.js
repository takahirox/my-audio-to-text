import { MONO_16KHZ_PCM } from '../web/transcription-nodes.js';
import { TEXT } from '../web/translation-nodes.js';
import { TRANSLATION_OUTPUTS } from './translation-scheduler.js';
import { FORMAT_INPUTS, formatInputs, parseTemplate } from '../web/text-nodes.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { AUDIO_STREAM } from '../web/audio-stream.js';
import { DOM, NUMBER } from '../web/port-contracts.js';
import { validateCondition, MAX_CONDITION_CHARS } from '../web/if-condition-policy.js';
import { finiteNumber } from '../web/number-node.js';
import { validateWindowThreshold } from '../web/text-window-node.js';

export const GRAPH_VERSION = 15;
export const ASR_TYPES = ['SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn', 'SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'];
export const INPUT_TYPES = ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio'];
export const FIELD_TYPES = ['FocusedInputTextOutputNode'];
export const GRAPH_KEY = 'processing-graph-v1';
export const GRAPH_RECOVERY_KEY = 'processing-graph-before-v14';
// Migration-only contracts; none are supported palette/runtime ports.
const LEGACY_TRANSLATION_OUTPUTS = { provisional: TEXT, text: TEXT, provisionalSource: TEXT, provisionalStatus: TEXT, provisionalError: TEXT, finalSource: TEXT, finalStatus: TEXT, finalIndex: NUMBER, finalError: TEXT };
const paired = contract => ({ provisional: contract, final: contract });
// Fixed concrete production types and their public ports, not a model registry.
export const NODE_TYPES = Object.freeze({
  ChromeTabAudio: { label: 'Chrome tab audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM } },
  SelectedPageMediaAudio: { label: 'Selected page media audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Choose a media element in Live. Top frame only; unsupported media requires whole-tab capture.' },
  MicrophoneAudio: { label: 'Microphone audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Press Start in Live to request microphone permission.' },
  FocusedInputTextOutputNode: { label: 'Focused input text output', inputs: { text: TEXT }, outputs: {}, help: 'Append plain text to the user-focused editable field on the toolbar-invoked tab. Connect SpeechToTextReazonSpeech.final or a processor’s completed text output; no separate authorization or field picker.' },
  Number: { label: 'Number', inputs: {}, outputs: { value: NUMBER }, numberSettings: { value: { default: 6 } }, help: 'Reusable finite numeric constant. Select this Node to edit value. Units and limits belong to its consumer. SpeechToTextReazonSpeech.maxDuration accepts 1–12 seconds, including decimals; saves apply next session.' },
  SpeechToTextReazonSpeech: { label: 'ReazonSpeech ja-en ASR', inputs: { audio: MONO_16KHZ_PCM, maxDuration: NUMBER }, optionalInputs: ['maxDuration'], outputs: paired(TEXT), help: 'Optional maxDuration: connect any NUMBER source for a 1–12 second audio segment cap (default 6 seconds). Includes pre-roll; decimals round down to whole 16 kHz samples. Frozen before model loading; waiting audio is bounded at 30 seconds; saved edits apply next session. VAD can end sooner. Mid-sentence splits may reduce recognition quality. Inference and final display can take longer than the cap.' },
  Text: { label: 'Text', inputs: {}, outputs: { value: TEXT }, textSettings: { value: { default: '', multiline: true } }, help: 'Reusable literal text constant, including empty text. Delivered once at session start to ordinary TEXT consumers. Whisper.language consumes its first TEXT value before model loading; saves apply next session.' },
  SpeechToTextWhisper: { label: 'Whisper tiny (multilingual) ASR', inputs: { audio: MONO_16KHZ_PCM, language: TEXT }, optionalInputs: ['language'], outputs: { final: TEXT }, help: 'Packaged local multilingual Whisper tiny (q8, CPU WASM). Defaults to English (en); connect any TEXT source supplying en or ja. Only final: TEXT is available; connect final to TextAccumulator.append for committed segments. Silero ends speech at silence or a 6-second cap; Stop drains every segment. No downloads while recording.' },
  SpeechToTextZipformerEn: { label: 'Streaming Zipformer English ASR', inputs: { audio: MONO_16KHZ_PCM }, outputs: paired(TEXT), help: 'Packaged English-only 20M Zipformer, real online CPU WASM recognition. Incremental provisional → TextToDOM → DOMCombiner.second; final → TextAccumulator.append → TextToDOM → DOMCombiner.first. Fixed 12-second segments, Stop flushes the tail. No Silero gating or silence endpoint; silence counts toward the cap. Up to 30 seconds of backlog; overflow fails visibly. No downloads while recording.' },
  SpeechToTextParakeetV3: { label: 'Parakeet TDT 0.6B v3 ASR', preparationNotice: 'Parakeet v3: Save prepares 1.26 GB. Allow 3 GB storage and 6 GB free RAM/GPU memory; WebGPU shader-f16 required.', inputs: { audio: MONO_16KHZ_PCM }, outputs: { final: TEXT }, help: 'Optional NVIDIA v3 ONNX conversion. Save prepares 1.26 GB of weights; allow at least 6 GB free RAM/GPU memory and 3 GB free storage. Requires WebGPU with shader-f16; no CPU fallback. Final only → TextAccumulator.append. 800ms quiet or 12-second chunk cap; Stop drains tails. Hard caps can split words. 30-second backlog limit. Local inference; no recording-time downloads.' },
  SpeechToTextMoonshineMediumEn: { label: 'Moonshine Medium Streaming English ASR', preparationNotice: 'Moonshine Medium English Streaming: Save prepares 305 MB. Allow 700 MB storage and 2 GB free RAM; CPU WASM.', inputs: { audio: MONO_16KHZ_PCM }, outputs: paired(TEXT), help: 'Optional 245M English Medium Streaming, CPU WASM. Save prepares 305 MB of weights; allow at least 2 GB free RAM and 700 MB free storage. Native provisional → TextToDOM → DOMCombiner.second; committed final → TextAccumulator.append → TextToDOM → DOMCombiner.first. Updates from 0.5 seconds, native endpointing; history renews every 30 seconds after drain. Hard boundaries can split words. 30-second backlog limit. Local inference; no recording-time downloads.' },
  OpusMtJaEn: { label: 'OPUS-MT Japanese → English', inputs: { text: TEXT, provisional: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS, help: 'Committed text by default. Optional provisional accepts any TEXT source. Committed source/text/error and preview provisionalSource/provisionalText/provisionalError are separate atomic families sharing one Worker. provisionalText replaces a separate preview display and emits empty text on final input, Stop or Cancel. Pending emits nothing; Cancel clears previews only; Stop drains queued text. Failures emit source/error without successful text.' },
  OpusMtEnJa: { label: 'OPUS-MT English → Japanese', inputs: { text: TEXT, provisional: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS, help: 'Committed text by default. Optional provisional accepts any TEXT source. Committed source/text/error and preview provisionalSource/provisionalText/provisionalError are separate atomic families sharing one Worker. provisionalText replaces a separate preview display and emits empty text on final input, Stop or Cancel. Pending emits nothing; Cancel clears previews only; Stop drains queued text. Failures emit source/error without successful text.' },
  MeetingSummaryLfm2: { label: 'Meeting Summary · LFM2.5 1.2B JP', inputs: { text: TEXT }, outputs: { summary: TEXT }, settings: { language: ['ja', 'en'] }, preparationNotice: 'LFM2.5 JP: Save prepares 749 MB. Allow 2 GB storage and 4 GB free RAM/GPU memory per Node (planning estimate). WebGPU shader-f16. LFM 1.0 commercial-use conditions apply; see Models.', help: 'Batch committed text for 30 seconds or 2,000 characters, then update the previous note with new evidence only. Complete summary → TextToDOM.text → LiveTextDisplay.dom. Stop drains accepted text; Cancel discards pending work. 32,768-character backlog limit; overflow rejects the new fragment visibly and drains accepted text. Summaries are lossy and can omit or distort history. Saved language applies next session. Local WebGPU shader-f16 required; no CPU/cloud fallback or recording-time downloads.' },
  MeetingSummaryQwen35: { label: 'Meeting Summary · Qwen3.5 2B', inputs: { text: TEXT }, outputs: { summary: TEXT }, settings: { language: ['ja', 'en'] }, preparationNotice: 'Qwen3.5 2B: Save prepares 1.403 GB. Allow 3 GB storage and 6 GB free RAM/GPU memory per Node (planning estimate). WebGPU shader-f16. Apache 2.0 source; see Models for conversion provenance.', help: 'Batch committed text for 30 seconds or 2,000 characters, then update the previous note with new evidence only. Complete summary → TextToDOM.text → LiveTextDisplay.dom. Stop drains accepted text; Cancel discards pending work. 32,768-character backlog limit; overflow rejects the new fragment visibly and drains accepted text. Summaries are lossy and can omit or distort history. Saved language applies next session. Local WebGPU shader-f16 required; no CPU/cloud fallback or recording-time downloads.' },
  IfCondition: { label: 'IfCondition · local AI', inputs: { text: TEXT }, outputs: { yes: TEXT, no: TEXT }, textSettings: { condition: { default: 'Is this a question?', maxLength: MAX_CONDITION_CHARS, multiline: true } }, help: 'Evaluate an English natural-language condition locally. Yes/No carries the original text unchanged to exactly one branch. Empty/whitespace text takes No. Save prepares model assets; Start loads an owned CPU WASM Worker. Ambiguous decisions, errors or overflow stop this Node visibly; other paths continue. Stop drains; Cancel discards pending text. Conditions apply next session.' },
  TranslateGemmaEnJa: { label: 'TranslateGemma 4B English → Japanese', inputs: { text: TEXT, provisional: TEXT, context: TEXT }, optionalInputs: ['provisional', 'context'], outputs: TRANSLATION_OUTPUTS,
    preparationNotice: 'TranslateGemma 4B: Save prepares 3.112 GB shared by both directions. Allow 7 GB free storage and several GB free RAM/GPU memory; Worker WebGPU required. Use is subject to Google Gemma Terms of Use and Prohibited Use Policy (see Help / Models).',
    help: 'English → Japanese, browser-local q4. Optional context: TEXT supplies up to 4,000 characters for experimental disambiguation of the current text only. Context updates do not translate; empty context restores the official template. Each text/provisional request snapshots context for this session. Optional provisional accepts any TEXT source. Connect English ASR.final or Text.value → text. Committed source/text/error and preview provisionalSource/provisionalText/provisionalError form separate atomic families sharing one Worker. provisionalText replaces a separate preview display; empty clears on final input, Stop or Cancel. Committed text connects to TextFormatter, TextAccumulator.append, fields or Japanese TTS. Stop drains committed work; Cancel clears previews only. Save prepares 3.112 GB; no recording-time downloads or CPU/cloud fallback. Several GB RAM/GPU memory and WebGPU required. Google Gemma Terms and Prohibited Use Policy apply, including to this public ONNX conversion; see Help / Models before use.' },
  TranslateGemmaJaEn: { label: 'TranslateGemma 4B Japanese → English', inputs: { text: TEXT, provisional: TEXT, context: TEXT }, optionalInputs: ['provisional', 'context'], outputs: TRANSLATION_OUTPUTS,
    preparationNotice: 'TranslateGemma 4B: Save prepares 3.112 GB shared by both directions. Allow 7 GB free storage and several GB free RAM/GPU memory; Worker WebGPU required. Use is subject to Google Gemma Terms of Use and Prohibited Use Policy (see Help / Models).',
    help: 'Japanese → English with the same pinned q4 model as English → Japanese. Optional context: TEXT supplies up to 4,000 characters for experimental disambiguation of the current text only. Context updates do not translate; empty context restores the official template. Each text/provisional request snapshots context for this session. Optional provisional accepts any TEXT source. Plain TEXT in; committed source/text/error and preview provisionalSource/provisionalText/provisionalError out as separate atomic families sharing one Worker. provisionalText replaces a separate preview display; empty clears on final input, Stop or Cancel. Stop drains committed work; Cancel clears previews only. Save prepares 3.112 GB; allow 7 GB storage and several GB free RAM/GPU memory. Worker WebGPU required; no CPU/cloud fallback. Google Gemma Terms and Prohibited Use Policy apply; see Help / Models before use.' },
  LiveTextDisplay: { label: 'Live text display', inputs: { dom: DOM }, outputs: {}, textSettings: { label: { default: 'Text', maxLength: 120 } }, settings: { language: ['und', 'ja', 'en'] }, help: 'Mount each complete inert DOM snapshot, cloned for safe fan-out. Use TextToDOM for plain text or PairedTextToDOM for the latest comparison pair. Connect DOMAccumulator explicitly for DOM history. Start begins empty; Stop/Cancel retain the latest snapshot. Formatting stays in processors on the page main thread.' },
  TextToDOM: { label: 'Text to DOM', inputs: { text: TEXT }, outputs: { dom: DOM }, textSettings: { className: { default: '', optional: true } }, help: 'Convert each complete TEXT snapshot to literal visible text, including whitespace, newlines and empty strings. Optional className selects code-authored presentation CSS. No HTML parsing, accumulation or source matching. Main thread only.' },
  PairedTextToDOM: { label: 'Paired text to DOM', inputs: { input1: TEXT, input2: TEXT }, outputs: { dom: DOM }, help: 'Supply input1/input2 together from one producer in an atomic group, whether provisional or committed. Input1 is left; input2 is right. Omitted input2 leaves an empty cell; input2 alone emits nothing. Ungrouped and mismatched deliveries are rejected at runtime. Literal text, neutral accessibility labels and linked hover/focus highlighting. No history; connect DOMAccumulator explicitly. Main thread only.' },
  DOMAccumulator: { label: 'DOM accumulator', inputs: { append: DOM }, outputs: { dom: DOM }, help: 'Append each inert DOM snapshot in order, preserving duplicates. Validate and clone inputs and emit the complete accumulated DOM. Start clears history; Stop/Cancel retain committed content and reject stale deliveries. No persistence; growing snapshots consume memory and rendering time. Main thread only.' },
  DOMCombiner: { label: 'DOM combiner', inputs: { first: DOM, second: DOM }, optionalInputs: ['first', 'second'], outputs: { dom: DOM }, help: 'Combine the latest first and second inert DOM snapshots in that order. Each update replaces only its input; empty snapshots clear it. Inputs and outputs are validated deep clones. Start clears both; Stop/Cancel retain the latest output and reject stale deliveries. Main thread only.' },
  TextAccumulator: { label: 'Text accumulator', inputs: { append: TEXT }, outputs: { text: TEXT }, help: 'Append each exact TEXT segment separated by a newline, including repeated and empty values. Every append emits the complete accumulated snapshot. Start clears history and emits empty text; Stop/Cancel retain committed text. Compose provisional display separately with TextToDOM and DOMCombiner. No truncation or persistence; growing snapshots consume memory and rendering time.' },
  TextWindow: { label: 'Text window', inputs: { text: TEXT, maxChars: NUMBER, maxWaitSeconds: NUMBER }, optionalInputs: ['maxChars', 'maxWaitSeconds'], outputs: { text: TEXT }, help: 'Generic exact text batching. Optional NUMBER inputs: maxChars (whole number ≥2 UTF-16 units; default 600) and maxWaitSeconds (positive seconds; default 1.5). Updates apply independently to pending text; the deadline starts with the first fragment and is not reset by arrivals. No added separators or punctuation rules. Length emissions remove only their chunk and preserve the remainder. Stop flushes once; Cancel discards. No threshold Settings or preview output.' },
  TranslationCommit: { label: 'Translation commit (experiment)', inputs: { boundary: TEXT, source: TEXT, text: TEXT, error: TEXT }, outputs: { provisional: TEXT, final: TEXT, error: TEXT }, help: 'Opt-in bounded retranslation: Fan out each committed source event to boundary and translator.text. Results must be one grouped source/text/error emission causally linked to that event; unclosed results are rejected. Any TEXT producer can supply boundaries. Route translator.provisionalText to a separate preview display; final → TextAccumulator.append. Only correlated closed source events commit, exactly once; equal text alone never matches. Failures retain source with an error in the committed item. 32-window backlog cap; no new weights or conversation-wide memory.' },
  TextFormatter: { label: 'Text formatter', inputs: FORMAT_INPUTS, optionalInputs: Object.keys(FORMAT_INPUTS), outputs: { text: TEXT }, numberSettings: { inputCount: { default: 4 } }, textSettings: { template: { default: '{1}', maxLength: 2048, multiline: true } }, help: 'Add/remove numbered inputs in Settings. Use {1}, {2}, etc., labels and literal newlines. Escape braces as {{ and }}. Missing inputs are empty. Each emission formats the latest input values; directly grouped emissions replace the emitted family’s connected inputs together (omitted siblings clear). Independent branches are not correlated.' },
  Supertonic3: { label: 'Supertonic 3 TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { language: ['ja', 'en'], voice: ['F1', 'M1'] } },
  Kokoro: { label: 'Kokoro TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { voice: ['jf_alpha', 'af_heart'] } },
  Qwen3TtsStreaming: { label: 'Qwen3-TTS 0.6B · streaming', inputs: { text: TEXT }, outputs: { stream: AUDIO_STREAM }, settings: { language: ['japanese', 'english'], voice: ['ono_anna', 'ryan'] },
    preparationNotice: 'Qwen3-TTS: Save prepares 690 MB. Desktop Worker WebGPU required; allow 2 GB storage and 6 GB free RAM/GPU memory (planning estimate). Apache 2.0; reviewed community ONNX conversion. See Models.',
    help: 'Committed TEXT → genuinely incremental mono PCM → Speaker · streaming. Choose language and voice explicitly (ono_anna Japanese, ryan English). Use ASR.final or committed translation.text, never revisable previews. Up to 300 characters/256 tokens and 20.48 seconds of generated speech per utterance; split longer text before this Node. 16 utterances/4,800 characters queued. Save prepares pinned weights; Start is cache-only, with no CPU/cloud fallback. Stop drains accepted speech; Cancel terminates the owned Worker and playback. Desktop WebGPU only; speed depends on hardware.' },
  CosyVoice3Streaming: { label: 'CosyVoice3 0.5B · streaming', inputs: { text: TEXT }, outputs: { stream: AUDIO_STREAM }, settings: { language: ['english', 'japanese'], voice: ['libritts-r-4446'] },
    preparationNotice: 'CosyVoice3: Save prepares 917 MB. Desktop Worker WebGPU; allow 3 GB storage and 6 GB free RAM/GPU per Node (planning estimates). Apache 2.0 model; CC BY 4.0 LibriTTS-R reference voice. See Models.',
    help: 'Committed English/Japanese TEXT → incremental 24 kHz PCM → Speaker · streaming. One reviewed reference voice; no voice cloning. Language follows the input text. Spell out numbers and symbols; no native text normalizer is included. Up to 300 characters/128 text tokens, 500 speech tokens (20 seconds); hitting a limit without EOS visibly aborts. 16 utterances/4,800 characters queued. Save prepares pinned weights; Start is cache-only. Stop drains accepted speech; Cancel terminates the owned Worker and playback. Desktop WebGPU only, no CPU/cloud fallback. Other languages, mobile and low-memory devices are unqualified. Short utterances may finish before the first chunk.' },
  AudioOutput: { label: 'Audio player / WAV', inputs: { audio: SYNTHESIZED_AUDIO }, outputs: {} },
  SpeakerOutput: { label: 'Speaker', inputs: { audio: SYNTHESIZED_AUDIO }, outputs: {}, help: 'Automatically play completed TTS clips in order through the browser default speaker. Press Start in Live to enable audio and keep that window open. Stop drains accepted audio; Cancel clears playback. Queue limits: 32 clips, 120 seconds or 32 MiB; overflow is reported in Live.' },
  StreamingSpeakerOutput: { label: 'Speaker · streaming', inputs: { stream: AUDIO_STREAM }, outputs: {}, help: 'Play ordered incremental PCM with explicit utterance boundaries through the default speaker. Press Start in Live to enable audio; keep Live open. Chunks share the audio clock and are resampled by Web Audio. Eight seconds/64 chunks/8 MiB maximum queued; overflow visibly rejects further audio until restart. Stop drains accepted chunks; Cancel stops immediately. Completed TTS clips use the ordinary Speaker input.' },
});
const LEGACY_VIEWS = {
  TranscriptView: { label: 'Original transcript', inputs: paired(TEXT), optionalInputs: ['provisional'], outputs: {}, settings: { direction: ['ja-en', 'en-ja'] } },
  TranslationView: { label: 'Paired translation / Translated', inputs: {
    ...Object.fromEntries(Object.entries(LEGACY_TRANSLATION_OUTPUTS).filter(([port]) => port !== 'provisional')), provisionalText: TEXT,
  }, optionalInputs: [...Object.keys(LEGACY_TRANSLATION_OUTPUTS).filter(port => port !== 'provisional'), 'provisionalText'], outputs: {}, help: 'Plain display: provisionalText and/or text. Paired display: text plus finalSource, finalStatus, finalIndex, finalError from the same translator; optional provisionalText plus provisionalSource, provisionalStatus, provisionalError. Groups travel directly from one producer; separate processor branches cannot be joined.' },
};
export function nodeDefinition(node) {
  const definition = Object.hasOwn(NODE_TYPES, node?.type) ? NODE_TYPES[node.type] : undefined;
  if (!definition) return undefined;
  if (node.type !== 'TextFormatter') return definition;
  let inputs;
  try { inputs = formatInputs(node.settings?.inputCount); } catch { inputs = {}; }
  return { ...definition, inputs, optionalInputs: Object.keys(inputs) };
}
const translators = ['OpusMtJaEn', 'OpusMtEnJa'];
export function graphNode(type, id, x = 20, y = 20) {
  const definition = Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
  if (!definition) throw new Error(`Unknown Node type: ${type}`);
  return { id, type, settings: { ...Object.fromEntries(Object.entries(definition.settings || {}).map(([key, values]) => [key, values[0]])), ...Object.fromEntries(Object.entries({ ...definition.textSettings, ...definition.numberSettings }).map(([key, spec]) => [key, spec.default])) }, position: { x, y } };
}
// Translation is an explicit configuration, never part of a new/reset default.
// Its direct paired DOM route shows only the latest result; history is opt-in.
// enabled is used by legacy preference import: retain the separate original
// history/preview alongside that latest pair (see docs/extension-graph.md).
export function defaultGraph({ enabled = false, direction = 'ja-en' } = {}) {
  direction = direction === 'en-ja' ? 'en-ja' : 'ja-en';
  const nodes = [graphNode('ChromeTabAudio', 'audio', 20, 30), graphNode('SpeechToTextReazonSpeech', 'speech', 270, 30), graphNode('LiveTextDisplay', 'transcript', 1780, 30)];
  const edges = [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'transcript-preview', 'text'), edge('speech', 'final', 'transcript-accumulator', 'append'), edge('transcript-accumulator', 'text', 'transcript-dom', 'text'), edge('transcript-dom', 'dom', 'transcript-combined', 'first'), edge('transcript-preview', 'dom', 'transcript-combined', 'second'), edge('transcript-combined', 'dom', 'transcript', 'dom')];
  if (enabled) {
    nodes[2].settings = { label: 'Original', language: direction === 'en-ja' ? 'en' : 'ja' };
    nodes.push(graphNode(direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn', 'translation', 270, 630), graphNode('LiveTextDisplay', 'translated', 1780, 630), graphNode('PairedTextToDOM', 'translated-format', 1120, 630));
    nodes[4].settings.label = 'Translation';
    edges.push(edge('speech', 'final', 'translation', 'text'));
    edges.push(...pairedTextEdges('translation', 'translated-format'), edge('translated-format', 'dom', 'translated', 'dom'));
  }
  nodes.push(graphNode('TextAccumulator', 'transcript-accumulator', 790, 30), graphNode('TextToDOM', 'transcript-dom', 1120, 30), graphNode('TextToDOM', 'transcript-preview', 1120, 240), graphNode('DOMCombiner', 'transcript-combined', 1450, 30));
  return { version: GRAPH_VERSION, translationDirection: direction, nodes, edges };
}
export const edge = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
export function translationTemplate(direction) {
  return direction === 'en-ja' ? 'English: {1}\nJapanese: {2}{3}' : 'Japanese: {1}\nEnglish: {2}{3}';
}
export function pairedTextEdges(source, target) {
  return [edge(source, 'source', target, 'input1'), edge(source, 'text', target, 'input2')];
}
export function translationViewEdges(source, target) {
  return ['source', 'text', 'error'].map((port, index) => edge(source, port, target, `input${index + 1}`));
}
function legacyTranslationViewEdges(source, target, provisional = true) {
  const ports = ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError',
    ...(provisional ? ['provisional', 'provisionalSource', 'provisionalStatus', 'provisionalError'] : [])];
  return ports.map(port => edge(source, port, target, port === 'provisional' ? 'provisionalText' : port));
}
function unusedId(ids, base) {
  let id = base.slice(0, 64), index = 1;
  while (ids.has(id)) { const suffix = `-${++index}`; id = base.slice(0, 64 - suffix.length) + suffix; }
  ids.add(id); return id;
}
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateGraph(graph, legacy = false, optionalWarnings = false) {
  const types = legacy ? { ...NODE_TYPES, LiveTextDisplay: { ...NODE_TYPES.LiveTextDisplay, inputs: { replace: TEXT, append: TEXT }, optionalInputs: ['replace', 'append'] }, SpeechToText: NODE_TYPES.SpeechToTextReazonSpeech, ...LEGACY_VIEWS,
    ...Object.fromEntries(translators.map(type => [type, { ...NODE_TYPES[type], inputs: { provisional: TEXT, text: TEXT }, optionalInputs: ['provisional'], outputs: LEGACY_TRANSLATION_OUTPUTS }])) } : NODE_TYPES;
  const definitionOf = type => Object.hasOwn(types, type) ? types[type] : undefined;
  const errors = [], warnings = [];
  if (!record(graph) || graph.version !== (legacy ? 5 : GRAPH_VERSION) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return optionalWarnings ? [] : [`Expected version ${legacy ? 5 : GRAPH_VERSION} graph with nodes and edges arrays.`];
  if (graph.translationDirection !== undefined && !['ja-en', 'en-ja'].includes(graph.translationDirection)) errors.push('Invalid translation direction preference.');
  const nodes = new Map(), incoming = new Map(), outgoing = new Map(), seen = new Set();
  for (const node of graph.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(node.id)) { errors.push('Invalid Node ID.'); continue; }
    if (nodes.has(node.id)) errors.push(`Duplicate Node ID: ${node.id}`);
    nodes.set(node.id, node);
    const definition = legacy ? definitionOf(node.type) : nodeDefinition(node);
    if (!definition) { errors.push(`Unknown Node type: ${node.type}`); continue; }
    if (!record(node.position) || ![node.position.x, node.position.y].every(n => Number.isFinite(n) && n >= 0)) errors.push(`Invalid position: ${node.id}`);
    if (!record(node.settings)) { errors.push(`Invalid settings: ${node.id}`); continue; }
    for (const key of Object.keys(node.settings)) if (!Object.hasOwn(definition.settings || {}, key) && !Object.hasOwn(definition.textSettings || {}, key) && !Object.hasOwn(definition.numberSettings || {}, key)) errors.push(`Unknown setting: ${node.id}.${key}`);
    for (const key of Object.keys(definition.numberSettings || {})) try { finiteNumber(node.settings[key]); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    for (const [key, values] of Object.entries(definition.settings || {})) if (!values.includes(node.settings[key])) errors.push(`Invalid setting: ${node.id}.${key}`);
    for (const [key, spec] of Object.entries(definition.textSettings || {})) {
      if (spec.optional && node.settings[key] === undefined) continue;
      if (typeof node.settings[key] !== 'string' || node.settings[key].length > (spec.maxLength ?? Infinity) || (key === 'label' && !node.settings[key].trim())) errors.push(`Invalid setting: ${node.id}.${key}`);
    }
    if (!legacy && node.type === 'IfCondition') try { validateCondition(node.settings.condition); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    if (!legacy && node.type === 'TextFormatter') try { formatInputs(node.settings.inputCount); parseTemplate(node.settings.template, node.settings.inputCount); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
  }
  for (const connection of graph.edges) {
    if (!record(connection) || !Array.isArray(connection.from) || !Array.isArray(connection.to) || connection.from.length !== 2 || connection.to.length !== 2 || ![...connection.from, ...connection.to].every(s => typeof s === 'string')) { errors.push('Malformed named-port edge.'); continue; }
    const key = JSON.stringify([connection.from, connection.to]);
    if (seen.has(key)) errors.push('Duplicate edge.');
    seen.add(key);
    const [source, output] = connection.from, [target, input] = connection.to;
    const a = legacy ? definitionOf(nodes.get(source)?.type) : nodeDefinition(nodes.get(source)), b = legacy ? definitionOf(nodes.get(target)?.type) : nodeDefinition(nodes.get(target));
    if (!a || !b) { errors.push(`Unknown edge Node: ${source} → ${target}`); continue; }
    if (!Object.hasOwn(a.outputs, output) || !Object.hasOwn(b.inputs, input)) { errors.push(`Unknown port: ${source}.${output} → ${target}.${input}`); continue; }
    if (a.outputs[output] !== b.inputs[input]) errors.push(`Incompatible port types: ${source}.${output} → ${target}.${input}`);
    const destination = JSON.stringify([target, input]);
    if (incoming.has(destination)) errors.push(`Only one connection allowed to ${target}.${input}`);
    incoming.set(destination, connection.from);
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(target);
  }
  const degree = new Map([...nodes.keys()].map(id => [id, 0]));
  for (const targets of outgoing.values()) for (const target of targets) degree.set(target, degree.get(target) + 1);
  const roots = [...degree.keys()].filter(id => degree.get(id) === 0);
  for (let index = 0; index < roots.length; index++) for (const target of outgoing.get(roots[index]) || []) {
    degree.set(target, degree.get(target) - 1);
    if (!degree.get(target)) roots.push(target);
  }
  if (roots.length !== nodes.size) errors.push('Graph must be acyclic.');
  for (const node of nodes.values()) {
    const definition = legacy ? definitionOf(node.type) : nodeDefinition(node);
    if (!definition) continue;
    if (['TextFormatter', 'TextAccumulator'].includes(node.type)) {
      if (!Object.keys(definition.inputs).some(port => incoming.has(JSON.stringify([node.id, port])))) warnings.push(`Required connection missing: ${node.id} needs at least one TEXT input`);
    }
    if (legacy && node.type === 'TranslationView') {
      const connected = port => incoming.has(JSON.stringify([node.id, port]));
      if (!connected('text') && !connected('provisionalText')) warnings.push(`Required connection missing: ${node.id}.text or provisionalText`);
      // A paired view can only use directly grouped outputs from one scheduler.
      // Type compatibility alone cannot guarantee association across branches.
      const metadata = ['finalSource', 'finalStatus', 'finalIndex', 'finalError', 'provisionalSource', 'provisionalStatus', 'provisionalError'];
      if (metadata.some(connected)) {
        const ports = ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError'];
        if (['provisionalText', 'provisionalSource', 'provisionalStatus', 'provisionalError'].some(connected)) ports.push('provisionalText', 'provisionalSource', 'provisionalStatus', 'provisionalError');
        const source = ports.map(port => incoming.get(JSON.stringify([node.id, port]))).find(Boolean)?.[0];
        for (const port of ports) {
          const route = incoming.get(JSON.stringify([node.id, port]));
          if (!route) warnings.push(`Required connection missing: ${node.id}.${port} for correlated display`);
          else if (!translators.includes(nodes.get(source)?.type) || route[0] !== source || route[1] !== (port === 'provisionalText' ? 'provisional' : port)) errors.push(`Correlated display ${node.id}.${port} requires matching direct outputs from one translator.`);
        }
      }
    }
    for (const port of Object.keys(definition.inputs)) if (!definition.optionalInputs?.includes(port) && !incoming.has(JSON.stringify([node.id, port]))) warnings.push(`Required connection missing: ${node.id}.${port}`);
    if (Object.keys(definition.outputs).length && !outgoing.has(node.id)) warnings.push(`Unconnected output Node: ${node.id}`);
  }
  if (!graph.nodes.some(n => definitionOf(n?.type) && !Object.keys(definitionOf(n.type).outputs).length)) warnings.push('At least one output destination is required to run.');
  return [...new Set(optionalWarnings ? warnings : errors)];
}
// Storage accepts unfinished branches. Execution includes only ready ancestors of
// ready sinks; constants are roots too, so text/translation/TTS paths need no ASR.
export function executableGraph(graph) { return selectExecutable(assertGraph(graph)); }
function selectExecutable(description) {
  const ready = new Set(), incoming = new Map(description.nodes.map(node => [node.id, []]));
  for (const route of description.edges) incoming.get(route.to[0]).push(route);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of description.nodes) {
      if (ready.has(node.id)) continue;
      const definition = nodeDefinition(node), routes = incoming.get(node.id);
      const available = port => routes.some(route => route.to[1] === port && ready.has(route.from[0]));
      const required = Object.keys(definition.inputs).filter(port => !definition.optionalInputs?.includes(port));
      if (!required.every(available)) continue;
      if (Object.keys(definition.inputs).length && !routes.some(route => ready.has(route.from[0]))) continue;
      ready.add(node.id); changed = true;
    }
  }
  const participating = new Set();
  const pending = description.nodes.filter(node => ready.has(node.id) && !Object.keys(NODE_TYPES[node.type].outputs).length).map(node => node.id);
  while (pending.length) {
    const id = pending.pop();
    if (participating.has(id)) continue;
    participating.add(id);
    for (const route of incoming.get(id)) if (ready.has(route.from[0])) pending.push(route.from[0]);
  }
  return { ...description, nodes: description.nodes.filter(node => participating.has(node.id)),
    edges: description.edges.filter(route => participating.has(route.from[0]) && participating.has(route.to[0])) };
}
export function graphWarnings(graph) {
  const warnings = validateGraph(graph, false, true);
  if (!validateGraph(graph).length) {
    const active = new Set(executableGraph(graph).nodes.map(node => node.id));
    for (const node of graph.nodes) if (!active.has(node.id)) warnings.push(`Inactive Node: ${node.id} does not participate in an executable path.`);
    if (!active.size) warnings.push('No executable path. Connect a source through complete processors to an output destination.');
  }
  return warnings;
}
// Rewrite every legacy route explicitly; malformed or ambiguous routes require visible recovery.
function migrateLegacyGraph(graph) {
  if (!record(graph) || ![1, 2, 3, 4, 5, 6, 7, 8, 9].includes(graph.version)) return graph;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return graph;
  const next = structuredClone(graph);
  if (graph.version === 9) return migrateDisplayGraph(next);
  if (graph.version === 8) return migrateTranslationGraph(next);
  if (graph.version === 7) {
    const whisperIds = new Set(next.nodes.filter(node => node?.type === 'SpeechToTextWhisper').map(node => node.id));
    const dead = next.edges.filter(route => Array.isArray(route?.from) && route.from.length === 2 &&
      whisperIds.has(route.from[0]) && route.from[1] === 'provisional' &&
      Array.isArray(route.to) && route.to.length === 2 && route.to.every(value => typeof value === 'string'));
    next.edges = next.edges.filter(route => !dead.includes(route));
    next.version = 8;
    return migrateLegacyGraph(next);
  }
  const renameAsr = () => {
    for (const node of next.nodes) if (node?.type === 'SpeechToText') node.type = 'SpeechToTextReazonSpeech';
    next.version = 7; return migrateLegacyGraph(next);
  };
  if (graph.version === 6) return renameAsr();
  const recovery = (kind, id) => { throw Error(`Cannot migrate ${kind} ${id}: ambiguous or invalid route. Reset and Save in Graph Editor, then reconnect the desired TEXT routes.`); };
  if (graph.version < 3) for (const node of next.nodes) {
    if (!['FocusedInputTextOutputNode', 'SelectedFormFieldTextOutputNode'].includes(node?.type)) continue;
    const routes = next.edges.filter(route => route?.to?.[0] === node.id);
    if (routes.length !== 1) recovery('field output', node.id);
    const route = routes[0], source = next.nodes.find(source => source?.id === route.from?.[0]);
    const translated = route.to[1] === 'translatedFinal';
    if (!['final', 'translatedFinal'].includes(route.to[1]) || route.from?.[1] !== 'final' ||
        (translated ? !translators.includes(source?.type) : source?.type !== 'SpeechToText')) recovery('field output', node.id);
    node.type = 'FocusedInputTextOutputNode'; route.to[1] = 'text';
  }
  const adapters = next.nodes.filter(node => ['FinalText', 'TranslatedFinalText'].includes(node?.type));
  for (const adapter of adapters) {
    const inputs = next.edges.filter(route => route?.to?.[0] === adapter.id);
    const route = inputs[0], source = next.nodes.find(node => node?.id === route?.from?.[0]);
    if (inputs.length !== 1 || route.to[1] !== 'final' || route.from[1] !== 'final' ||
        (adapter.type === 'FinalText' ? source?.type !== 'SpeechToText' : !translators.includes(source?.type)) ||
        Object.keys(adapter.settings || {}).length) recovery('text adapter', adapter.id);
    for (const output of next.edges.filter(edge => edge?.from?.[0] === adapter.id)) {
      if (output.from[1] !== 'text') recovery('text adapter', adapter.id);
      output.from = [...route.from];
    }
    next.edges = next.edges.filter(edge => edge?.to?.[0] !== adapter.id);
    next.nodes = next.nodes.filter(node => node !== adapter);
  }
  if (graph.version < 4) for (const route of next.edges) {
    const source = next.nodes.find(node => node?.id === route?.from?.[0]);
    const target = next.nodes.find(node => node?.id === route?.to?.[0]);
    if (translators.includes(source?.type)) {
      if (!['provisional', 'final'].includes(route.from?.[1])) recovery('translation output', source.id);
      const final = route.from[1] === 'final';
      route.from[1] = target?.type === 'TranslationView' ? (final ? 'finalResult' : 'provisionalResult') : (final ? 'text' : 'provisional');
    }
    if (translators.includes(target?.type) && route.to?.[1] === 'final') route.to[1] = 'text';
  }
  next.edges = next.edges.flatMap(route => {
    if (!['provisionalResult', 'finalResult'].includes(route.from?.[1])) return [route];
    const source = next.nodes.find(node => node?.id === route.from[0]);
    const target = next.nodes.find(node => node?.id === route.to?.[0]);
    const final = route.from[1] === 'finalResult';
    if (!translators.includes(source?.type) || target?.type !== 'TranslationView' || route.to[1] !== (final ? 'final' : 'provisional')) recovery('paired translation', source?.id || '?');
    return legacyTranslationViewEdges(source.id, target.id).filter(edge => final ? !edge.from[1].startsWith('provisional') : edge.from[1].startsWith('provisional'));
  });
  next.version = 5;
  const legacyErrors = validateGraph(next, true);
  if (legacyErrors.length) throw Error(`Cannot migrate saved graph: ${legacyErrors.join(' ')} Fix the routes or Reset and Save in Graph Editor.`);
  const preferences = graphPreferences(next);
  next.translationDirection = preferences.direction;
  const ids = new Set(next.nodes.map(node => node.id));
  const unused = base => unusedId(ids, base);
  for (const node of [...next.nodes]) {
    const routes = next.edges.filter(route => route.to[0] === node.id);
    if (node.type === 'TranscriptView') {
      node.type = 'LiveTextDisplay'; node.settings = { label: 'Original', language: node.settings.direction === 'en-ja' ? 'en' : 'ja' };
      for (const route of routes) route.to[1] = route.to[1] === 'final' ? 'append' : 'replace';
    } else if (node.type === 'TranslationView') {
      const paired = routes.some(route => route.to[1] === 'finalSource');
      node.type = 'LiveTextDisplay'; node.settings = { label: 'Translation', language: 'und' };
      if (paired) {
        const id = unused(`${node.id}-format`), formatter = { id, type: 'PairedTextFormatter', settings: {}, position: { x: node.position.x, y: node.position.y + 260 } };
        const source = next.nodes.find(source => source.id === routes.find(route => route.to[1] === 'finalSource').from[0]);
        formatter.settings.direction = source.type === 'OpusMtEnJa' ? 'en-ja' : 'ja-en';
        next.nodes.push(formatter);
        for (const route of routes) route.to[0] = id;
        next.edges.push(edge(id, 'text', node.id, 'replace'));
      } else for (const route of routes) route.to[1] = route.to[1] === 'text' ? 'append' : 'replace';
    }
  }
  return renameAsr();
}
// Unsupported behavior is offered as an unsaved repair draft; the original is
// never overwritten until explicit Save, and is then retained under the recovery key.
function migrateTranslationGraph(next) {
  const oldPaired = new Set(next.nodes.filter(node => node.type === 'PairedTextFormatter').map(node => node.id));
  const translationIds = new Set(next.nodes.filter(node => translators.includes(node.type)).map(node => node.id));
  const changes = [];
  for (const node of next.nodes) {
    if (node.type === 'TextFormatter' && node.settings.inputCount === undefined) node.settings.inputCount = 4;
    if (!oldPaired.has(node.id)) continue;
    node.type = 'TextFormatter'; node.settings = { inputCount: 3, template: translationTemplate(node.settings.direction) };
    changes.push(`${node.id}: indexed history/pending previews become committed result formatting`);
  }
  next.edges = next.edges.flatMap(route => {
    const [source, output] = route.from, [target, input] = route.to;
    if (translationIds.has(target) && input === 'provisional') {
      changes.push(`${source}.${output} → ${target}.${input}: provisional translation removed`); return [];
    }
    if (oldPaired.has(target)) {
      const port = { finalSource: 'input1', text: 'input2', finalError: 'input3' }[input];
      if (!port) { changes.push(`${source}.${output} → ${target}.${input}: legacy metadata/preview removed`); return []; }
      route.to[1] = port;
    }
    if (translationIds.has(source)) {
      const port = { source: 'source', text: 'text', error: 'error', finalSource: 'source', finalError: 'error' }[output];
      if (!port) { changes.push(`${source}.${output} → ${target}.${input}: unsupported output removed; reconnect deliberately`); return []; }
      if (output === 'finalSource' || output === 'finalError') changes.push(`${source}.${output} → ${target}.${input}: ${port} now emits committed results only`);
      route.from[1] = port;
    }
    if (oldPaired.has(source)) {
      const sink = next.nodes.find(node => node.id === target);
      if (sink?.type === 'LiveTextDisplay' && input === 'replace' &&
          !next.edges.some(edge => edge.to[0] === target && edge.to[1] === 'append')) {
        route.to[1] = 'append'; changes.push(`${source} → ${target}: append each committed result once`);
      } else changes.push(`${source} → ${target}: latest-result TEXT replaces whole-history TEXT; review this route`);
    }
    return [route];
  });
  next = migrateDisplayGraph(next);
  if (changes.length) {
    const error = new Error(`Translation graph migration needs review. ${changes.join('; ')}. No pending rows or provisional translations are emitted. Failures emit source/error only. PairedTextToDOM source/text become input1/input2; former formatter error routes are removed in the draft, with specific errors in translation diagnostics. Review the repair draft and Save; the original saved graph is kept for recovery.`);
    const candidate = convertAccumulatorGraph(convertDOMGraph(next)), errors = validateGraph(candidate);
    if (!errors.length) error.recoveryGraph = candidate;
    else error.message += ` The converted graph is invalid: ${errors.join(' ')} Export the original recovery copy and repair these routes/settings before import.`;
    throw error;
  }
  return next;
}
// v9 display state becomes an explicit processor. Preserve original Nodes,
// settings and every route (including sources on different branches and drafts).
function migrateDisplayGraph(next) {
  const ids = new Set(next.nodes.map(node => node.id));
  for (const display of [...next.nodes]) {
    if (display.type !== 'LiveTextDisplay') continue;
    const routes = next.edges.filter(route => route?.to?.[0] === display.id);
    if (routes.some(route => route.to[1] === 'append')) {
      const id = unusedId(ids, `${display.id}-accumulator`);
      next.nodes.push(graphNode('TextAccumulator', id, Math.max(0, display.position.x - 250), display.position.y + 120));
      for (const route of routes) if (['append', 'replace'].includes(route.to[1])) {
        route.to = [id, route.to[1] === 'replace' ? 'preview' : 'append'];
      }
      next.edges.push(edge(id, 'text', display.id, 'content'));
    } else for (const route of routes) if (route.to[1] === 'replace') route.to[1] = 'content';
  }
  next.version = 10;
  return next;
}
// Reviewed v11 conversion. Never run a saved TEXT sink graph implicitly.
function convertDOMGraph(graph) {
  const next = structuredClone(graph), ids = new Set(next.nodes.map(node => node.id));
  for (const display of next.nodes.filter(node => node.type === 'LiveTextDisplay')) {
    const routes = next.edges.filter(route => route?.to?.[0] === display.id && route.to[1] === 'content');
    if (!routes.length) continue;
    const id = unusedId(ids, `${display.id}-dom`);
    next.nodes.push(graphNode('TextToDOM', id, Math.max(0, display.position.x - 250), display.position.y + 120));
    for (const route of routes) route.to = [id, 'text'];
    next.edges.push(edge(id, 'dom', display.id, 'dom'));
  }
  return convertPairedDOMGraph(next);
}
// Only the reviewed draft loses the obsolete formatter error route. The saved
// original and all other error fan-out remain available for recovery.
function convertPairedDOMGraph(graph) {
  const next = structuredClone(graph);
  const ids = new Set(next.nodes.filter(node => node.type === 'PairedTextToDOM').map(node => node.id));
  next.edges = next.edges.filter(route => !ids.has(route?.to?.[0]) || route.to[1] !== 'error');
  for (const route of next.edges) if (ids.has(route?.to?.[0])) {
    if (route.to[1] === 'source') route.to[1] = 'input1';
    else if (route.to[1] === 'text') route.to[1] = 'input2';
  }
  next.version = 12;
  return next;
}
function migrateBeforeAccumulatorGraph(graph) {
  const next = migrateLegacyGraph(graph);
  if (![10, 11].includes(next?.version) || !Array.isArray(next.nodes) || !Array.isArray(next.edges)) return next;
  if (next.version === 11) {
    const pairedIds = new Set(next.nodes.filter(node => node.type === 'PairedTextToDOM').map(node => node.id));
    if (!pairedIds.size) return convertPairedDOMGraph(next);
    const converted = convertAccumulatorGraph(convertPairedDOMGraph(next)), errors = validateGraph(converted);
    const removed = next.edges.filter(route => pairedIds.has(route?.to?.[0]) && route.to[1] === 'error')
      .map(route => `${route.from?.join('.')} → ${route.to.join('.')}`);
    const error = new Error(`Paired DOM graph v12 requires review. PairedTextToDOM source/text become input1/input2, with neutral labels and an empty right cell for omitted input2. ${removed.length ? `Removed formatter error routes in draft: ${removed.join('; ')}. ` : ''}Specific translation errors remain in translation diagnostics; other error routes are preserved. Review the draft and Save; the original saved graph is kept for recovery.`);
    if (!errors.length) error.recoveryGraph = converted;
    else error.message += ` Conversion needs repair: ${errors.join(' ')}`;
    throw error;
  }
  const converted = convertAccumulatorGraph(convertDOMGraph(next)), errors = validateGraph(converted);
  const error = new Error('DOM display graph v11 requires review. LiveTextDisplay now accepts only dom: DOM. PairedTextToDOM source/text become input1/input2; former formatter error routes are removed in the draft, with specific errors in translation diagnostics. Review the TextToDOM conversion draft and Save; the original saved graph is kept for recovery.');
  if (!errors.length) error.recoveryGraph = converted;
  else error.message += ` Conversion needs repair: ${errors.join(' ')}`;
  throw error;
}
// Display previews become independent DOM snapshots, without inferring stream
// correlation. Every preview conversion requires reviewed Save; arbitrary TEXT
// consumers remain blocked because their string semantics cannot be preserved.
function convertAccumulatorGraph(graph) {
  const next = structuredClone(graph), ids = new Set(next.nodes.map(node => node.id));
  for (const accumulator of next.nodes.filter(node => node.type === 'TextAccumulator')) {
    const previews = next.edges.filter(route => route?.to?.[0] === accumulator.id && route.to[1] === 'preview');
    if (!previews.length) continue;
    const outputs = next.edges.filter(route => route?.from?.[0] === accumulator.id);
    const formatters = outputs.map(route => next.nodes.find(node => node.id === route.to?.[0]));
    if (previews.length !== 1 || !outputs.length || outputs.some((route, i) => route.from[1] !== 'text' || route.to[1] !== 'text' ||
        formatters[i]?.type !== 'TextToDOM' || next.edges.some(other => other !== route && other.to?.[0] === route.to[0]))) {
      throw Error(`TextAccumulator ${accumulator.id} needs manual repair: shared formatters or non-DOM consumers cannot be converted without changing their TEXT values. The original JSON and all routes are kept. Compose each preview explicitly with TextToDOM and DOMCombiner, and choose its producer's finalization and Stop/Cancel behavior before Save.`);
    }
    for (const formatter of formatters) {
      const previewId = unusedId(ids, `${formatter.id}-preview`), combinedId = unusedId(ids, `${formatter.id}-combined`);
      next.nodes.push({ ...graphNode('TextToDOM', previewId, formatter.position.x, formatter.position.y + 240), settings: structuredClone(formatter.settings) },
        graphNode('DOMCombiner', combinedId, formatter.position.x + 330, formatter.position.y + 240));
      for (const route of next.edges) if (route.from?.[0] === formatter.id) route.from = [combinedId, route.from[1]];
      next.edges.push({ ...structuredClone(previews[0]), to: [previewId, 'text'] }, edge(formatter.id, 'dom', combinedId, 'first'), edge(previewId, 'dom', combinedId, 'second'));
    }
    next.edges = next.edges.filter(route => !previews.includes(route));
  }
  for (const node of next.nodes) if (node.type === 'TextAccumulator') delete node.legacyDisplay;
  next.version = GRAPH_VERSION;
  return next;
}
function migrateAccumulatorGraph(graph) {
  let next;
  try { next = migrateBeforeAccumulatorGraph(graph); }
  catch (error) {
    if (error.recoveryGraph) error.message += ' The draft also applies the v13 migration, composing any accumulator previews as separate DOM snapshots. Independent/preview-only sources retain their latest snapshot until their producer clears it; unrelated append and Stop/Cancel no longer clear it. Review lifecycle behavior before Save; no correlation is inferred.';
    throw error;
  }
  if (next?.version !== 12 || !Array.isArray(next.nodes) || !Array.isArray(next.edges)) return next;
  const converted = convertAccumulatorGraph(next), errors = validateGraph(converted);
  if (!next.edges.some(route => route?.to?.[1] === 'preview' && next.nodes.some(node => node.id === route.to[0] && node.type === 'TextAccumulator'))) return converted;
  const error = new Error('TextAccumulator graph v13 requires review. Preview routes become explicit TextToDOM and DOMCombiner branches. Paired producers clear their own provisional output on final, Stop and Cancel. Independent and preview-only sources retain their latest snapshot: append no longer clears them, and Stop/Cancel only clear when their producer does so. No correlation is inferred; review lifecycle behavior and reconnect deliberately. Review the draft and Save; the exact original JSON and earlier recovery copies are kept.');
  if (!errors.length) error.recoveryGraph = converted;
  else error.message += ` Conversion needs repair: ${errors.join(' ')}`;
  throw error;
}
// v14 follows main's v13 append-only migration. Never reinterpret a saved
// translator preview route, including one already reviewed and saved at v13.
function migrateBeforeTextWindowGraph(graph) {
  const legacy = record(graph) && Number.isInteger(graph.version) && graph.version < 14 &&
    Array.isArray(graph.nodes) && Array.isArray(graph.edges);
  const mixed = legacy
    ? graph.nodes.filter(node => [...translators, 'TranslateGemmaEnJa', 'TranslateGemmaJaEn'].includes(node?.type) &&
      graph.edges.some(route => route?.to?.[0] === node.id && route.to[1] === 'provisional')).map(node => node.id) : [];
  const commits = legacy ? graph.nodes.filter(node => node?.type === 'TranslationCommit').map(node => node.id) : [];
  const needsReview = mixed.length || commits.length;
  const review = `Translation output graph v14 requires review for ${[...mixed, ...commits].join(', ')}. source/text/error now carry committed results only. Explicitly route provisionalSource/provisionalText/provisionalError to a separate preview branch, including empty preview clears on final input, Stop and Cancel. TranslationCommit checks closed windows only and rejects unclosed results. Existing routes are retained for review; do not append preview formatting to history. Review the draft and Save; the original saved graph is kept for recovery.`;
  let next;
  try { next = migrateAccumulatorGraph(graph); }
  catch (error) {
    if (needsReview) error.message += ` ${review}`;
    throw error;
  }
  if ([13, 14].includes(next?.version)) next = { ...structuredClone(next), version: GRAPH_VERSION };
  if (needsReview && next?.version === GRAPH_VERSION) {
    const error = new Error(review), errors = validateGraph(next);
    if (!errors.length) error.recoveryGraph = next;
    else error.message += ` Repair required: ${errors.join(' ')}`;
    throw error;
  }
  return next;
}
// v15 changes only TextWindow. Convert its old thresholds into explicit Number
// sources in a review draft; never guess a replacement for removed preview edges.
export function migrateGraph(graph) {
  const legacy = record(graph) && Number.isInteger(graph.version) && graph.version < GRAPH_VERSION &&
    Array.isArray(graph.nodes) && Array.isArray(graph.edges);
  const windows = legacy ? graph.nodes.filter(node => node?.type === 'TextWindow') : [];
  if (!windows.length) return migrateBeforeTextWindowGraph(graph);
  const next = structuredClone(graph), ids = new Set(next.nodes.map(node => node.id)), changes = [];
  for (const original of windows) {
    const node = next.nodes.find(node => node.id === original.id);
    if (!record(node.settings)) throw Error(`TextWindow ${node.id}: invalid legacy settings; original JSON is kept. Repair manually.`);
    for (const [key, port, scale] of [['maxChars', 'maxChars', 1], ['maxWaitMs', 'maxWaitSeconds', 0.001]]) {
      if (!Object.hasOwn(node.settings, key)) continue;
      const value = node.settings[key];
      validateWindowThreshold(port, typeof value === 'number' ? value * scale : value);
      if (next.edges.some(route => route?.to?.[0] === node.id && route.to[1] === port)) throw Error(`TextWindow ${node.id}: both legacy ${key} and a ${port} input exist; original JSON is kept. Choose the threshold manually.`);
      const id = unusedId(ids, `${node.id}-${port}`);
      const source = graphNode('Number', id, Math.max(0, node.position.x - 250), node.position.y + (port === 'maxChars' ? 240 : 480));
      source.settings.value = value * scale;
      next.nodes.push(source); next.edges.push(edge(id, 'value', node.id, port));
      delete node.settings[key]; changes.push(`${node.id}.${key} becomes ${id}.value → ${node.id}.${port}`);
    }
    if (Object.hasOwn(node.settings, 'sentenceBoundary')) {
      delete node.settings.sentenceBoundary;
      changes.push(`${node.id}.sentenceBoundary removed; punctuation no longer closes windows`);
    }
    next.edges = next.edges.filter(route => {
      if (route?.from?.[0] !== node.id || route.from[1] !== 'provisional') return true;
      changes.push(`Removed ${route.from.join('.')} → ${route.to?.join('.')}; reconnect previews from a deliberate TEXT source`);
      return false;
    });
  }
  const review = `TextWindow graph v15 requires review for ${windows.map(node => node.id).join(', ')}. Text is concatenated exactly without added spaces; only length, time or Stop emits text. The provisional output is removed. ${changes.join('; ')}. Review the draft and Save; the exact original JSON and unrelated routes are kept for recovery.`;
  let converted;
  try { converted = migrateBeforeTextWindowGraph(next); }
  catch (error) { error.message += ` ${review}`; throw error; }
  const error = new Error(review), errors = validateGraph(converted);
  if (!errors.length) error.recoveryGraph = converted;
  else error.message += ` Manual repair required: ${errors.join(' ')}`;
  throw error;
}
export function assertGraph(graph) {
  const migrated = migrateGraph(graph), errors = validateGraph(migrated);
  if (errors.length) throw new Error(errors.join('\n'));
  return structuredClone(migrated);
}
// Read-only legacy/status hint. The first translator does not represent every
// direction in an arbitrary graph and must never control processor settings.
export function graphPreferences(graph) {
  const translation = graph.nodes.find(node => [...translators, 'TranslateGemmaEnJa', 'TranslateGemmaJaEn'].includes(node.type));
  return { enabled: !!translation, direction: translation
    ? (['OpusMtEnJa', 'TranslateGemmaEnJa'].includes(translation.type) ? 'en-ja' : 'ja-en')
    : graph.translationDirection || graph.nodes.find(node => node.type === 'TranscriptView')?.settings.direction || 'ja-en' };
}
export function readGraph(storage) {
  const saved = storage.getItem(GRAPH_KEY);
  if (saved !== null) {
    let parsed, graph;
    try { parsed = JSON.parse(saved); graph = assertGraph(parsed); }
    catch (error) {
      const failure = new Error(`Invalid saved graph: ${error.message}${error.recoveryGraph ? '' : ' Reset and Save in Graph Editor to recover; the saved graph has been kept.'}`);
      if (error.recoveryGraph) failure.recoveryGraph = error.recoveryGraph;
      throw failure;
    }
    if (parsed.version !== GRAPH_VERSION) saveGraph(storage, graph);
    return graph;
  }
  let legacy;
  try { legacy = JSON.parse(storage.getItem('opus-mt-translation-preferences')); } catch { /* migrate corrupt preferences to defaults */ }
  const graph = defaultGraph({ enabled: legacy?.enabled === true, direction: legacy?.direction });
  saveGraph(storage, graph);
  return graph;
}
export function saveGraph(storage, graph) {
  const validated = assertGraph(graph);
  const original = storage.getItem?.(GRAPH_KEY);
  if (original !== null && original !== undefined) {
    let validOriginal = false;
    try { validOriginal = !validateGraph(JSON.parse(original)).length; } catch { /* Keep malformed originals too. */ }
    if (!validOriginal) {
      // Never replace an earlier recovery copy, even after another import.
      let key = GRAPH_RECOVERY_KEY, index = 2;
      while (storage.getItem?.(key) !== null && storage.getItem?.(key) !== undefined && storage.getItem(key) !== original) key = `${GRAPH_RECOVERY_KEY}-${index++}`;
      if (storage.getItem?.(key) !== original) storage.setItem(key, original);
    }
  }
  storage.setItem(GRAPH_KEY, JSON.stringify(validated));
  storage.removeItem('opus-mt-translation-preferences');
  return validated;
}
