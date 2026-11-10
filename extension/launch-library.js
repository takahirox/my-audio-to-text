import { GraphLibrary, openLibrary, readLibrary, readSelectedGraph, usable, legacyChanged } from './graph-library.js';
import { webVoiceError } from './web-voice-graph.js';

// Executed in the existing offscreen DOM host: localStorage remains the single
// source of truth and all default changes use the library's existing Web Lock.
export async function launchLibrary(storage, operation = 'live-list', id, locks = globalThis.navigator?.locks) {
  await openLibrary(storage, locks);
  let library = readLibrary(storage);
  if (legacyChanged(storage, library)) throw Error('Recover the changed legacy graph in Graph Library first.');
  const web = operation.startsWith('web-'), target = web ? 'webVoice' : 'live';
  const viable = entry => web ? !webVoiceError(entry.graph) : usable(entry);
  if (operation.endsWith('-default')) {
    library = await new GraphLibrary(storage, locks).change(current => {
      const entry = current.graphs.find(entry => entry.id === id);
      if (!entry || !viable(entry)) throw Error('Graph is missing or cannot run here. Choose another saved graph.');
      current.assignments[target] = id;
    });
  }
  if (operation === 'live-check') return readSelectedGraph(storage, id).id;
  let entries = library.graphs.filter(viable);
  let defaultId = entries.some(entry => entry.id === library.assignments[target]) ? library.assignments[target] : null;
  if (!web && !defaultId && entries.length === 1) {
    // Recheck inside the lock so a concurrent explicit default always wins.
    library = await new GraphLibrary(storage, locks).change(current => {
      const choices = current.graphs.filter(usable);
      if (!choices.some(entry => entry.id === current.assignments.live) && choices.length === 1) current.assignments.live = choices[0].id;
    });
    entries = library.graphs.filter(viable);
    defaultId = entries.some(entry => entry.id === library.assignments.live) ? library.assignments.live : null;
  }
  return { graphs: entries.map(({ id, name }) => ({ id, name })), defaultId };
}
