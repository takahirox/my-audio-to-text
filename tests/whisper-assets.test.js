import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { WHISPER_MODEL } from '../web/whisper-config.js';
import { readFileSync } from 'node:fs';

test('Whisper preparation verifies every cached/downloaded asset before replacing a bundle and preserves other models', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, json, hashlib, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('whisper', 'scripts/prepare-whisper-assets.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    module.ROOT = root
    (root / 'scripts').mkdir()
    content = b'pinned Whisper test asset'
    entry = {'path': 'onnx/model.onnx', 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    (root / 'scripts/whisper-assets.json').write_text(json.dumps({'source': 'https://fixture.invalid', 'revision': 'pinned', 'files': [entry]}))
    existing = root / 'web/vendor/whisper/tiny/previous'
    existing.parent.mkdir(parents=True)
    existing.write_bytes(b'previous bundle')
    other = root / 'web/vendor/sherpa-ja-en/model'
    other.parent.mkdir()
    other.write_bytes(b'ReazonSpeech')
    cached = root / '.cache/whisper/pinned/onnx/model.onnx'
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b'corrupt')
    try:
        module.main()
        raise AssertionError('Corrupt cache accepted')
    except RuntimeError as error:
        assert 'Checksum mismatch' in str(error)
    assert existing.read_bytes() == b'previous bundle'
    cached.unlink()
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return b'changed upstream'
    module.urllib.request.urlopen = lambda *args, **kwargs: Response()
    try:
        module.main()
        raise AssertionError('Corrupt download accepted')
    except RuntimeError as error:
        assert 'Checksum mismatch' in str(error)
    assert not cached.exists()
    cached.write_bytes(content)
    module.main()
    assert (root / 'web/vendor/whisper/tiny/onnx/model.onnx').read_bytes() == content
    assert not existing.exists()
    assert other.read_bytes() == b'ReazonSpeech'
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('packaged Whisper pins match model configuration and include actual q8 encoder/decoder, tokenizer and processor', () => {
  const spec = JSON.parse(readFileSync('scripts/whisper-assets.json'));
  assert.equal(spec.revision, WHISPER_MODEL.revision);
  assert.equal(spec.source, `https://huggingface.co/${WHISPER_MODEL.source}`);
  for (const name of ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx', 'tokenizer.json', 'generation_config.json', 'preprocessor_config.json']) {
    const file = spec.files.find(f => f.path === name); assert.ok(file); assert.match(file.sha256, /^[a-f0-9]{64}$/); assert.ok(file.bytes > 0);
  }
});
