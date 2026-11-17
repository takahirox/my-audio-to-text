import { SPEAKER_AUDIO } from '../web/speaker-output.js';
import { holdSampledOutputs } from '../web/hold-node.js';
import { BUTTON_LABEL_MAX_LENGTH } from '../web/button-node.js';
import { displayInputs } from '../web/display-node.js';
import { MONO_16KHZ_PCM, asrOutputs, ASR_OUTPUT_GROUPS } from '../web/transcription-nodes.js';
import { TEXT } from '../web/translation-nodes.js';
import { TRANSLATION_OUTPUTS, TRANSLATION_OUTPUT_GROUPS } from './translation-scheduler.js';
import { FORMAT_INPUTS, formatInputs, parseTemplate } from '../web/text-nodes.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { AUDIO_STREAM } from '../web/audio-stream.js';
import { ANY, NUMBER, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST, compatiblePorts } from '../web/port-contracts.js';
import { validateCondition, MAX_CONDITION_CHARS } from '../web/if-condition-policy.js';
import { finiteNumber } from '../web/number-node.js';
import { validateWindowThreshold } from '../web/text-window-node.js';

import { processingPrompt, processingInputs, DEFAULT_PROCESSING_PROMPT, MAX_INSTRUCTION_CHARS } from '../web/text-summary-policy.js';

export const GRAPH_VERSION = 15;
export const ASR_TYPES = ['SpeechToTextMoonshineMediumEn', 'SpeechToTextMoonshineSmallJa'];
export const INPUT_TYPES = ['ChromeTabAudio', 'MicrophoneAudio'];
export const FIELD_TYPES = ['FocusedInputTextOutputNode'];
export const GRAPH_KEY = 'processing-graph-v1';
// Presentation only: committed data/ID first, then previews. Never reorder the
// contract objects or outputGroups: runtime delivery/grouping uses those too.
const ASR_OUTPUT_ORDER = Object.freeze(['final', 'finalId', 'provisional', 'provisionalId']);
const KEYED_INPUT_ORDER = Object.freeze(['input1', 'id1', 'input2', 'id2']);
const TRANSLATION_INPUT_ORDER = Object.freeze(['text', 'id', 'provisional', 'provisionalId', 'context']);
const TRANSLATION_OUTPUT_ORDER = Object.freeze(['text', 'id', 'source', 'error', 'provisionalText', 'provisionalId', 'provisionalSource', 'provisionalError']);

// Display facts only: never copied into graph instances or used for inference.
const aiPresentation = (label, model, languages, runtime = 'CPU / WASM') => ({
  label, ai: Object.freeze({ model, languages, runtime }),
});

