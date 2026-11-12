import { GraphLibrary, openLibrary, readLibrary, readSelectedGraph, usable, legacyChanged, compareGraphNames } from './graph-library.js';
import { webVoiceChoices } from './web-voice-graph.js';

// Executed in the existing offscreen DOM host: localStorage remains the single
// source of truth and all selection changes use the library's existing Web Lock.
export async function launchLibrary(storage, operation = 'live-list', id, locks = globalThis.navigator?.locks) {
  await openLibrary(storage, locks);
  let library = readLibrary(storage);
  if (legacyChanged(storage, library)) throw Error('Recover the changed legacy graph in Graph Library first.');
  const web = operation.startsWith('web-'), target = web ? 'webVoice' : 'live';
  if (operation === 'live-check') return readSelectedGraph(storage, id).id;
  const choices = current => web ? webVoiceChoices(current) : current.graphs.filter(entry => usable(entry, current)).sort(compareGraphNames);
  if (operation === 'live-open' || operation.endsWith('-default')) {
    library = await new GraphLibrary(storage, locks).change(current => {
      const entry = choices(current).find(entry => entry.id === id);
      if (!entry) throw Error('Graph is missing or cannot run here. Create or repair it in Graph Library, or choose another saved graph.');
      if (current.assignments[target] === id) return false;
      current.assignments[target] = id;
    });
  } else if (!web) {
    // Select from the latest library inside the lock. A concurrent explicit
    // choice wins over fallback, and ordinary reads never write/notify again.
    library = await new GraphLibrary(storage, locks).change(current => {
      const entries = choices(current);
      if (entries.some(entry => entry.id === current.assignments.live) || !entries.length) return false;
      current.assignments.live = entries[0].id;
    });
  }
  const entries = choices(library);
  const defaultId = entries.some(entry => entry.id === library.assignments[target]) ? library.assignments[target] : null;
  return { graphs: entries.map(({ id, name }) => ({ id, name })), defaultId };
}
