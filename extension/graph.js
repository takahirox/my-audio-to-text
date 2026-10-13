import { MONO_16KHZ_PCM } from '../web/transcription-nodes.js';
import { TEXT } from '../web/translation-nodes.js';
import { TRANSLATION_OUTPUTS } from './translation-scheduler.js';
import { SYNTHESIZED_AUDIO } from '../web/synthesized-audio.js';

export const GRAPH_VERSION = 5;
export const INPUT_TYPES = ['ChromeTabAudio', 'SelectedPageMediaAudio', 'MicrophoneAudio'];
export const FIELD_TYPES = ['FocusedInputTextOutputNode'];
export const GRAPH_KEY = 'processing-graph-v1';
const paired = contract => ({ provisional: contract, final: contract });
// Fixed concrete production types and their public ports, not a model registry.
export const NODE_TYPES = Object.freeze({
  ChromeTabAudio: { label: 'Chrome tab audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM } },
  SelectedPageMediaAudio: { label: 'Selected page media audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Choose a media element in Live. Top frame only; unsupported media requires whole-tab capture.' },
  MicrophoneAudio: { label: 'Microphone audio', inputs: {}, outputs: { audio: MONO_16KHZ_PCM }, help: 'Press Start in Live to request microphone permission.' },
  FocusedInputTextOutputNode: { label: 'Focused input text output', inputs: { text: TEXT }, outputs: {}, help: 'Append plain text to the user-focused editable field on the toolbar-invoked tab. Connect SpeechToText.final or a processor’s completed text output; no separate authorization or field picker.' },
  SpeechToText: { label: 'Speech to text', inputs: { audio: MONO_16KHZ_PCM }, outputs: paired(TEXT) },
  TranscriptView: { label: 'Original transcript', inputs: paired(TEXT), optionalInputs: ['provisional'], outputs: {}, settings: { direction: ['ja-en', 'en-ja'] } },
  OpusMtJaEn: { label: 'OPUS-MT Japanese → English', inputs: { provisional: TEXT, text: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS },
  OpusMtEnJa: { label: 'OPUS-MT English → Japanese', inputs: { provisional: TEXT, text: TEXT }, optionalInputs: ['provisional'], outputs: TRANSLATION_OUTPUTS },
  TranslationView: { label: 'Paired translation / Translated', inputs: {
    ...Object.fromEntries(Object.entries(TRANSLATION_OUTPUTS).filter(([port]) => port !== 'provisional')), provisionalText: TEXT,
  }, optionalInputs: [...Object.keys(TRANSLATION_OUTPUTS).filter(port => port !== 'provisional'), 'provisionalText'], outputs: {}, help: 'Plain display: provisionalText and/or text. Paired display: text plus finalSource, finalStatus, finalIndex, finalError from the same translator; optional provisionalText plus provisionalSource, provisionalStatus, provisionalError. Groups travel directly from one producer; separate processor branches cannot be joined.' },
  Supertonic3: { label: 'Supertonic 3 TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { language: ['ja', 'en'], voice: ['F1', 'M1'] } },
  Kokoro: { label: 'Kokoro TTS', inputs: { text: TEXT }, outputs: { audio: SYNTHESIZED_AUDIO }, settings: { voice: ['jf_alpha', 'af_heart'] } },
  AudioOutput: { label: 'Audio player / WAV', inputs: { audio: SYNTHESIZED_AUDIO }, outputs: {} },
});
const definitionOf = type => Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
const translators = ['OpusMtJaEn', 'OpusMtEnJa'];
export function graphNode(type, id, x = 20, y = 20) {
  const definition = Object.hasOwn(NODE_TYPES, type) ? NODE_TYPES[type] : undefined;
  if (!definition) throw new Error(`Unknown Node type: ${type}`);
  return { id, type, settings: Object.fromEntries(Object.entries(definition.settings || {}).map(([key, values]) => [key, values[0]])), position: { x, y } };
}
export function defaultGraph({ enabled = true, direction = 'ja-en' } = {}) {
  const nodes = [graphNode('ChromeTabAudio', 'audio', 20, 30), graphNode('SpeechToText', 'speech', 270, 30), graphNode('TranscriptView', 'transcript', 530, 30)];
  nodes[2].settings.direction = direction === 'en-ja' ? 'en-ja' : 'ja-en';
  const edges = [edge('audio', 'audio', 'speech', 'audio'), ...['provisional', 'final'].map(port => edge('speech', port, 'transcript', port))];
  if (enabled) {
    nodes.push(graphNode(direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn', 'translation', 270, 230), graphNode('TranslationView', 'translated', 530, 230));
    for (const port of ['provisional', 'final']) edges.push(edge('speech', port, 'translation', port === 'final' ? 'text' : port));
    edges.push(...translationViewEdges('translation', 'translated'));
  }
  return { version: GRAPH_VERSION, nodes, edges };
}
export const edge = (source, output, target, input) => ({ from: [source, output], to: [target, input] });
export function translationViewEdges(source, target, provisional = true) {
  const ports = ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError',
    ...(provisional ? ['provisional', 'provisionalSource', 'provisionalStatus', 'provisionalError'] : [])];
  return ports.map(port => edge(source, port, target, port === 'provisional' ? 'provisionalText' : port));
}
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateGraph(graph) {
  const errors = [];
  if (!record(graph) || graph.version !== GRAPH_VERSION || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return ['Expected version 5 graph with nodes and edges arrays.'];
  if (graph.nodes.length > 24 || graph.edges.length > 64) return ['Graph exceeds the supported size (24 nodes / 64 edges).'];
  const nodes = new Map(), incoming = new Map(), outgoing = new Map(), seen = new Set();
  for (const node of graph.nodes) {
    if (!record(node) || typeof node.id !== 'string' || !/^[a-zA-Z][\w-]{0,63}$/.test(node.id)) { errors.push('Invalid Node ID.'); continue; }
    if (nodes.has(node.id)) errors.push(`Duplicate Node ID: ${node.id}`);
    nodes.set(node.id, node);
    const definition = Object.hasOwn(NODE_TYPES, node.type) && NODE_TYPES[node.type];
    if (!definition) { errors.push(`Unknown Node type: ${node.type}`); continue; }
    if (!record(node.position) || ![node.position.x, node.position.y].every(n => Number.isFinite(n) && n >= 0 && n <= 4000)) errors.push(`Invalid position: ${node.id}`);
    if (!record(node.settings)) { errors.push(`Invalid settings: ${node.id}`); continue; }
    for (const key of Object.keys(node.settings)) if (!Object.hasOwn(definition.settings || {}, key)) errors.push(`Unknown setting: ${node.id}.${key}`);
    for (const [key, values] of Object.entries(definition.settings || {})) if (!values.includes(node.settings[key])) errors.push(`Invalid setting: ${node.id}.${key}`);
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
    const destination = JSON.stringify([target, input]);
    if (incoming.has(destination)) errors.push(`Only one connection allowed to ${target}.${input}`);
    incoming.set(destination, connection.from);
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(target);
  }
  const active = new Set(), visited = new Set();
  function visit(id) {
    if (active.has(id)) { errors.push('Graph must be acyclic.'); return; }
    if (visited.has(id)) return;
    active.add(id); for (const target of outgoing.get(id) || []) visit(target);
    active.delete(id); visited.add(id);
  }
  for (const id of nodes.keys()) visit(id);
  const ofType = type => graph.nodes.filter(n => n?.type === type);
  if (graph.nodes.filter(n => INPUT_TYPES.includes(n?.type)).length !== 1) errors.push('Exactly one audio input is required; simultaneous sources are ambiguous.');
  if (ofType('SpeechToText').length !== 1) errors.push('Exactly one SpeechToText is required.');
  if (ofType('TranscriptView').length > 1) errors.push('Only one shared Live transcript destination is supported.');
  if (graph.nodes.filter(n => translators.includes(n?.type)).length > 1 || ofType('TranslationView').length > 1) errors.push('Only one paired translation branch is supported.');
  for (const node of nodes.values()) {
    const definition = definitionOf(node.type);
    if (!definition) continue;
    if (node.type === 'TranslationView') {
      const connected = port => incoming.has(JSON.stringify([node.id, port]));
      if (!connected('text') && !connected('provisionalText')) errors.push(`Required connection missing: ${node.id}.text or provisionalText`);
      // A paired view can only use directly grouped outputs from one scheduler.
      // Type compatibility alone cannot guarantee association across branches.
      const metadata = ['finalSource', 'finalStatus', 'finalIndex', 'finalError', 'provisionalSource', 'provisionalStatus', 'provisionalError'];
      if (metadata.some(connected)) {
        const ports = ['text', 'finalSource', 'finalStatus', 'finalIndex', 'finalError'];
        if (['provisionalText', 'provisionalSource', 'provisionalStatus', 'provisionalError'].some(connected)) ports.push('provisionalText', 'provisionalSource', 'provisionalStatus', 'provisionalError');
        const source = incoming.get(JSON.stringify([node.id, 'finalSource']))?.[0];
        for (const port of ports) {
          const route = incoming.get(JSON.stringify([node.id, port]));
          if (!route) errors.push(`Required connection missing: ${node.id}.${port} for correlated display`);
          else if (!translators.includes(nodes.get(source)?.type) || route[0] !== source || route[1] !== (port === 'provisionalText' ? 'provisional' : port)) errors.push(`Correlated display ${node.id}.${port} requires matching direct outputs from one translator.`);
        }
      }
    }
    for (const port of Object.keys(definition.inputs)) if (!definition.optionalInputs?.includes(port) && !incoming.has(JSON.stringify([node.id, port]))) errors.push(`Required connection missing: ${node.id}.${port}`);
    if (Object.keys(definition.outputs).length && !outgoing.has(node.id)) errors.push(`Unconnected output Node: ${node.id}`);
  }
  if (!graph.nodes.some(n => definitionOf(n?.type) && !Object.keys(definitionOf(n.type).outputs).length)) errors.push('At least one output destination is required.');
  return [...new Set(errors)];
}
// Rewrite every legacy route explicitly; malformed or ambiguous routes require visible recovery.
export function migrateGraph(graph) {
  if (!record(graph) || ![1, 2, 3, 4].includes(graph.version)) return graph;
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return graph;
  const next = structuredClone(graph);
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
  next.version = GRAPH_VERSION;
  return next;
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
    : graph.nodes.find(node => node.type === 'TranscriptView')?.settings.direction || 'ja-en' };
}
export function withTranslation(graph, { enabled, direction }) {
  const next = assertGraph(graph);
  const current = next.nodes.find(n => translators.includes(n.type));
  for (const view of next.nodes.filter(n => n.type === 'TranscriptView')) view.settings.direction = direction;
  if (enabled && current) current.type = direction === 'en-ja' ? 'OpusMtEnJa' : 'OpusMtJaEn';
  else if (enabled) {
    const branch = defaultGraph({ direction });
    // Choose unused IDs when the user's graph uses the default names elsewhere.
    const ids = new Set(next.nodes.map(n => n.id));
    const unused = base => { let id = base; while (ids.has(id)) id += '-new'; ids.add(id); return id; };
    const id = unused('translation'), sink = unused('translated'), speech = next.nodes.find(n => n.type === 'SpeechToText').id;
    next.nodes.push({ ...branch.nodes[3], id }, { ...branch.nodes[4], id: sink });
    for (const port of ['provisional', 'final']) next.edges.push(edge(speech, port, id, port === 'final' ? 'text' : port));
    next.edges.push(...translationViewEdges(id, sink));
  } else {
    const removed = new Set(next.nodes.filter(n => translators.includes(n.type) || n.type === 'TranslationView').map(n => n.id));
    // Remove downstream audio branch too when its only source is translation.
    let changed = true;
    while (changed) {
      changed = false;
      for (const connection of next.edges) if (removed.has(connection.from[0]) && !removed.has(connection.to[0])) { removed.add(connection.to[0]); changed = true; }
    }
    next.nodes = next.nodes.filter(n => !removed.has(n.id)); next.edges = next.edges.filter(e => !removed.has(e.from[0]) && !removed.has(e.to[0]));
  }
  return assertGraph(next);
}
export function readGraph(storage) {
  const saved = storage.getItem(GRAPH_KEY);
  if (saved !== null) {
    const parsed = JSON.parse(saved), graph = assertGraph(parsed);
    if (parsed.version !== GRAPH_VERSION) saveGraph(storage, graph);
    return graph;
  }
  let legacy;
  try { legacy = JSON.parse(storage.getItem('opus-mt-translation-preferences')); } catch { /* migrate corrupt preferences to defaults */ }
  const graph = defaultGraph({ enabled: typeof legacy?.enabled === 'boolean' ? legacy.enabled : true, direction: legacy?.direction });
  saveGraph(storage, graph);
  return graph;
}
export function saveGraph(storage, graph) {
  const validated = assertGraph(graph);
  storage.setItem(GRAPH_KEY, JSON.stringify(validated));
  storage.removeItem('opus-mt-translation-preferences');
  return validated;
}