// Fixed concrete production types and their public ports, not a model registry.
export const NODE_TYPES = Object.freeze({
  ChromeTabAudio: { label: 'Chrome tab audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM } },
  MicrophoneAudio: { label: 'Microphone audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Press Start in Live to request microphone permission.' },
  FocusedInputTextOutputNode: { label: 'Focused input text output', inputs: { text: TEXT }, outputs: {}, help: 'Append plain text to the user-focused editable field on the toolbar-invoked tab. Connect ASR.final or a processor’s completed text output; no separate authorization or field picker.' },
  Button: { label: 'Button', inputs: {}, outputs: { trigger: NUMBER }, textSettings: { label: { default: 'Run action', maxLength: BUTTON_LABEL_MAX_LENGTH } }, help: 'Live → Graph Actions renders this button by stable Node ID. Each accepted click emits trigger: NUMBER (1), including repeated identical values. Caption may be blank (Run action). No audio permission required. Connect trigger to Hold.trigger to emit the latest held TEXT on demand. Actions are unavailable outside a running session or while overlapping downstream work is busy.' },
  Number: { label: 'Number', inputs: {}, outputs: { value: NUMBER }, numberSettings: { value: { default: 6 } }, help: 'Reusable finite numeric constant. Select this Node to edit value. Units and limits belong to its consumer.' },
  KeyedTextCoalesce: { inputOrder: KEYED_INPUT_ORDER, outputOrder: ['text', 'id'], label: 'Keyed text coalesce', inputs: { id1: NUMBER, input1: TEXT, id2: NUMBER, input2: TEXT }, optionalInputs: ['id1', 'input1', 'id2', 'input2'], outputs: { id: NUMBER, text: TEXT }, help: 'For each finite numeric ID, select nonempty input1, otherwise input2, otherwise empty text. Only the exact empty string is empty; whitespace and duplicate updates count. Each independent idN selects the key for subsequent inputN events; text before the first ID waits (latest value only). ID-only changes never replay completed text or emit blanks. Grouped ID/text updates apply atomically; an omitted grouped ID cannot borrow the previous key. Both branches keep their latest text separately per ID. Each text update emits id/text together, even if unchanged or empty. Start clears all state; Stop/Cancel close delivery. Example: Number.value → id1 and id2, preferred Text.value → input1, backup Text.value → input2; text → Display.input1. No Settings or producer restrictions.' },
  KeyedTextPair: { inputOrder: KEYED_INPUT_ORDER, label: 'Keyed text pair', inputs: { id1: NUMBER, input1: TEXT, id2: NUMBER, input2: TEXT }, optionalInputs: ['id1', 'input1', 'id2', 'input2'], outputs: { pair: KEYED_PAIRED_TEXT }, help: 'Keep the latest left and right text separately per finite numeric ID. Each text update emits a complete immutable pair: KEYED_PAIRED_TEXT { id, first, second }; missing sides are empty. Empty and duplicate strings are real updates. Each branch uses its own latest ID; text before its first ID waits. ID-only changes never replay completed text. Atomic updates apply both sides before emitting once per affected ID; an omitted grouped ID cannot borrow a previous key. Any NUMBER and TEXT producers may connect independently. Start clears; Stop/Cancel reject late work. No Settings, DOM or selection priority. Connect pair → KeyedPairedTextAccumulator.pair → pairs → Display.input1, or pair directly to Display.input1 for the latest pair.' },
  KeyedPairedTextAccumulator: { label: 'Keyed paired text accumulator', inputs: { pair: KEYED_PAIRED_TEXT }, outputs: { pairs: KEYED_PAIRED_TEXT_LIST }, help: 'Append a new numeric ID; replace an existing ID in place in arrival order. Emit a complete immutable ordered array after every pair, including empty and duplicate updates. No stage priorities, selection or rendering. Start clears; Stop/Cancel retain history and reject late work. Connect pairs to Display.input1. No Settings.' },
  Display: { label: 'Display', inputs: displayInputs(), optionalInputs: ['input1'], outputs: {}, numberSettings: { inputCount: { default: 1 } }, textSettings: { title: { default: '', maxLength: 120 } }, help: 'One Display is one tabbed Live view. Each numbered ITEM input is a switchable tab; only the selected input is visible. Add/remove inputs in Settings (1–32) and edit each tab label (blank uses Input 1, Input 2, etc.). Labels never change port identity. ITEM accepts TEXT, KEYED_PAIRED_TEXT or KEYED_PAIRED_TEXT_LIST from any producer. Each delivery replaces only that pane’s complete snapshot; no accumulation or processing. Disconnected tabs stay empty. title names the display group; an empty title falls back to Display plus the Node ID. Hidden tabs keep updating without restarting processing. Start clears; Stop/Cancel retain snapshots. Auto Save applies changes next session.' },
  Hold: { label: 'Hold', inputs: { input: TEXT, trigger: ANY }, optionalInputs: ['input', 'trigger'], outputs: { value: TEXT }, sampledOutputs: ['value'], help: 'Store the latest TEXT silently. With trigger connected, any delivery (ANY input, payload ignored) emits value once, after storing a grouped input first. No value yet emits nothing; explicitly received empty text is valid. This mode uses ordinary event routes and rejects feedback cycles. Without trigger, value starts empty and is sampled together with the next ordinary input at each consumer. Updating Hold never triggers computation. Feedback through Hold is allowed; event cycles remain rejected. Sampled updates run FIFO through awaited downstream work before the next read. Stop drains; Cancel discards queued work; fresh Start clears state. Waiting is bounded to 32 deliveries / 32,768 characters and each update to four minutes; failure visibly stops the branch. Async processors must await their result and emit through the receive context.' },
  Text: { label: 'Text', inputs: {}, outputs: { value: TEXT }, textSettings: { value: { default: '', multiline: true } }, help: 'Reusable literal text constant, including empty text. Delivered once at session start to ordinary TEXT consumers.' },
  SpeechToTextMoonshineMediumEn: { ...aiPresentation('Speech Recognition · EN / Streaming', 'Moonshine Medium Streaming English', 'English'), inputs: { audio: MONO_16KHZ_PCM }, outputs: asrOutputs(), outputOrder: ASR_OUTPUT_ORDER, outputGroups: ASR_OUTPUT_GROUPS, help: 'Optional 245M English Medium Streaming, CPU WASM. Auto Save prepares 305 MB of weights; allow at least 2 GB free RAM and 700 MB free storage. Route final/provisional with their IDs through KeyedTextCoalesce → KeyedTextPair → KeyedPairedTextAccumulator → Display.input1. Updates from 0.5 seconds, native endpointing; history renews every 30 seconds after drain. Hard boundaries can split words. 30-second backlog limit. Local inference; no recording-time downloads.' },
  SpeechToTextMoonshineSmallJa: { ...aiPresentation('Speech Recognition · JA / Streaming', 'Moonshine Small Streaming Japanese', 'Japanese'), inputs: { audio: MONO_16KHZ_PCM }, outputs: asrOutputs(), outputOrder: ASR_OUTPUT_ORDER, outputGroups: ASR_OUTPUT_GROUPS, help: '123M Japanese Small Streaming, CPU WASM. Auto Save prepares 122 MB of weights; allow at least 2 GB free RAM and 300 MB free storage. Route final/provisional with their IDs through KeyedTextCoalesce → KeyedTextPair → KeyedPairedTextAccumulator → Display.input1. Updates from 0.5 seconds, native endpointing; history renews every 30 seconds after drain. Hard boundaries can split words. 30-second backlog limit. Local inference; no recording-time downloads.' },
  TextProcessingLfm2: { ...aiPresentation('Text Processing', 'LFM2.5 1.2B JP', 'Specified by System prompt', 'WebGPU (shader-f16)'), inputs: processingInputs(), optionalInputs: ['input1'], outputs: { result: TEXT }, numberSettings: { inputCount: { default: 1 } }, textSettings: { prompt: { label: 'System prompt', default: DEFAULT_PROCESSING_PROMPT, maxLength: MAX_INSTRUCTION_CHARS, multiline: true } }, help: 'One generation per TEXT update using all latest numbered inputs; an atomic group generates once. Unset inputs are empty. System prompt specifies the task, language and format (1–4,096 characters). Refer to Input 1, Input 2, etc. Input count: 1–32. No prompt port or hidden history. Complete result → Display.input1, including unchanged results. Frequent updates run the model repeatedly: use TextWindow, Hold or Button to control frequency. Hold supports explicit feedback. Stop drains accepted work; Cancel discards pending work. Combined input limit: 32,768 characters; overflow fails visibly without truncation. Auto Save applies settings next session. AI results may be inaccurate; verify against the inputs. Local WebGPU shader-f16 required; no CPU/cloud fallback or recording-time downloads.' },
  TextProcessingQwen35: { ...aiPresentation('Text Processing', 'Qwen3.5 2B', 'Specified by System prompt', 'WebGPU (shader-f16)'), inputs: processingInputs(), optionalInputs: ['input1'], outputs: { result: TEXT }, numberSettings: { inputCount: { default: 1 } }, textSettings: { prompt: { label: 'System prompt', default: DEFAULT_PROCESSING_PROMPT, maxLength: MAX_INSTRUCTION_CHARS, multiline: true } }, help: 'One generation per TEXT update using all latest numbered inputs; an atomic group generates once. Unset inputs are empty. System prompt specifies the task, language and format (1–4,096 characters). Refer to Input 1, Input 2, etc. Input count: 1–32. No prompt port or hidden history. Complete result → Display.input1, including unchanged results. Frequent updates run the model repeatedly: use TextWindow, Hold or Button to control frequency. Hold supports explicit feedback. Stop drains accepted work; Cancel discards pending work. Combined input limit: 32,768 characters; overflow fails visibly without truncation. Auto Save applies settings next session. AI results may be inaccurate; verify against the inputs. Local WebGPU shader-f16 required; no CPU/cloud fallback or recording-time downloads.' },
  IfCondition: { ...aiPresentation('Condition Check · Yes/No', 'XtremeDistil', 'English'), inputs: { text: TEXT }, outputs: { yes: TEXT, no: TEXT }, textSettings: { condition: { default: 'Is this a question?', maxLength: MAX_CONDITION_CHARS, multiline: true } }, help: 'Evaluate an English natural-language condition locally. Yes/No carries the original text unchanged to exactly one branch. Empty/whitespace text takes No. Auto Save prepares model files; Live initializes an owned CPU WASM Worker before enabling Start. Ambiguous decisions, errors or overflow stop this Node visibly; other paths continue. Stop drains; Cancel discards pending text. Conditions apply next session.' },
  Plamo3Translate2B: { ...aiPresentation('Translation', 'PLaMo 3 Translate 2B', '53 languages', 'Experimental · CPU WASM'), inputs: { text: TEXT, provisional: TEXT, id: NUMBER, provisionalId: NUMBER, context: TEXT, source_lang: TEXT, target_lang: TEXT }, optionalInputs: ['provisional', 'id', 'provisionalId', 'context', 'source_lang', 'target_lang'], outputs: TRANSLATION_OUTPUTS, inputOrder: [...TRANSLATION_INPUT_ORDER, 'source_lang', 'target_lang'], outputOrder: TRANSLATION_OUTPUT_ORDER, outputGroups: TRANSLATION_OUTPUT_GROUPS,
    help: 'Experimental local PLaMo 3 Translate 2B. Built with PLaMo. Optional TEXT source_lang and target_lang accept 53 official lowercase language codes (ja, en, fr, ko, de, zh-hans, zh-hant, etc.) or auto. Unconnected source = automatic identification. Unconnected/auto target = official GGUF Japanese/English auto switch; for other input languages, specify a target. A concrete source requires a concrete target. Connect target en to always translate into English. Connect ordinary Text.value ports. Language/context-only updates never translate; each text/provisional job snapshots languages, context and ID. Grouped omissions restore defaults. Optional context TEXT carries reference information in the native PFML3 context section; empty omits it. Connect Text.value → context, e.g. 折り紙を作っています。 for かみを切りました。 Quality improvement is not guaranteed. Context accepts up to 8,000 characters; the full prompt must fit 1,792 runtime tokens with 256 output tokens reserved. Reserved model control tokens and overflow report errors without truncation. Blank/unsupported codes report configuration errors. One model serves all 53 languages; no language or context Settings. Provisional outputs are separately scheduled translation jobs, not generated token streams or live model revisions. Uses the existing committed FIFO, preview replacement, IDs, error routing, Stop drain and Cancel ownership. Up to 1,000 characters and 256 generated tokens. Auto Save prepares 1.81 GB of verified GGUF data; no bundled weights or cloud inference. Desktop Chromium CPU WASM, single thread; allow 5 GB storage and 6 GB free RAM per Node (estimate), potentially slow. PLaMo Community License applies: commercial use requires prior PFN registration and annual revenue/sales ≤1 billion yen; otherwise obtain a separate license. Read full terms in Models before use.' },
  TranslateGemma4B: { ...aiPresentation('Translation', 'TranslateGemma 4B', 'Per-request language codes', 'WebGPU'), inputs: { text: TEXT, provisional: TEXT, id: NUMBER, provisionalId: NUMBER, context: TEXT, source_lang: TEXT, target_lang: TEXT }, optionalInputs: ['provisional', 'id', 'provisionalId', 'context', 'source_lang', 'target_lang'], outputs: TRANSLATION_OUTPUTS, inputOrder: [...TRANSLATION_INPUT_ORDER, 'source_lang', 'target_lang'], outputOrder: TRANSLATION_OUTPUT_ORDER, outputGroups: TRANSLATION_OUTPUT_GROUPS,
    help: 'Local TranslateGemma 4B q4. Optional TEXT source_lang and target_lang use pinned template language codes (ja, en, fr, de, etc.; case sensitive, underscores normalize to hyphens). Unconnected defaults: ja → en; no auto detection. Connect ordinary Text.value ports; no language Settings. Blank/unsupported codes report errors. Language/context-only updates never translate. Every text/provisional job snapshots languages, context and ID; grouped omissions restore defaults. Optional context: up to 4,000 characters of reference-only text for experimental disambiguation; empty uses the official structured template. Up to 1,000 characters/256 output tokens. Committed source/text/error/id and preview provisionalSource/provisionalText/provisionalError/provisionalId are separate atomic families sharing one loaded Worker. Preview replacement, clearing on final/Stop/Cancel, committed FIFO and ID matching are preserved. Stop drains; Cancel discards pending work. Auto Save prepares the same shared 3.112 GB cache; allow 7 GB storage and several GB free RAM/GPU memory. Worker WebGPU required. Google Gemma Terms and Prohibited Use Policy apply; see Models before use.' },
  TextAccumulator: { label: 'Text accumulator', inputs: { append: TEXT }, outputs: { text: TEXT }, help: 'Append each exact TEXT segment separated by a newline, including repeated and empty values. Every append emits the complete accumulated snapshot. Start clears history and emits empty text; Stop/Cancel retain committed text. Connect text directly to Display.input1 for complete snapshots. No truncation or persistence; growing snapshots consume memory and rendering time.' },
  TextSlidingWindow: { label: 'Text sliding window', inputs: { text: TEXT, maxChars: NUMBER }, optionalInputs: ['maxChars'], outputs: { text: TEXT }, help: 'Append fragments exactly and emit the entire retained window on every text event, including empty text and duplicates. Optional maxChars: positive safe integer in UTF-16 code units (default 1000). Evicts oldest sentences, then words, then clips a suffix without splitting surrogate pairs. Limit updates trim silently; Stop/Cancel discard history. No Settings.' },
  TextWindow: { label: 'Text window', inputs: { text: TEXT, maxChars: NUMBER, maxWaitSeconds: NUMBER }, optionalInputs: ['maxChars', 'maxWaitSeconds'], outputs: { text: TEXT }, help: 'Generic exact text batching. Optional NUMBER inputs: maxChars (whole number ≥2 UTF-16 units; default 600) and maxWaitSeconds (positive seconds; default 1.5). Updates apply independently to pending text; the deadline starts with the first fragment and is not reset by arrivals. No added separators or punctuation rules. Length emissions remove only their chunk and preserve the remainder. Stop flushes once; Cancel discards. No threshold Settings or preview output.' },
  TextFormatter: { label: 'Text formatter', inputs: FORMAT_INPUTS, optionalInputs: Object.keys(FORMAT_INPUTS), outputs: { text: TEXT }, numberSettings: { inputCount: { default: 4 } }, textSettings: { template: { default: '{1}', maxLength: 2048, multiline: true } }, help: 'Add/remove numbered inputs in Settings. Use {1}, {2}, etc., labels and literal newlines. Escape braces as {{ and }}. Missing inputs are empty. Each emission formats the latest input values; directly grouped emissions replace the emitted family’s connected inputs together (omitted siblings clear). Independent branches are not correlated. With Hold.trigger disconnected, Hold.value is sampled with an ordinary delivery and never triggers formatting. With trigger connected, value is ordinary emitted TEXT and triggers formatting.' },
  Supertonic3: { ...aiPresentation('Speech Synthesis', 'Supertonic 3', 'Japanese, English'), inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { language: ['ja', 'en'], voice: ['F1', 'M1'] } },
  Kokoro: { ...aiPresentation('Speech Synthesis', 'Kokoro 82M', 'Japanese, English (determined by voice)'), inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { voice: ['jf_alpha', 'af_heart'] } },
  Qwen3TtsStreaming: { ...aiPresentation('Speech Synthesis · Streaming', 'Qwen3-TTS 0.6B CustomVoice', 'Japanese, English', 'WebGPU'), inputs: { text: TEXT }, outputs: { stream: AUDIO_STREAM }, settings: { language: ['japanese', 'english'], voice: ['ono_anna', 'ryan'] },
    help: 'Committed TEXT → genuinely incremental mono PCM → Speaker. Choose language and voice explicitly (ono_anna Japanese, ryan English). Use ASR.final or committed translation.text, never revisable previews. Up to 300 characters/256 tokens and 20.48 seconds of generated speech per utterance; split longer text before this Node. 16 utterances/4,800 characters queued. Auto Save prepares pinned weights; Live downloads missing files before enabling Start. No CPU/cloud fallback. Stop drains accepted speech; Cancel terminates the owned Worker and playback. Desktop WebGPU only; speed depends on hardware.' },
  CosyVoice3Streaming: { ...aiPresentation('Speech Synthesis · Streaming', 'CosyVoice3 0.5B', 'English, Japanese (automatic from text)', 'WebGPU'), inputs: { text: TEXT }, outputs: { stream: AUDIO_STREAM }, settings: { language: ['english', 'japanese'], voice: ['libritts-r-4446'] },
    help: 'Committed English/Japanese TEXT → incremental 24 kHz PCM → Speaker. One reviewed reference voice; no voice cloning. Language follows the input text. Spell out numbers and symbols; no native text normalizer is included. Up to 300 characters/128 text tokens, 500 speech tokens (20 seconds); hitting a limit without EOS visibly aborts. 16 utterances/4,800 characters queued. Auto Save prepares pinned weights; Live downloads missing files before enabling Start. Stop drains accepted speech; Cancel terminates the owned Worker and playback. Desktop WebGPU only, no CPU/cloud fallback. Other languages, mobile and low-memory devices are unqualified. Short utterances may finish before the first chunk.' },
  AudioOutput: { label: 'Audio player / WAV', inputs: { audio: SYNTHESIZED_AUDIO }, outputs: {} },
  SpeakerOutput: { label: 'Speaker', inputs: { audio: SPEAKER_AUDIO }, outputs: {} },
});
// Resolve against the instance definition (including dynamic inputs). Ignore
// malformed, duplicate and unknown entries; append unspecified own ports in
// declaration order so partial/stale metadata can never hide a real control.
// Only views call this helper; graph JSON and runtime iteration stay unchanged.
export function portDisplayEntries(definition, side) {
  const ports = definition[`${side}s`], order = definition[`${side}Order`];
  const names = new Set();
  if (Array.isArray(order)) for (const name of order) {
    if (typeof name === 'string' && Object.hasOwn(ports, name)) names.add(name);
  }
  for (const name of Object.keys(ports)) names.add(name);
  return [...names].map(name => [name, ports[name]]);
}
export function nodeDefinition(node, graph, definitions = []) {
  if (node?.type === 'Subgraph') {
    const entry = definitions.find(entry => entry.id === node.subgraphId && entry.kind === 'subgraph');
    if (!entry || !Array.isArray(entry.graph?.nodes) || !Array.isArray(entry.graph?.edges)
      || !['inputs', 'outputs'].every(side => Array.isArray(entry.graph.interface?.[side]))
      || entry.graph.nodes.some(child => child?.type === 'Subgraph')) return undefined;
    const ports = side => Object.fromEntries((entry.graph.interface?.[side] || []).map(port => [port.id,
      nodeDefinition(entry.graph.nodes.find(child => child.id === port.node), entry.graph)?.[side]?.[port.port]]));
    const inputs = ports('inputs'), outputs = ports('outputs');
    if (![...Object.values(inputs), ...Object.values(outputs)].every(Boolean)) return undefined;
    return { label: entry.name, inputs, outputs, optionalInputs: Object.keys(inputs),
      sampledOutputs: (entry.graph.interface?.outputs || []).filter(port => nodeDefinition(entry.graph.nodes.find(child => child.id === port.node), entry.graph)?.sampledOutputs?.includes(port.port)).map(port => port.id),
      portLabels: Object.fromEntries(['inputs', 'outputs'].map(side => [side, Object.fromEntries((entry.graph.interface?.[side] || []).map(port => [port.id, port.name]))])),
      help: 'Shared saved definition. Edits in its editor save automatically and apply to every parent on the next run.' };
  }
  const definition = Object.hasOwn(NODE_TYPES, node?.type) ? NODE_TYPES[node.type] : undefined;
  if (!definition) return undefined;
  if (node.type === 'Hold' && graph) return { ...definition, sampledOutputs: holdSampledOutputs(graph.edges.filter(route => route?.to?.[0] === node.id).map(route => route.to[1])) };
  if (!['TextFormatter', 'Display', 'TextProcessingLfm2', 'TextProcessingQwen35'].includes(node.type)) return definition;
  let inputs;
  try { inputs = (node.type === 'Display' ? displayInputs : node.type.startsWith('TextProcessing') ? processingInputs : formatInputs)(node.settings?.inputCount); } catch { inputs = {}; }
  return { ...definition, inputs, optionalInputs: Object.keys(inputs) };
}
export function graphNode(type, id, x = 20, y = 20) {
  const definition = Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
  if (!definition) throw new Error(`Unknown Node type: ${type}`);
  return { id, type, settings: { ...Object.fromEntries(Object.entries(definition.settings || {}).map(([key, values]) => [key, values[0]])), ...Object.fromEntries(Object.entries({ ...definition.textSettings, ...definition.numberSettings }).map(([key, spec]) => [key, spec.default])) }, position: { x, y } };
}
// New/reset graphs explicitly recognize Japanese; translation is explicit.
export function defaultGraph() {
  const nodes = [graphNode('ChromeTabAudio', 'audio', 20, 30),
    graphNode('SpeechToTextMoonshineSmallJa', 'speech', 270, 30),
    graphNode('KeyedTextCoalesce', 'coalesce', 620, 30),
    graphNode('KeyedTextPair', 'pair', 960, 30),
    graphNode('KeyedPairedTextAccumulator', 'history', 1300, 30),
    graphNode('Display', 'transcript', 1640, 30)];
  const edges = [edge('audio', 'audio', 'speech', 'audio'),
    edge('speech', 'finalId', 'coalesce', 'id1'), edge('speech', 'final', 'coalesce', 'input1'),
    edge('speech', 'provisionalId', 'coalesce', 'id2'), edge('speech', 'provisional', 'coalesce', 'input2'),
    edge('coalesce', 'id', 'pair', 'id1'), edge('coalesce', 'text', 'pair', 'input1'),
    edge('pair', 'pair', 'history', 'pair'), edge('history', 'pairs', 'transcript', 'input1')];
  return { version: GRAPH_VERSION, nodes, edges };
}
export const edge = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
// Version 15 graphs remain readable. Canonicalize legacy Display and Speaker
// inputs without mutating the caller or rewriting unrelated data.
export function upgradeGraph(graph) {
  if (graph?.version !== GRAPH_VERSION || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return graph;
  const upgraded = structuredClone(graph), ids = new Set(), speakers = new Set();
  for (const node of upgraded.nodes) if (node?.type === 'StreamingSpeakerOutput') {
    speakers.add(node.id); node.type = 'SpeakerOutput';
  }
  for (const route of upgraded.edges) if (Array.isArray(route?.to) && speakers.has(route.to[0]) && route.to[1] === 'stream') route.to[1] = 'audio';
  for (const port of Array.isArray(upgraded.interface?.inputs) ? upgraded.interface.inputs : []) if (speakers.has(port?.node) && port.port === 'stream') port.port = 'audio';
  for (const node of upgraded.nodes) if (node?.type === 'Display') {
    ids.add(node.id);
    if (record(node.settings)) {
      if (!Object.hasOwn(node.settings, 'inputCount')) node.settings.inputCount = 1;
      if (!Object.hasOwn(node.settings, 'title')) node.settings.title = '';
    }
  }
  for (const route of upgraded.edges) if (Array.isArray(route?.to) && ids.has(route.to[0]) && route.to[1] === 'input') route.to[1] = 'input1';
  return upgraded;
}
export function validateGraph(graph, optionalWarnings = false, definitions = []) {
  graph = upgradeGraph(graph);
  const definitionOf = type => Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
  const errors = [], warnings = [];
  if (!record(graph) || graph.version !== GRAPH_VERSION || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return optionalWarnings ? [] : [`Expected version ${GRAPH_VERSION} graph with nodes and edges arrays.`];
  const nodes = new Map(), incoming = new Map(), outgoing = new Map(), emitting = new Map(), seen = new Set();
  for (const node of graph.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(node.id)) { errors.push('Invalid Node ID.'); continue; }
    if (nodes.has(node.id)) errors.push(`Duplicate Node ID: ${node.id}`);
    nodes.set(node.id, node);
    const definition = nodeDefinition(node, graph, definitions);
    if (!definition) {
      if (['MeetingSummaryLfm2', 'MeetingSummaryQwen35', 'TextSummaryLfm2', 'TextSummaryQwen35'].includes(node.type)) {
        errors.push(`Legacy summary Node ${node.id}: ${node.type} was replaced by ${node.type.replace(/^(MeetingSummary|TextSummary)/, 'TextProcessing')}. Copy the original JSON from Graph actions → Saved JSON. Change the type, set settings.inputCount to 1, keep or add settings.prompt with an explicit task and desired output language, and remove settings.language. Change this Node's text input to input1 and summary output to result in edges and exposed Subgraph ports. Keep all IDs, positions, content and other wiring. Import the repaired JSON as a new graph in Library. See docs/text-summary-nodes.md. The original graph is retained.`);
      } else if (node.type === 'Subgraph') errors.push(`Missing or invalid subgraph ${node.subgraphId}. Import its dependency bundle or remove the instance. Nested and circular subgraphs are not supported.`);
      else errors.push(`Unknown Node type: ${node.type}. Recreate or reset the graph using supported Node types.`);
      continue;
    }
    if (node.type === 'Subgraph' && (typeof node.subgraphId !== 'string' || !definitions.some(entry => entry.id === node.subgraphId && entry.kind === 'subgraph'))) errors.push(`Missing subgraph: ${node.subgraphId}`);
    if (Object.hasOwn(node, 'legacyView')) errors.push(`Unsupported setting: ${node.id}.legacyView. Reset or import a current graph.`);
    if (!record(node.position) || ![node.position.x, node.position.y].every(n => Number.isFinite(n) && n >= 0)) errors.push(`Invalid position: ${node.id}`);
    if (!record(node.settings)) { errors.push(`Invalid settings: ${node.id}`); continue; }
    for (const key of Object.keys(node.settings)) if (!Object.hasOwn(definition.settings || {}, key) && !Object.hasOwn(definition.textSettings || {}, key) && !Object.hasOwn(definition.numberSettings || {}, key) && !(node.type === 'Display' && key === 'inputLabels')) errors.push(`Unknown setting: ${node.id}.${key}`);
    for (const key of Object.keys(definition.numberSettings || {})) try { finiteNumber(node.settings[key]); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    for (const [key, values] of Object.entries(definition.settings || {})) if (!values.includes(node.settings[key])) errors.push(`Invalid setting: ${node.id}.${key}`);
    for (const [key, spec] of Object.entries(definition.textSettings || {})) {
      if (spec.optional && node.settings[key] === undefined) continue;
      if (typeof node.settings[key] !== 'string' || node.settings[key].length > (spec.maxLength ?? Infinity) || (key === 'label' && node.type !== 'Button' && !node.settings[key].trim())) errors.push(`Invalid setting: ${node.id}.${key}`);
    }
    if (['TextProcessingLfm2', 'TextProcessingQwen35'].includes(node.type)) try { processingPrompt(node.settings.prompt ?? null); processingInputs(node.settings.inputCount); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    if (node.type === 'IfCondition') try { validateCondition(node.settings.condition); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    if (node.type === 'Display') try { displayInputs(node.settings.inputCount); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    if (node.type === 'Display' && node.settings.inputLabels !== undefined) {
      const labels = node.settings.inputLabels;
      if (!record(labels)) errors.push(`Invalid setting: ${node.id}.inputLabels`);
      else for (const [port, label] of Object.entries(labels)) {
        if (!Object.hasOwn(definition.inputs, port) || typeof label !== 'string' || label.length > 120) errors.push(`Invalid setting: ${node.id}.inputLabels.${port}`);
      }
    }
    if (node.type === 'TextFormatter') try { formatInputs(node.settings.inputCount); parseTemplate(node.settings.template, node.settings.inputCount); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
  }
  for (const connection of graph.edges) {
    if (!record(connection) || !Array.isArray(connection.from) || !Array.isArray(connection.to) || connection.from.length !== 2 || connection.to.length !== 2 || ![...connection.from, ...connection.to].every(s => typeof s === 'string')) { errors.push('Malformed named-port edge.'); continue; }
    const key = JSON.stringify([connection.from, connection.to]);
    if (seen.has(key)) errors.push('Duplicate edge.');
    seen.add(key);
    const [source, output] = connection.from, [target, input] = connection.to;
    const a = nodeDefinition(nodes.get(source), graph, definitions), b = nodeDefinition(nodes.get(target), graph, definitions);
    if (!a || !b) { errors.push(`Unknown edge Node: ${source} → ${target}`); continue; }
    if (!Object.hasOwn(a.outputs, output) || !Object.hasOwn(b.inputs, input)) { errors.push(`Unknown port: ${source}.${output} → ${target}.${input}`); continue; }
    if (!compatiblePorts(a.outputs[output], b.inputs[input])) errors.push(`Incompatible port types: ${source}.${output} → ${target}.${input}`);
    const destination = JSON.stringify([target, input]);
    if (incoming.has(destination)) errors.push(`Only one connection allowed to ${target}.${input}`);
    incoming.set(destination, connection.from);
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(target);
    if (!a.sampledOutputs?.includes(output)) {
      if (!emitting.has(source)) emitting.set(source, []);
      emitting.get(source).push(target);
    }
  }
  const degree = new Map([...nodes.keys()].map(id => [id, 0]));
  for (const targets of emitting.values()) for (const target of targets) degree.set(target, degree.get(target) + 1);
  const roots = [...degree.keys()].filter(id => degree.get(id) === 0);
  for (let index = 0; index < roots.length; index++) for (const target of emitting.get(roots[index]) || []) {
    degree.set(target, degree.get(target) - 1);
    if (!degree.get(target)) roots.push(target);
  }
  if (roots.length !== nodes.size) errors.push('Graph must be acyclic.');
  for (const node of nodes.values()) {
    const definition = nodeDefinition(node, graph, definitions);
    if (!definition) continue;
    if (['TextFormatter', 'TextAccumulator'].includes(node.type)) {
      if (!Object.keys(definition.inputs).filter(port => definition.inputs[port] === TEXT).some(port => incoming.has(JSON.stringify([node.id, port])))) warnings.push(`Required connection missing: ${node.id} needs at least one TEXT input`);
    }
    const route = port => incoming.get(JSON.stringify([node.id, port]));
    if (['KeyedTextCoalesce', 'KeyedTextPair'].includes(node.type) && ![1, 2].some(n => route(`id${n}`) && route(`input${n}`))) warnings.push(`Required connection missing: ${node.id} needs an ID/TEXT pair`);
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
      const definition = nodeDefinition(node, description), routes = incoming.get(node.id);
      const available = port => routes.some(route => route.to[1] === port && ready.has(route.from[0]));
      const required = Object.keys(definition.inputs).filter(port => !definition.optionalInputs?.includes(port));
      if (!required.every(available)) continue;
      if (node.type === 'Hold' && routes.some(route => route.to[1] === 'trigger') && !available('trigger')) continue;
      if (['KeyedTextCoalesce', 'KeyedTextPair'].includes(node.type) && ![1, 2].some(n => available(`id${n}`) && available(`input${n}`))) continue;
      if (!definition.sampledOutputs?.length && Object.keys(definition.inputs).length && !routes.some(route => ready.has(route.from[0]))) continue;
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
  const warnings = validateGraph(graph, true);
  if (!validateGraph(graph).length) {
    const active = new Set(executableGraph(graph).nodes.map(node => node.id));
    for (const node of graph.nodes) if (!active.has(node.id)) warnings.push(`Inactive Node: ${node.id} does not participate in an executable path.`);
    if (!active.size) warnings.push('No executable path. Connect a source through complete processors to an output destination.');
  }
  return warnings;
}
export function assertGraph(graph, definitions = []) {
  graph = upgradeGraph(graph);
  const errors = validateGraph(graph, false, definitions);
  if (errors.length) throw new Error(errors.join('\n'));
  return structuredClone(graph);
}
// Layout remains part of persistence, history and validation. Runtime owners
// and pending-session notices compare the resolved graph without coordinates.
// Remove only Node layout: settings (including any nested position) still count.
export function graphExecutionFingerprint(graph) {
  return JSON.stringify(graph && { ...graph, nodes: graph.nodes.map(({ position, ...node }) => node) });
}
export function hasTranslation(graph) {
  return graph.nodes.some(node => ['TranslateGemma4B', 'Plamo3Translate2B'].includes(node.type));
}
// Legacy-only API for standalone graph consumers. MV3 pages must resolve a
// stable library ID via graph-library.js; never implicitly edit another graph.
export function readGraph(storage) {
  if (storage.getItem('processing-graph-library-v1') !== null) throw Error('Use graph-library.js with an explicit graph ID; legacy readGraph cannot select a library graph.');
  const saved = storage.getItem(GRAPH_KEY);
  if (saved !== null) {
    try { return assertGraph(JSON.parse(saved)); }
    catch (error) {
      throw new Error(`Invalid saved graph: ${error.message} Export the original and import a repaired current graph as a new entry in Library. The saved graph has been kept.`);
    }
  }
  return saveGraph(storage, defaultGraph());
}
export function saveGraph(storage, graph) {
  if (storage.getItem('processing-graph-library-v1') !== null) throw Error('Use GraphLibrary.save with a graph ID and revision; legacy saveGraph cannot overwrite a library graph.');
  const validated = assertGraph(graph);
  storage.setItem(GRAPH_KEY, JSON.stringify(validated));
  return validated;
}
