import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionFromLogits, IF_CONDITION_MODEL } from '../web/if-condition-model.js';
import { readFile } from 'node:fs/promises';
import { defineAssetSet } from '../extension/model-asset-cache.js';

test('binary score policy accepts confident Yes/No and rejects ties, low confidence and invalid tensors', () => {
  for(const [logits,branch] of [[[5,0],'yes'],[[0,5],'no']]) {
    const result=decisionFromLogits(logits);assert.equal(result.branch,branch);assert.ok(result.confidence>.99);
  }
  for(const logits of [[1,1],[1,1.01],[1,1,1],[NaN,0],[Infinity,0]]) assert.throws(()=>decisionFromLogits(logits));
});
test('IfCondition weights are immutable and bounded; model files cannot include remotely executed code', async () => {
  const files=JSON.parse(await readFile(new URL('../extension/if-condition-assets.json',import.meta.url),'utf8'));
  const manifest=defineAssetSet({...IF_CONDITION_MODEL,files});
  assert.ok(manifest.bytes<14_000_000);assert.ok(manifest.bytes>13_000_000);
  assert.ok(manifest.files.every(f=>/\.(json|onnx|onnx_data)$/.test(f.path)));
});
