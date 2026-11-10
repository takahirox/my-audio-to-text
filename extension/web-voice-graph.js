import { assertGraph, executableGraph, ASR_TYPES } from './graph.js';

// Run only the assigned field sink and its complete ancestors. Optional Live,
// speaker and other output branches never run in the page-mic workflow.
export function webVoiceGraph(value) {
  const graph = executableGraph(assertGraph(value));
  if (graph.nodes.some(n => ['ChromeTabAudio', 'SelectedPageMediaAudio'].includes(n.type))) throw Error('Web voice typing cannot run tab or selected-media capture. Use a microphone-only graph.');
  const sinks = graph.nodes.filter(n => n.type === 'FocusedInputTextOutputNode');
  if (sinks.length !== 1) throw Error('Connect one executable MicrophoneAudio → ASR final → FocusedInputTextOutputNode path in Graph Editor.');
  const needed = new Set(), pending = [sinks[0].id];
  while (pending.length) {
    const id = pending.pop();
    if (needed.has(id)) continue;
    needed.add(id);
    for (const e of graph.edges) if (e.to[0] === id) pending.push(e.from[0]);
  }
  const nodes = graph.nodes.filter(n => needed.has(n.id)), edges = graph.edges.filter(e => needed.has(e.from[0]) && needed.has(e.to[0]));
  const allowed = new Set(['MicrophoneAudio', ...ASR_TYPES, 'FocusedInputTextOutputNode', 'TextFormatter', 'TextWindow',
    'OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'IfCondition', 'TextSummaryLfm2', 'TextSummaryQwen35', 'Text', 'Number']);
  const unsupported = nodes.find(n => !allowed.has(n.type));
  if (unsupported) throw Error(`${unsupported.id}: ${unsupported.type} is not supported on a Web voice output path. Use final text processors; cumulative snapshots, triggers and side effects are not dictation segments.`);
  if (edges.some(e => /^(provisional|error)/i.test(e.from[1]))) throw Error('Web voice typing inserts committed text only. Disconnect provisional and diagnostic outputs from the field path.');
  // A Text source can configure language/context, but must not emit a startup edit via
  // a formatter or translation. Number configuration remains unrestricted.
  if (nodes.some(n => n.type === 'Text' && edges.some(e => e.from[0] === n.id && !['language', 'context'].includes(e.to[1])))) throw Error('Use Text constants only for ASR language or translation context configuration on a Web voice path; startup text would edit the field before speech.');
  const reachable = new Set(nodes.filter(n => n.type === 'MicrophoneAudio').map(n => n.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of edges) if (reachable.has(e.from[0]) && !reachable.has(e.to[0])) { reachable.add(e.to[0]); changed = true; }
  }
  if (!reachable.has(sinks[0].id)) throw Error('The field output needs a complete typed path from MicrophoneAudio. No Live graph is substituted.');
  return { ...graph, nodes, edges };
}
export function webVoiceError(value) { try { webVoiceGraph(value); return ''; } catch (error) { return error.message; } }

// Keep selection and execution on precisely the same validation boundary.
export function webVoiceChoices(library) {
  return library.graphs.flatMap(entry => {
    try { return [{ id: entry.id, name: entry.name, graph: webVoiceGraph(entry.graph) }]; }
    catch { return []; }
  });
}
export function webVoiceDefault(choices, saved, legacy) {
  const id = saved === undefined ? legacy : saved;
  return choices.some(choice => choice.id === id) ? id : choices.length === 1 ? choices[0].id : null;
}
