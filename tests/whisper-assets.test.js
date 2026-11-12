import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { WHISPER_MODEL } from '../web/whisper-config.js';
import { readFileSync } from 'node:fs';

test('Whisper setup never downloads or requires weights', () => {
  const result = spawnSync('python3', ['scripts/prepare-whisper-assets.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /on demand/);
});

test('Whisper cache pins match model configuration and include actual q8 encoder/decoder, tokenizer and processor', () => {
  const spec = JSON.parse(readFileSync('scripts/whisper-assets.json'));
  assert.equal(spec.revision, WHISPER_MODEL.revision);
  assert.equal(spec.source, `https://huggingface.co/${WHISPER_MODEL.source}`);
  for (const name of ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx', 'tokenizer.json', 'generation_config.json', 'preprocessor_config.json']) {
    const file = spec.files.find(f => f.path === name); assert.ok(file); assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(file.bytes > 0);
  }
});

test('download manifests preserve every existing ASR checkpoint and model file', () => {
  for (const [name, specName, key] of [['reazon', 'reazon-ja-en', 'models'], ['whisper', 'whisper', 'files'], ['zipformer', 'zipformer', 'files']]) {
    const original = JSON.parse(readFileSync(`scripts/${specName}-assets.json`));
    const cached = JSON.parse(readFileSync(`extension/${name}-assets.json`));
    assert.equal(cached.revision, original.revision);
    assert.equal(`https://huggingface.co/${cached.id}`, original.source);
    for (const file of cached.files) {
      const pinned = original[key].find(f => f.path === file.path);
      assert.ok(pinned);
      if (pinned.bytes) assert.equal(file.bytes, pinned.bytes);
      if (file.bytes <= 1048576) assert.deepEqual(file.sha256Chunks, [pinned.sha256]);
      assert.equal(file.sha256Chunks.length, Math.ceil(file.bytes / 1048576));
    }
  }
});
