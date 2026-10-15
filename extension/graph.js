import { MONO_16KHZ_PCM } from '../web/transcription-nodes.js';
import { TEXT } from '../web/translation-nodes.js';
import { TRANSLATION_OUTPUTS } from './translation-scheduler.js';
import { FORMAT_INPUTS, parseTemplate } from '../web/text-nodes.js';
import { PAIRED_INPUTS } from './paired-text-formatter.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';
import { NUMBER } from '../web/port-contracts.js';
import { finiteNumber } from '../web/number-node.js';
import { whisperLanguage } from '../web/whisper-config.js';
import { maxDurationSamples } from '../web/local-asr-config.js';

export const GRAPH_VERSION = 8;
export const ASR_TYPES = ['SpeechToTextReazonSpeech', 'SpeechToTextWhisper', 'SpeechToTextZipformerEn'];
export const INPUT_TYPES = ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio'];
export const FIELD_TYPES = ['FocusedInputTextOutputNode'];
export const GRAPH_KEY = 'processing-graph-v1';
const paired = contract => ({ provisional: contract, final: contract });
// Fixed concrete production types and their public ports, not a model registry.
export const NODE_TYPES = Object.freeze({
  ChromeTabAudio: { label: 'Chrome tab audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM } },
  SelectedPageMediaAudio: { label: 'Selected page media audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Choose a media element in Live. Top frame only; unsupported media requires whole-tab capture.' },
  MicrophoneAudio: { label: 'Microphone audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Press Start in Live to request microphone permission.' },
  FocusedInputTextOutputNode: { label: 'Focused input text output', inputs: { text: TEXT }, outputs: {}, help: 'Append plain text to the user-focused editable field on the toolbar-invoked tab. Connect SpeechToTextReazonSpeech.final or a processor’s completed text output; no separate authorization or field picker.' },
  Number: { label: 'Number', inputs: {}, outputs: { value: NUMBER }, numberSettings: { value: { default: 6 } }, help: 'Reusable finite numeric constant. Select this Node to edit value. Units and limits belong to its consumer. SpeechToTextReazonSpeech.maxDuration accepts 1–12 seconds, including decimals; saves apply next session.' },
  SpeechToTextReazonSpeech: { label: 'ReazonSpeech ja-en ASR', inputs: { audio: MONO_16KHZ_PCM, maxDuration: NUMBER }, optionalInputs: ['maxDuration'], outputs: paired(TEXT), help: 'Optional maxDuration: connect Number.value for a 1–12 second audio segment cap (default 6 seconds). Includes pre-roll; decimals round down to whole 16 kHz samples. Frozen before capture; saved edits apply next session. VAD can end sooner. Mid-sentence splits may reduce recognition quality. Inference and final display can take longer than the cap.' },
  Text: { label: 'Text', inputs: {}, outputs: { value: TEXT }, textSettings: { value: { default: '', multiline: true } }, help: 'Reusable literal text constant, including empty text. Delivered once at session start to ordinary TEXT consumers. Text.value → Whisper.language is bound before model loading; saves apply next session.' },
  SpeechToTextWhisper: { label: 'Whisper tiny (multilingual) ASR', inputs: { audio: MONO_16KHZ_PCM, language: TEXT }, optionalInputs: ['language'], outputs: { final: TEXT }, help: 'Packaged local multilingual Whisper tiny (q8, CPU WASM). Defaults to English (en); connect Text.value for en or ja. Only final: TEXT is available; connect final to LiveTextDisplay.append for committed segments. Silero ends speech at silence or a 6-second cap; Stop drains every segment. No downloads while recording.' },
  SpeechToTextZipformerEn: { label: 'Streaming Zipformer English ASR', inputs: { audio: MONO_16KHZ_PCM }, outputs: paired(TEXT), help: 'Packaged English-only 20M Zipformer, real online CPU WASM recognition. Incremental provisional → LiveTextDisplay.replace; final → LiveTextDisplay.append. Fixed 12-second segments, Stop flushes the tail. No Silero gating or silence endpoint; silence counts toward the cap. Up to 30 seconds of backlog; overflow fails visibly. No downloads while recording.' },
  OpusMtJaEn: { label: 'OPUS-MT Japanese → English', inputs: { provisional: TEXT, text: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS },
  OpusMtEnJa: { label: 'OPUS-MT English → Japanese', inputs: { provisional: TEXT, text: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS },
  LiveTextDisplay: { label: 'Live text display', inputs: { replace: TEXT, append: TEXT }, optionalInputs: ['replace', 'append'], outputs: {}, textSettings: { label: { default: 'Text', maxLength: 120 } }, settings: { language: ['und', 'ja', 'en'] }, help: 'Replace changes only the preview. Every append adds one committed item and clears the preview; repeated and empty items are preserved. Stop/Cancel keep committed items and discard preview when append is connected. Start again begins empty. Multiple displays are independent and ordered by graph Node order.' },
  TextFormatter: { label: 'Text formatter', inputs: FORMAT_INPUTS, optionalInputs: Object.keys(FORMAT_INPUTS), outputs: { text: TEXT }, textSettings: { template: { default: '{1}', maxLength: 2048, multiline: true } }, help: 'Use {1}–{4}, labels and literal newlines. Escape braces as {{ and }}. Missing inputs are empty. Each emission formats the latest input values; only directly grouped emissions update together. Independent branches are not correlated.' },
  PairedTextFormatter: { label: 'Paired text formatter (compatibility)', inputs: PAIRED_INPUTS, optionalInputs: ['provisionalText', 'provisionalSource', 'provisionalStatus', 'provisionalError'], outputs: { text: TEXT }, settings: { direction: ['ja-en', 'en-ja'] }, help: 'Preserves saved paired translation source/index/status history. Connect the complete final bundle directly from one translator, optionally its complete preview bundle. Connect text to LiveTextDisplay.replace. Independent branches cannot be paired.' },
  Supertonic3: { label: 'Supertonic 3 TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { language: ['ja', 'en'], voice: ['F1', 'M1'] } },
  Kokoro: { label: 'Kokoro TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { voice: ['jf_alpha', 'af_heart'] } },
  AudioOutput: { label: 'Audio player / WAV', inputs: { audio: SYNTHESIZED_AUDIO }, outputs: {} },
});
const LEGACY_VIEWS = {
  TranscriptView: { label: 'Original transcript', inputs: paired(TEXT), optionalInputs: ['provisional'], outputs: {}, settings: { direction: ['ja-en', 'en-ja'] } },
  TranslationView: { label: 'Paired translation / Translated', inputs: {
    ...Object.fromEntries(Object.entries(TRANSLATION_OUTPUTS).filter(([port]) => port !== 'provisional')), provisionalText: TEXT,
  }, optionalInputs: [...Object.keys(TRANSLATION_OUTPUTS).filter(port => port !== 'provisional'), 'provisionalText'], outputs: {}, help: 'Plain display: provisionalText and/or text. Paired display: text plus finalSource, finalStatus, finalIndex, finalError from the same translator; optional provisionalText plus provisionalSource, provisionalStatus, provisionalError. Groups travel directly from one producer; separate processor branches cannot be joined.' },
};
const definitionOf = type => Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
const translators = ['OpusMtJaEn', 'OpusMtEnJa'];
export function graphNode(type, id, x = 20, y = 20) {
  const definition = Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
  if (!definition) throw new Error(`Unknown Node type: ${type}`);
  return { id, type, settings: { ...Object.fromEntries(Object.entries(definition.settings || {}).map(([key, values]) => [key, values[0]])), ...Object.fromEntries(Object.entries({ ...definition.textSettings, ...definition.numberSettings }).map(([key, spec]) => [key, spec.default])) }, position: { x, y } };
}
// Translation is an explicit configuration, never part of a new/reset default.
export function defaultGraph({ enabled = false, direction = 'ja-en' } = {}) {
  direction = direction === 'en-ja' ? 'en-ja' : 'ja-en';
  const nodes = [graphNode('ChromeTabAudio', 'audio', 20, 30), graphNode('SpeechToTextReazonSpeech', 'speech', 270, 30), graphNode('LiveTextDisplay', 'transcript', 800, 30)];
  const edges = [edge('audio', 'audio', 'speech', 'audio'), edge('speech', 'provisional', 'transcript', 'replace'), edge('speech', 'final', 'transcript', 'append')];
  if (enabled) {
    nodes[2].settings = { label: 'Original', language: direction === 'en-ja' ? 'en' : 'ja' };
    nodes.push(graphNode(direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn', 'translation', 270, 230), graphNode('LiveTextDisplay', 'translated', 800, 230), graphNode('PairedTextFormatter', 'translated-format', 530, 230));
    nodes[4].settings.label = 'Translation'; nodes[5].settings.direction = direction;
    for (const port of ['provisional', 'final']) edges.push(edge('speech', port, 'translation', port === 'final' ? 'text' : port));
    edges.push(...translationViewEdges('translation', 'translated-format'), edge('translated-format', 'text', 'translated', 'replace'));
  }
  return { version: GRAPH_VERSION, translationDirection: direction, nodes, edges };
}
export const edge = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
export function translationViewEdges(source, target, provisional = true) {
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
  const types = legacy ? { ...NODE_TYPES, SpeechToText: NODE_TYPES.SpeechToTextReazonSpeech, ...LEGACY_VIEWS } : NODE_TYPES;
  const definitionOf = type => Object.hasOwn(types, type) ? types[type] : undefined;
  const errors = [], warnings = [], configuration = [];
  if (!record(graph) || graph.version !== (legacy ? 5 : GRAPH_VERSION) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return optionalWarnings ? [] : [`Expected version ${legacy ? 5 : GRAPH_VERSION} graph with nodes and edges arrays.`];
  if (graph.translationDirection !== undefined && !['ja-en', 'en-ja'].includes(graph.translationDirection)) errors.push('Invalid translation direction preference.');
  const nodes = new Map(), incoming = new Map(), outgoing = new Map(), seen = new Set();
  for (const node of graph.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(node.id)) { errors.push('Invalid Node ID.'); continue; }
    if (nodes.has(node.id)) errors.push(`Duplicate Node ID: ${node.id}`);
    nodes.set(node.id, node);
    const definition = definitionOf(node.type);
    if (!definition) { errors.push(`Unknown Node type: ${node.type}`); continue; }
    if (!record(node.position) || ![node.position.x, node.position.y].every(n => Number.isFinite(n) && n >= 0)) errors.push(`Invalid position: ${node.id}`);
    if (!record(node.settings)) { errors.push(`Invalid settings: ${node.id}`); continue; }
    for (const key of Object.keys(node.settings)) if (!Object.hasOwn(definition.settings || {}, key) && !Object.hasOwn(definition.textSettings || {}, key) && !Object.hasOwn(definition.numberSettings || {}, key)) errors.push(`Unknown setting: ${node.id}.${key}`);
    for (const key of Object.keys(definition.numberSettings || {})) try { finiteNumber(node.settings[key]); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
    for (const [key, values] of Object.entries(definition.settings || {})) if (!values.includes(node.settings[key])) errors.push(`Invalid setting: ${node.id}.${key}`);
    for (const [key, spec] of Object.entries(definition.textSettings || {})) if (typeof node.settings[key] !== 'string' || node.settings[key].length > (spec.maxLength ?? Infinity) || (key === 'label' && !node.settings[key].trim())) errors.push(`Invalid setting: ${node.id}.${key}`);
    if (node.type === 'TextFormatter') try { parseTemplate(node.settings.template); } catch (error) { errors.push(`${node.id}: ${error.message}`); }
  }
  for (const connection of graph.edges) {
    if (!record(connection) || !Array.isArray(connection.from) || !Array.isArray(connection.to) || connection.from.length !== 2 || connection.to.length !== 2 || ![...connection.from, ...connection.to].every(s => typeof s === 'string')) { errors.push('Malformed named-port edge.'); continue; }
    const key = JSON.stringify([connection.from, connection.to]);
    if (seen.has(key)) errors.push('Duplicate edge.');
    seen.add(key);
    const [source, output] = connection.from, [target, input] = connection.to;
    const a = definitionOf(nodes.get(source)?.type), b = definitionOf(nodes.get(target)?.type);
    if (!a || !b) { errors.push(`Unknown edge Node: ${source} → ${target}`); continue; }
    if (!Object.hasOwn(a.outputs, output) || !Object.hasOwn(b.inputs, input)) { errors.push(`Unknown port: ${source}.${output} → ${target}.${input}`); continue; }
    if (a.outputs[output] !== b.inputs[input]) errors.push(`Incompatible port types: ${source}.${output} → ${target}.${input}`);
    if (['SpeechToTextReazonSpeech', ...(legacy ? ['SpeechToText'] : [])].includes(nodes.get(target)?.type) && input === 'maxDuration') {
      if (nodes.get(source)?.type !== 'Number' || output !== 'value') errors.push(`${target}.maxDuration requires Number.value available before session startup.`);
      else try { maxDurationSamples(nodes.get(source).settings?.value); } catch (error) { configuration.push({ target, message: `${target}: ${error.message}` }); }
    }
    if (nodes.get(target)?.type === 'SpeechToTextWhisper' && input === 'language') {
      if (nodes.get(source)?.type !== 'Text' || output !== 'value') errors.push(`${target}.language requires Text.value available before session startup.`);
      else try { whisperLanguage(nodes.get(source).settings?.value); } catch (error) { configuration.push({ target, message: `${target}: ${error.message}` }); }
    }
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
    const definition = definitionOf(node.type);
    if (!definition) continue;
    if (node.type === 'LiveTextDisplay' || node.type === 'TextFormatter') {
      if (!Object.keys(definition.inputs).some(port => incoming.has(JSON.stringify([node.id, port])))) warnings.push(`Required connection missing: ${node.id} needs at least one TEXT input`);
    }
    if (node.type === 'TranslationView' || node.type === 'PairedTextFormatter') {
      const connected = port => incoming.has(JSON.stringify([node.id, port]));
      if (!connected('text') && !connected('provisionalText')) warnings.push(`Required connection missing: ${node.id}.text or provisionalText`);
      // A paired view can only use directly grouped outputs from one scheduler.
      // Type compatibility alone cannot guarantee association across branches.
      const metadata = ['finalSource', 'finalStatus', 'finalIndex', 'finalError', 'provisionalSource', 'provisionalStatus', 'provisionalError'];
      if (node.type === 'PairedTextFormatter' || metadata.some(connected)) {
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
  // A consumer's startup value constraints apply when that consumer participates.
  // The generic constant and its typed edge remain intact in an unfinished draft.
  const participating = !legacy && !errors.length ? new Set(selectExecutable(graph).nodes.map(node => node.id)) : null;
  for (const { target, message } of configuration) {
    if (!participating || participating.has(target)) errors.push(message);
    else warnings.push(`${message} (inactive configuration)`);
  }
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
      const definition = NODE_TYPES[node.type], routes = incoming.get(node.id);
      const available = port => routes.some(route => route.to[1] === port && ready.has(route.from[0]));
      let required = Object.keys(definition.inputs).filter(port => !definition.optionalInputs?.includes(port));
      if (node.type === 'PairedTextFormatter' && routes.some(route => route.to[1].startsWith('provisional'))) {
        required = [...required, 'provisionalText', 'provisionalSource', 'provisionalStatus', 'provisionalError'];
      }
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
export function migrateGraph(graph) {
  if (!record(graph) || ![1, 2, 3, 4, 5, 6, 7].includes(graph.version)) return graph;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return graph;
  const next = structuredClone(graph);
  if (graph.version === 7) {
    const whisperIds = new Set(next.nodes.filter(node => node?.type === 'SpeechToTextWhisper').map(node => node.id));
    const dead = next.edges.filter(route => Array.isArray(route?.from) && route.from.length === 2 &&
      whisperIds.has(route.from[0]) && route.from[1] === 'provisional' &&
      Array.isArray(route.to) && route.to.length === 2 && route.to.every(value => typeof value === 'string'));
    next.edges = next.edges.filter(route => !dead.includes(route));
    next.version = GRAPH_VERSION;
    const errors = validateGraph(next);
    if (dead.length && errors.length) {
      const routes = dead.map(route => `${route.from.join('.')} → ${route.to.join('.')}`).join(', ');
      const error = new Error(`Cannot migrate saved Whisper connections: ${routes}. Whisper only provides final: TEXT. Removing these dead provisional connections leaves an invalid graph: ${errors.join(' ')} Edit the affected connections in Graph Editor: deliberately connect a supported TEXT output (for example Whisper final → LiveTextDisplay.append), or remove an unused destination, then Save. No connection was redirected; the saved graph has been kept.`);
      // Only offer a repair draft when the remaining graph is safe to render.
      if (errors.every(message => /^(Required connection missing:|Unconnected output Node:)/.test(message))) error.recoveryGraph = next;
      throw error;
    }
    return next;
  }
  const renameAsr = () => {
    for (const node of next.nodes) if (node?.type === 'SpeechToText') node.type = 'SpeechToTextReazonSpeech';
    next.version = 7; return migrateGraph(next);
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
    return translationViewEdges(source.id, target.id).filter(edge => final ? !edge.from[1].startsWith('provisional') : edge.from[1].startsWith('provisional'));
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
        const id = unused(`${node.id}-format`), formatter = graphNode('PairedTextFormatter', id, Math.min(4000, node.position.x), Math.min(4000, node.position.y + 260));
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
export function assertGraph(graph) {
  const migrated = migrateGraph(graph), errors = validateGraph(migrated);
  if (errors.length) throw new Error(errors.join('\n'));
  return structuredClone(migrated);
}
export function graphPreferences(graph) {
  const translation = graph.nodes.find(node => translators.includes(node.type));
  return { enabled: !!translation, direction: translation
    ? (translation.type === 'OpusMtEnJa' ? 'en-ja' : 'ja-en')
    : graph.translationDirection || graph.nodes.find(node => node.type === 'TranscriptView')?.settings.direction || 'ja-en' };
}
export function withTranslation(graph, { enabled, direction }) {
  const next = assertGraph(graph);
  const current = next.nodes.find(n => translators.includes(n.type));
  next.translationDirection = direction;
  for (const formatter of next.nodes.filter(n => n.type === 'PairedTextFormatter')) formatter.settings.direction = direction;
  if (enabled && current) for (const node of next.nodes.filter(n => translators.includes(n.type))) node.type = direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn';
  else if (enabled) {
    const branch = defaultGraph({ enabled: true, direction });
    // Choose unused IDs when the user's graph uses the default names elsewhere.
    const ids = new Set(next.nodes.map(n => n.id));
    const unused = base => unusedId(ids, base);
    const id = unused('translation'), sink = unused('translated'), formatter = unused('translated-format'), speech = next.nodes.find(n => ASR_TYPES.includes(n.type));
    if (!speech) throw Error('Add an ASR Node before applying the translation preset, or connect translator Nodes individually.');
    next.nodes.push({ ...branch.nodes[3], id }, { ...branch.nodes[4], id: sink }, { ...branch.nodes[5], id: formatter });
    for (const port of Object.keys(NODE_TYPES[speech.type].outputs)) next.edges.push(edge(speech.id, port, id, port === 'final' ? 'text' : port));
    next.edges.push(...translationViewEdges(id, formatter), edge(formatter, 'text', sink, 'replace'));
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
  storage.setItem(GRAPH_KEY, JSON.stringify(validated));
  storage.removeItem('opus-mt-translation-preferences');
  return validated;
}
