import { assertGraph, executableGraph, ASR_TYPES } from './graph.js';
import { resolveSubgraphs } from './subgraphs.js';

// Run the field and floating displays with their complete ancestors.
export function webVoicePaths(value) {
  const graph = executableGraph(assertGraph(value));
  if (graph.nodes.some(n => n.type === 'ChromeTabAudio')) throw Error('Web voice typing cannot run tab capture. Use a microphone-only graph.');
  const sinks = graph.nodes.filter(n => n.type === 'FocusedInputTextOutputNode');
  if (sinks.length !== 1) throw Error('Connect one executable MicrophoneAudio → ASR final → FocusedInputTextOutputNode path in Graph Editor.');
  const ancestors = (pending, routes = graph.edges) => {
    const needed = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (needed.has(id)) continue;
      needed.add(id);
      for (const e of routes) if (e.to[0] === id) pending.push(e.from[0]);
    }
    return needed;
  };
  const displays = ancestors(graph.nodes.filter(n => n.type === 'FloatingDisplay').map(n => n.id));
  const displayTranslators = new Set(graph.nodes.filter(n => displays.has(n.id) &&
    ['TranslateGemma4B', 'Plamo3Translate2B'].includes(n.type)).map(n => n.id));
  // A shared translator's provisional inputs feed only its preview outputs.
  // Keep those edges for the display while validating the committed field path.
  const fieldRoutes = graph.edges.filter(({ to: [id, port] }) =>
    !(displayTranslators.has(id) && (port === 'provisional' || port === 'provisionalId')));
  const field = ancestors([sinks[0].id], fieldRoutes);
  const nodes = graph.nodes.filter(n => field.has(n.id)), edges = fieldRoutes.filter(e => field.has(e.to[0]));
  const allowed = new Set(['MicrophoneAudio', ...ASR_TYPES, 'FocusedInputTextOutputNode', 'TextFormatter', 'TextWindow',
    'TranslateGemma4B', 'Plamo3Translate2B', 'IfCondition', 'TextProcessingLfm2', 'TextProcessingQwen35', 'Text', 'Number']);
  const unsupported = nodes.find(n => !allowed.has(n.type));
  if (unsupported) throw Error(`${unsupported.id}: ${unsupported.type} is not supported on a Web voice output path. Use final text processors; cumulative snapshots, triggers and side effects are not dictation segments.`);
  if (edges.some(e => /^(provisional|error)/i.test(e.from[1]))) throw Error('Web voice typing inserts committed text only. Disconnect provisional and diagnostic outputs from the field path.');
  // A Text source can configure language/context, but must not emit a startup edit via
  // a formatter or translation. Number configuration remains unrestricted.
  if (nodes.some(n => n.type === 'Text' && edges.some(e => e.from[0] === n.id && !['language', 'context', 'source_lang', 'target_lang'].includes(e.to[1])))) throw Error('Use Text constants only for ASR language or translation context/language configuration on a Web voice path; startup text would edit the field before speech.');
  const reachable = new Set(nodes.filter(n => n.type === 'MicrophoneAudio').map(n => n.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) if (reachable.has(e.from[0]) && !reachable.has(e.to[0])) { reachable.add(e.to[0]); changed = true; }
  }
  if (!reachable.has(sinks[0].id)) throw Error('The field output needs a complete typed path from MicrophoneAudio. No Live graph is substituted.');
  if (graph.nodes.some(n => displays.has(n.id) && n.type === 'Button')) throw Error('Button actions on a Floating Display path require Live.');
  const included = id => field.has(id) || displays.has(id);
  return {
    graph: { ...graph, nodes: graph.nodes.filter(n => included(n.id)), edges: graph.edges.filter(e => included(e.to[0])) },
    fieldNodes: field,
    displayNodes: displays,
  };
}
export function webVoiceGraph(value) { return webVoicePaths(value).graph; }
export function webVoiceError(value) { try { webVoiceGraph(value); return ''; } catch (error) { return error.message; } }

// Keep selection and execution on precisely the same validation boundary.
export function webVoiceChoices(library) {
  return library.graphs.flatMap(entry => {
    if (entry.kind === 'subgraph') return [];
    try { return [{ id: entry.id, name: entry.name, graph: webVoiceGraph(resolveSubgraphs(entry.graph, library.graphs)) }]; }
    catch { return []; }
  });
}
export function webVoiceDefault(choices, saved, legacy) {
  const id = saved === undefined ? legacy : saved;
  return choices.some(choice => choice.id === id) ? id : choices.length === 1 ? choices[0].id : null;
}
