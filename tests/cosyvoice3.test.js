import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cosyVoice3Mask, streamingCosyVoice3Flow, streamingCosyVoice3Hift } from '../web/cosyvoice3-onnx.js';
import { defineAssetSet } from '../extension/model-asset-cache.js';
import { CosyVoice3Node } from '../web/cosyvoice3-node.js';

test('CosyVoice3 attention uses the trained 50-frame chunks, all left history and bounded prefixes', async () => {
  const mask = cosyVoice3Mask(151);
  for (let r = 0; r < 151; r++) for (let c = 0; c < 151; c++) {
    assert.equal(mask[r * 151 + c], Number(c < Math.min(151, (Math.floor(r / 50) + 1) * 50)));
  }
  for (const size of [0, -1, 1.1, 1219, NaN]) assert.throws(() => cosyVoice3Mask(size), /bounded/);
  assert.equal(cosyVoice3Mask(1218).length, 1218 ** 2);
  await assert.rejects(streamingCosyVoice3Flow(new Uint8Array([1, 2, 3])), /Unreviewed/);
  await assert.rejects(streamingCosyVoice3Hift(new Uint8Array([1, 2, 3])), /Unreviewed/);
});

test('CosyVoice3 preparation pins every component; invalid voices/languages cannot silently select another model', async () => {
  const spec = JSON.parse(await readFile('docs/cosyvoice3-artifacts.json'));
  const manifest = defineAssetSet(JSON.parse(await readFile('extension/cosyvoice3-assets.json')));
  assert.equal(manifest.revision, spec.revision); assert.equal(manifest.id, spec.id);
  assert.equal(manifest.bytes, 916881956); assert.equal(manifest.files.length, 8);
  for (const file of manifest.files) {
    const reviewed = spec.files.find(entry => entry.path === file.path);
    assert.equal(file.bytes, reviewed.bytes); assert.equal(file.url, reviewed.sourceURL);
    assert.match(reviewed.sha256, /^[a-f0-9]{64}$/);
  }
  for (const options of [{ language: 'chinese' }, { voice: 'arbitrary-reference' }]) assert.throws(() => new CosyVoice3Node(options), /Choose/);
});
