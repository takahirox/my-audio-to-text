import { readFile } from 'node:fs/promises';
import { desktopModels } from '../desktop/models.js';

// Resolve the same manifests the Workers and Models page use. Only the
// checked-in local manifest files are inputs to generation.
const directory = new URL('../extension/', import.meta.url).href;
globalThis.fetch = async input => {
  const url = new URL(input);
  if (!url.href.startsWith(directory) || !/^[\w-]+-assets\.json$/.test(url.href.slice(directory.length))) {
    throw Error('Expected a packaged graph model manifest.');
  }
  return new Response(await readFile(url));
};
const catalogs = {};
for (const model of desktopModels) {
  catalogs[model.key] = Object.fromEntries((await model.manifest()).files.map(file => {
    if (new URL(file.sourceURL).protocol !== 'https:') throw Error('Expected an HTTPS model source.');
    return [file.sourceURL, file.bytes];
  }));
}
console.log(JSON.stringify(catalogs, null, 2));
