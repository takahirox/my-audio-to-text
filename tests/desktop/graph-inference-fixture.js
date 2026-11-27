import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

export async function prepareInferenceFixtures(app, runtime, models) {
  const body = 'deterministic desktop inference fixture';
  const asset = { bytes: Buffer.byteLength(body), sha256Chunks: [createHash('sha256').update(body).digest('hex')] };
  const manifests = models.map(({ manifest }) => `extension/${manifest}-assets.json`);
  const workers = Object.fromEntries(models.map(({ worker, script }) => [`web/${worker}-worker.js`, script]));

  // Supply small, checksum-bearing assets and deterministic Worker scripts
  // through the packaged protocol without modifying the signed app on disk.
  await app.evaluate(({ app, systemPreferences, BrowserWindow }, { asset, manifests, workers }) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const { relative } = process.getBuiltinModule('node:path');
    const { syncBuiltinESMExports } = process.getBuiltinModule('node:module');
    const { readFile } = fs;
    const root = app.getAppPath();
    fs.readFile = async (path, ...options) => {
      if (typeof path !== 'string') return readFile(path, ...options);
      const file = relative(root, path);
      if (Object.hasOwn(workers, file)) return Buffer.from(workers[file]);
      const bytes = await readFile(path, ...options);
      if (!manifests.includes(file)) return bytes;
      const manifest = JSON.parse(bytes);
      for (const entry of Array.isArray(manifest) ? manifest : manifest.files) Object.assign(entry, asset);
      return Buffer.from(JSON.stringify(manifest));
    };
    syncBuiltinESMExports();
    if (process.platform === 'darwin') systemPreferences.getMediaAccessStatus = () => 'granted';
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith('/runtime.html')).webContents.setAudioMuted(true);
    globalThis.fetch = () => { throw Error('Fixture inference must run offline'); };
  }, { asset, manifests, workers });

  const states = await runtime.evaluate(async ({ body, nodes }) => {
    const { ModelAssetCache } = await import('/extension/model-asset-cache.js');
    const { graphModelRequirements } = await import('/extension/graph-model-preparation.js');
    const { Microphone } = await import('/web/audio.js');
    Microphone.prototype.start = function () { this.onAudio(new Float32Array(1600).fill(.25)); };
    const results = {};
    for (const { key, manifest } of graphModelRequirements({ nodes })) {
      const cache = new ModelAssetCache(await manifest(), { fetchAsset: async () => new Response(body), beforeDownload: () => {} });
      const view = await cache.prepare();
      results[key] = view.error || view.state;
    }
    return results;
  }, { body, nodes: models.flatMap(({ graph }) => graph.nodes) });
  assert.deepEqual(states, Object.fromEntries(models.map(({ key }) => [key, 'Ready'])));
}
