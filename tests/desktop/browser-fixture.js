import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';

export async function browserFixture(t) {
  const page = await readFile('tests/desktop/browser-target.html');
  let state, selection;
  const server = createServer(async (request, response) => {
    if (request.url === '/state' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const update = JSON.parse(body);
      if (update.report > (state?.report ?? 0)) state = update;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(selection ?? null));
    } else response.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    state: () => state,
    select(target, caret) {
      selection = { target, caret, serial: (selection?.serial ?? 0) + 1 };
      return selection.serial;
    },
  };
}
