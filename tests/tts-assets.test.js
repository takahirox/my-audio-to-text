import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('TTS staging checks hashes before writing, extracts only allowlisted members and stays outside extension vendor', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, io, tarfile, hashlib
spec = importlib.util.spec_from_file_location('tts', 'scripts/prepare-tts-assets.py')
tts = importlib.util.module_from_spec(spec); spec.loader.exec_module(tts)
assert all(len(digest) == 64 for _, _, digest, _ in tts.PACKAGES)
assert all('/tts-assets/' not in url for _, url, _, _ in tts.PACKAGES)
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
    for name in ['package/dist/model.js', 'package/../../unrelated']:
        entry = tarfile.TarInfo(name); entry.size = 3; archive.addfile(entry, io.BytesIO(b'abc'))
data = buffer.getvalue()
assert tts.stage(data, hashlib.sha256(data).hexdigest(), {'dist/model.js': 'model.js'}) == {'model.js': b'abc'}
try:
    tts.stage(data, '0' * 64, {})
except RuntimeError:
    pass
else:
    raise AssertionError('checksum not verified')
assert "ROOT / 'web' / 'tts-assets'" in open('scripts/prepare-tts-assets.py').read()
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
