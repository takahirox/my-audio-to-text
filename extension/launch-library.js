import { GraphLibrary, openLibrary, readLibrary, readSelectedGraph, usable, legacyChanged } from './graph-library.js';
import { webVoiceChoices } from './web-voice-graph.js';

// Executed in the existing offscreen DOM host: localStorage remains the single
// source of truth and all default changes use the library's existing Web Lock.
export async function launchLibrary(storage, operation = 'live-list', id, locks = globalThis.navigator?.locks) {
  await openLibrary(storage, locks);
  let library = readLibrary(storage);
  if (legacyChanged(storage, library)) throw Error('Recover the changed legacy graph in Graph Library first.');
  const web = operation.startsWith('web-'), target = web ? 'webVoice' : 'live';
  const choices = current => web ? webVoiceChoices(current) : current.graphs.filter(entry => usable(entry, current));
  if (operation.endsWith('-default')) {
    library = await new GraphLibrary(storage, locks).change(current => {
      const entry = choices(current).find(entry => entry.id === id);
      if (!entry) throw Error('Graph is missing or cannot run here. Choose another saved graph.');
      current.assignments[target] = id;
    });
  }
  if (operation === 'live-check') return readSelectedGraph(storage, id).id;
  let entries = choices(library);
  let defaultId = entries.some(entry => entry.id === library.assignments[target]) ? library.assignments[target] : null;
  if (!web && !defaultId && entries.length === 1) {
    // Recheck inside the lock so a concurrent explicit default always wins.
    library = await new GraphLibrary(storage, locks).change(current => {
      const entries = choices(current);
      if (!entries.some(entry => entry.id === current.assignments.live) && entries.length === 1) current.assignments.live = entries[0].id;
    });
    entries = choices(library);
    defaultId = entries.some(entry => entry.id === library.assignments.live) ? library.assignments.live : null;
  }
  return { graphs: entries.map(({ id, name }) => ({ id, name })), defaultId };
}
