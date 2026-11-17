import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';

// Static bytes only: no inference server. Production cache hashes and canonical
// cache keys remain intact, allowing both smoke suites to reuse one WAN download.
export async function servePlamoSmokeWeight(weight) {
  const { size } = await stat(weight);
  const server = createServer((request, response) => {
    if (request.url !== '/weights.gguf') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Length': String(size), 'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin', 'Content-Type': 'application/octet-stream' });
    createReadStream(weight).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/weights.gguf`,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
