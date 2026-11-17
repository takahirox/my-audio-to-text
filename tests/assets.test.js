import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defineAssetSet } from '../extension/model-asset-cache.js';
test('both Moonshine manifests pin every native artifact without bundling weights', () => {
  for (const key of ['moonshine-medium-en', 'moonshine-small-ja']) {
    const spec = JSON.parse(readFileSync(`extension/${key}-assets.json`));
    assert.doesNotThrow(() => defineAssetSet(spec));
    assert.equal(new Set(spec.files.map(f => f.path)).size, spec.files.length);
    for (const file of spec.files) {
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(file.sha256Chunks.length, Math.ceil(file.bytes / 1048576));
      assert.ok(file.sourceURL.startsWith('https://download.moonshine.ai/model/'));
    }
  }
  const runtime = JSON.parse(readFileSync('scripts/optional-asr-runtime.json'));
  assert.equal(runtime.archive.revision, 'd8d8fa29d05ca67441a7719e70099f9f48917a93');
  assert.ok(runtime.files.every(file => file.path.startsWith('moonshine/')));
});
