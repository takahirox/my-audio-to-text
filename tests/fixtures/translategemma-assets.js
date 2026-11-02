import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { TRANSLATE_GEMMA } from '../../web/translation-models.js';

// Optional loopback transport for the exact pinned assets, not a model mock.
// Stream large weights instead of copying them into a route.fulfill buffer.
export async function translateGemmaAssetMirror(inference = true) {
  if (!process.env.TRANSLATEGEMMA_ASSET_DIR) return null;
  const root = path.resolve(process.env.TRANSLATEGEMMA_ASSET_DIR);
  const manifest = JSON.parse(await readFile('extension/translategemma-assets.json', 'utf8'));
  const files = new Map();
  for (const entry of manifest.filter(f => inference || !f.path.startsWith('onnx/'))) {
    const file = path.join(root, entry.path), digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(file)) { digest.update(chunk); bytes += chunk.length; }
    assert.equal(bytes, entry.bytes, entry.path);
    assert.equal(digest.digest('hex'), entry.sha256, entry.path);
    files.set(`/${TRANSLATE_GEMMA.id}/resolve/${TRANSLATE_GEMMA.revision}/${entry.path}`, { file, bytes });
  }
  const server = createServer((req, res) => {
    const entry = files.get(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!entry) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Length': entry.bytes });
    createReadStream(entry.file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(resolve => server.close(resolve)) };
}
