import { MONO_16KHZ_PCM } from '../web/transcription-nodes.js';
import { TEXT } from '../web/translation-nodes.js';
import { TRANSLATION_OUTPUTS } from './translation-scheduler.js';
import { FORMAT_INPUTS, formatInputs, parseTemplate } from '../web/text-nodes.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { DOM, NUMBER } from '../web/port-contracts.js';
import { validateCondition, MAX_CONDITION_CHARS } from '../web/if-condition-policy.js';
import { finiteNumber } from '../web/number-node.js';
import { windowSettings } from '../web/text-window-node.js';

export const GRAPH_VERSION = 11;
export const ASR_TYPES = ['SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn', 'SpeechToTextParakeetV3', 'SpeechToTextMoonshineMediumEn'];
export const INPUT_TYPES = ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio'];
export const FIELD_TYPES = ['FocusedInputTextOutputNode'];
export const GRAPH_KEY = 'processing-graph-v1';
export const GRAPH_RECOVERY_KEY = 'processing-graph-before-v11';
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
  SpeechToTextZipformerEn: { label: 'Streaming Zipformer English ASR', inputs: { audio: MONO_16KHZ_PCM }, outputs: paired(TEXT), help: 'Packaged English-only 20M Zipformer, real online CPU WASM recognition. Incremental provisional → TextAccumulator.preview; final → TextAccumulator.append. Fixed 12-second segments, Stop flushes the tail. No Silero gating or silence endpoint; silence counts toward the cap. Up to 30 seconds of backlog; overflow fails visibly. No downloads while recording.' },
  SpeechToTextParakeetV3: { label: 'Parakeet TDT 0.6B v3 ASR', preparationNotice: 'Parakeet v3: Save prepares 1.26 GB. Allow 3 GB storage and 6 GB free RAM/GPU memory; WebGPU shader-f16 required.', inputs: { audio: MONO_16KHZ_PCM }, outputs: { final: TEXT }, help: 'Optional NVIDIA v3 ONNX conversion. Save prepares 1.26 GB of weights; allow at least 6 GB free RAM/GPU memory and 3 GB free storage. Requires WebGPU with shader-f16; no CPU fallback. Final only → TextAccumulator.append. 800ms quiet or 12-second chunk cap; Stop drains tails. Hard caps can split words. 30-second backlog limit. Local inference; no recording-time downloads.' },
  SpeechToTextMoonshineMediumEn: { label: 'Moonshine Medium Streaming English ASR', preparationNotice: 'Moonshine Medium English Streaming: Save prepares 305 MB. Allow 700 MB storage and 2 GB free RAM; CPU WASM.', inputs: { audio: MONO_16KHZ_PCM }, outputs: paired(TEXT), help: 'Optional 245M English Medium Streaming, CPU WASM. Save prepares 305 MB of weights; allow at least 2 GB free RAM and 700 MB free storage. Native provisional → TextAccumulator.preview; committed final → TextAccumulator.append. Updates from 0.5 seconds, native endpointing; history renews every 30 seconds after drain. Hard boundaries can split words. 30-second backlog limit. Local inference; no recording-time downloads.' },
  OpusMtJaEn: { label: 'OPUS-MT Japanese → English', inputs: { text: TEXT, provisional: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS, help: 'Committed text by default. Optional provisional accepts any TEXT source; route results through TranslationCommit for previews. Direct source/text/error outputs form one atomic result. Pending and Cancel emit nothing; Stop drains queued text. Failures emit source/error without successful text.' },
  OpusMtEnJa: { label: 'OPUS-MT English → Japanese', inputs: { text: TEXT, provisional: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS, help: 'Committed text by default. Optional provisional accepts any TEXT source; route results through TranslationCommit for previews. Direct source/text/error outputs form one atomic result. Pending and Cancel emit nothing; Stop drains queued text. Failures emit source/error without successful text.' },
  MeetingSummaryLfm2: { label: 'Meeting Summary · LFM2.5 1.2B JP', inputs: { text: TEXT }, outputs: { summary: TEXT }, settings: { language: ['ja', 'en'] }, preparationNotice: 'LFM2.5 JP: Save prepares 749 MB. Allow 2 GB storage and 4 GB free RAM/GPU memory per Node (planning estimate). WebGPU shader-f16. LFM 1.0 commercial-use conditions apply; see Models.', help: 'Batch committed text for 30 seconds or 2,000 characters, then update the previous note with new evidence only. Complete summary → TextToDOM.text → LiveTextDisplay.dom. Stop drains accepted text; Cancel discards pending work. 32,768-character backlog limit; overflow rejects the new fragment visibly and drains accepted text. Summaries are lossy and can omit or distort history. Saved language applies next session. Local WebGPU shader-f16 required; no CPU/cloud fallback or recording-time downloads.' },
  MeetingSummaryQwen35: { label: 'Meeting Summary · Qwen3.5 2B', inputs: { text: TEXT }, outputs: { summary: TEXT }, settings: { language: ['ja', 'en'] }, preparationNotice: 'Qwen3.5 2B: Save prepares 1.403 GB. Allow 3 GB storage and 6 GB free RAM/GPU memory per Node (planning estimate). WebGPU shader-f16. Apache 2.0 source; see Models for conversion provenance.', help: 'Batch committed text for 30 seconds or 2,000 characters, then update the previous note with new evidence only. Complete summary → TextToDOM.text → LiveTextDisplay.dom. Stop drains accepted text; Cancel discards pending work. 32,768-character backlog limit; overflow rejects the new fragment visibly and drains accepted text. Summaries are lossy and can omit or distort history. Saved language applies next session. Local WebGPU shader-f16 required; no CPU/cloud fallback or recording-time downloads.' },
  IfCondition: { label: 'IfCondition · local AI', inputs: { text: TEXT }, outputs: { yes: TEXT, no: TEXT }, textSettings: { condition: { default: 'Is this a question?', maxLength: MAX_CONDITION_CHARS, multiline: true } }, help: 'Evaluate an English natural-language condition locally. Yes/No carries the original text unchanged to exactly one branch. Empty/whitespace text takes No. Save prepares model assets; Start loads an owned CPU WASM Worker. Ambiguous decisions, errors or overflow stop this Node visibly; other paths continue. Stop drains; Cancel discards pending text. Conditions apply next session.' },
  TranslateGemmaEnJa: { label: 'TranslateGemma 4B English → Japanese', inputs: { text: TEXT, provisional: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS,
    preparationNotice: 'TranslateGemma 4B: Save prepares 3.112 GB shared by both directions. Allow 7 GB free storage and several GB free RAM/GPU memory; Worker WebGPU required. Use is subject to Google Gemma Terms of Use and Prohibited Use Policy (see Help / Models).',
    help: 'English → Japanese, browser-local q4. Optional provisional accepts any TEXT source. Connect English ASR.final or Text.value → text. Completed source/text/error form one atomic result; text connects to TextFormatter, TextAccumulator.append, fields or Japanese TTS. Stop drains; Cancel emits nothing. Save prepares 3.112 GB; no recording-time downloads or CPU/cloud fallback. Several GB RAM/GPU memory and WebGPU required. Google Gemma Terms and Prohibited Use Policy apply, including to this public ONNX conversion; see Help / Models before use.' },
  TranslateGemmaJaEn: { label: 'TranslateGemma 4B Japanese → English', inputs: { text: TEXT, provisional: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS,
    preparationNotice: 'TranslateGemma 4B: Save prepares 3.112 GB shared by both directions. Allow 7 GB free storage and several GB free RAM/GPU memory; Worker WebGPU required. Use is subject to Google Gemma Terms of Use and Prohibited Use Policy (see Help / Models).',
    help: 'Japanese → English with the same pinned q4 model as English → Japanese. Optional provisional accepts any TEXT source. Plain TEXT in; grouped source/text/error out. Stop drains; Cancel emits nothing. Save prepares 3.112 GB; allow 7 GB storage and several GB free RAM/GPU memory. Worker WebGPU required; no CPU/cloud fallback. Google Gemma Terms and Prohibited Use Policy apply; see Help / Models before use.' },
  LiveTextDisplay: { label: 'Live text display', inputs: { dom: DOM }, outputs: {}, textSettings: { label: { default: 'Text', maxLength: 120 } }, settings: { language: ['und', 'ja', 'en'] }, help: 'Mount each complete inert DOM snapshot, cloned for safe fan-out. Use TextToDOM for plain text or PairedTextToDOM for the latest comparison pair. Connect DOMAccumulator explicitly for DOM history. Start begins empty; Stop/Cancel retain the latest snapshot. Formatting stays in processors on the page main thread.' },
  TextToDOM: { label: 'Text to DOM', inputs: { text: TEXT }, outputs: { dom: DOM }, help: 'Convert each complete TEXT snapshot to literal visible text, including whitespace, newlines and empty strings. No HTML parsing, accumulation or source matching. Main thread only.' },
  PairedTextToDOM: { label: 'Paired text to DOM', inputs: { source: TEXT, text: TEXT, error: TEXT }, optionalInputs: ['error'], outputs: { dom: DOM }, help: 'Supply source/text and optional error together from one producer. The consumer requires grouped results and rejects provisional deliveries at runtime. Each completed result emits only its exact original/translation pair, including empty results and errors. No history; connect DOMAccumulator explicitly to keep earlier pairs. Hover or focus either cell to highlight its pair. Stop drains; Cancel rejects stale results. Main thread only.' },
  DOMAccumulator: { label: 'DOM accumulator', inputs: { append: DOM }, outputs: { dom: DOM }, help: 'Append each inert DOM snapshot in order, preserving duplicates. Validate and clone inputs and emit the complete accumulated DOM. Start clears history; Stop/Cancel retain committed content and reject stale deliveries. No persistence; growing snapshots consume memory and rendering time. Main thread only.' },
  DOMCombiner: { label: 'DOM combiner', inputs: { first: DOM, second: DOM }, outputs: { dom: DOM }, help: 'Combine the latest first and second inert DOM snapshots in that order. Each update replaces only its input; empty snapshots clear it. Inputs and outputs are validated deep clones. Start clears both; Stop/Cancel retain the latest output and reject stale deliveries. Main thread only.' },
  TextAccumulator: { label: 'Text accumulator', inputs: { append: TEXT, preview: TEXT }, optionalInputs: ['append', 'preview'], outputs: { text: TEXT }, help: 'Reusable transcript state: append commits one exact segment separated by a newline, including repeated/empty values, and clears preview. Preview replaces only the uncommitted tail; empty clears it. Grouped append wins. Every change emits the whole TEXT snapshot. Stop removes preview; Cancel discards pending work; Start begins empty. No truncation or persistence; growing snapshots consume memory and rendering time.' },
  TextWindow: { label: 'Text window', inputs: { text: TEXT }, outputs: { text: TEXT, provisional: TEXT }, numberSettings: { maxChars: { default: 600 }, maxWaitMs: { default: 1500 } }, settings: { sentenceBoundary: ['on', 'off'] }, help: 'Model-independent committed speech batching. 2–1000 characters, 1–30000 ms from first pending text; sentenceBoundary closes conservative punctuation boundaries. Empty strings are ignored; equal utterances and whitespace are retained. Stop flushes once, Cancel discards. text → any translator.text. Optional provisional → the same translator.provisional for bounded retranslation; see TranslationCommit.' },
  TranslationCommit: { label: 'Translation commit (experiment)', inputs: { boundary: TEXT, source: TEXT, text: TEXT, error: TEXT }, outputs: { provisional: TEXT, final: TEXT, error: TEXT }, help: 'Opt-in bounded retranslation: Fan out each committed source event to boundary and translator.text. Results must be one grouped source/text/error emission causally linked to that event; unclosed results are previews. Any TEXT producer can supply boundaries. provisional → TextAccumulator.preview; final → TextAccumulator.append. Only correlated closed source events commit, exactly once; equal text alone never matches. Failures retain source with an error in the committed item. 32-window backlog cap; no new weights or conversation-wide memory.' },
  TextFormatter: { label: 'Text formatter', inputs: FORMAT_INPUTS, optionalInputs: Object.keys(FORMAT_INPUTS), outputs: { text: TEXT }, numberSettings: { inputCount: { default: 4 } }, textSettings: { template: { default: '{1}', maxLength: 2048, multiline: true } }, help: 'Add/remove numbered inputs in Settings. Use {1}, {2}, etc., labels and literal newlines. Escape braces as {{ and }}. Missing inputs are empty. Each emission formats the latest input values; directly grouped emissions replace this producer’s connected inputs together (omitted inputs clear). Independent branches are not correlated.' },
  Supertonic3: { label: 'Supertonic 3 TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { language: ['ja', 'en'], voice: ['F1', 'M1'] } },
  Kokoro: { label: 'Kokoro TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { voice: ['jf_alpha', 'af_heart'] } },
  AudioOutput: { label: 'Audio player / WAV', inputs: { audio: SYNTHESIZED_AUDIO }, outputs: {} },
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
export function defaultGraph({ enabled = false, direction = 'ja-en' } = {}) {
  direction = direction === 'en-ja' ? 'en-ja' : 'ja-en';
  const nodes = [graphNode('ChromeTabAudio', 'audio', 20, 30), graphNode('SpeechToTextReazonSpeech', 'speech', 270, 30), graphNode('LiveTextDisplay', 'transcript', 1450, 30)];
  const edges = [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'transcript-accumulator', 'preview'), edge('speech', 'final', 'transcript-accumulator', 'append'), edge('transcript-accumulator', 'text', 'transcript-dom', 'text'), edge('transcript-dom', 'dom', 'transcript', 'dom')];
  if (enabled) {
    nodes[2].settings = { label: 'Original', language: direction === 'en-ja' ? 'en' : 'ja' };
    nodes.push(graphNode(direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn', 'translation', 270, 330), graphNode('LiveTextDisplay', 'translated', 1450, 330), graphNode('PairedTextToDOM', 'translated-format', 790, 330));
    nodes[4].settings.label = 'Translation';
    edges.push(edge('speech', 'final', 'translation', 'text'));
    edges.push(...pairedTextEdges('translation', 'translated-format'), edge('translated-format', 'dom', 'translated', 'dom'));
  }
  nodes.push(graphNode('TextAccumulator', 'transcript-accumulator', 790, 30), graphNode('TextToDOM', 'transcript-dom', 1120, 30));
  return { version: GRAPH_VERSION, translationDirection: direction, nodes, edges };
}
export const edge = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
export function translationTemplate(direction) {
  return direction === 'en-ja' ? 'English: {1}\nJapanese: {2}{3}' : 'Japanese: {1}\nEnglish: {2}{3}';
}
export function pairedTextEdges(source, target) {
  return ['source', 'text', 'error'].map(port => edge(source, port, target, port));
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
    for (const [key, spec] of Object.entries(definition.textSettings || {})) if (typeof node.settings[key] !== 'string' || node.settings[key].length > (spec.maxLength ?? Infinity) || (key === 'label' && !node.settings[key].trim())) errors.push(`Invalid setting: ${node.id}.${key}`);
    if (!legacy && node.type === 'IfCondition') try { validateCondition(node.settings.condition); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    if (!legacy && node.type === 'TextWindow') try { windowSettings(node.settings); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
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
    const error = new Error(`Translation graph migration needs review. ${changes.join('; ')}. No pending rows or provisional translations are emitted. Failures emit source/error only. Review the repair draft and Save; the original saved graph is kept for recovery.`);
    const candidate = convertDOMGraph(next), errors = validateGraph(candidate);
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
      // Saved append routes may belong to inactive drafts. Retain the old
      // replace-only lifecycle until an append route actually participates.
      next.nodes.push({ ...graphNode('TextAccumulator', id, Math.max(0, display.position.x - 250), display.position.y + 120), legacyDisplay: true });
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
  next.version = GRAPH_VERSION;
  return next;
}
export function migrateGraph(graph) {
  const next = migrateLegacyGraph(graph);
  if (next?.version !== 10 || !Array.isArray(next.nodes) || !Array.isArray(next.edges)) return next;
  const converted = convertDOMGraph(next), errors = validateGraph(converted);
  const error = new Error('DOM display graph v11 requires review. LiveTextDisplay now accepts only dom: DOM. Review the TextToDOM conversion draft and Save; the original saved graph is kept for recovery.');
  if (!errors.length) error.recoveryGraph = converted;
  else error.message += ` Conversion needs repair: ${errors.join(' ')}`;
  throw error;
}
export function assertGraph(graph) {
  const migrated = migrateGraph(graph), errors = validateGraph(migrated);
  if (errors.length) throw new Error(errors.join('\n'));
  return structuredClone(migrated);
}
export function graphPreferences(graph) {
  const translation = graph.nodes.find(node => [...translators, 'TranslateGemmaEnJa', 'TranslateGemmaJaEn'].includes(node.type));
  return { enabled: !!translation, direction: translation
    ? (['OpusMtEnJa', 'TranslateGemmaEnJa'].includes(translation.type) ? 'en-ja' : 'ja-en')
    : graph.translationDirection || graph.nodes.find(node => node.type === 'TranscriptView')?.settings.direction || 'ja-en' };
}
export function withTranslation(graph, { enabled, direction }) {
  const next = assertGraph(graph);
  const current = next.nodes.find(n => translators.includes(n.type));
  next.translationDirection = direction;
  if (enabled && current) for (const node of next.nodes.filter(n => translators.includes(n.type))) node.type = direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn';
  else if (enabled) {
    const branch = defaultGraph({ enabled: true, direction });
    // Choose unused IDs when the user's graph uses the default names elsewhere.
    const ids = new Set(next.nodes.map(n => n.id));
    const unused = base => unusedId(ids, base);
    const id = unused('translation'), sink = unused('translated'), formatter = unused('translated-format'), speech = next.nodes.find(n => ASR_TYPES.includes(n.type));
    if (!speech) throw Error('Add an ASR Node before applying the translation preset, or connect translator Nodes individually.');
    next.nodes.push({ ...branch.nodes[3], id }, { ...branch.nodes[4], id: sink }, { ...branch.nodes[5], id: formatter });
    next.edges.push(edge(speech.id, 'final', id, 'text'));
    next.edges.push(...pairedTextEdges(id, formatter), edge(formatter, 'dom', sink, 'dom'));
  } else {
    const removed = new Set(next.nodes.filter(n => translators.includes(n.type) || n.type === 'TranslationView').map(n => n.id));
    // Remove downstream audio branch too when its only source is translation.
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of next.nodes) {
        const inputs = next.edges.filter(e => e.to[0] === node.id);
        if (!removed.has(node.id) && inputs.length && inputs.every(e => removed.has(e.from[0]))) { removed.add(node.id); changed = true; }
      }
    }
    next.nodes = next.nodes.filter(n => !removed.has(n.id)); next.edges = next.edges.filter(e => !removed.has(e.from[0]) && !removed.has(e.to[0]));
  }
  return assertGraph(next);
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
