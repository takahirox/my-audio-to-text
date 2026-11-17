import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Weight-free, same-origin assets for native capture/UI tests. Real inference
// smokes keep the production manifests and verify the actual model bytes.
export async function writeMoonshineAssetFixture(root, base) {
  for (const name of ['moonshine-small-ja', 'moonshine-medium-en']) {
    const file = path.join(root, 'extension', `${name}-assets.json`);
    const spec = JSON.parse(await readFile(file, 'utf8')), body = Buffer.from('Moonshine model fixture');
    await writeFile(path.join(root, 'extension', `${name}-fixture.bin`), body);
    spec.files = [{ path: 'fixture.bin', bytes: body.length, sha256Chunks: [createHash('sha256').update(body).digest('hex')], sourceURL: `${base}${name}-fixture.bin` }];
    await writeFile(file, JSON.stringify(spec));
  }
}
