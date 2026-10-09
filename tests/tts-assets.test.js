import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { phonemize } from '../scripts/tts-phonemizer/phonemizer.js';

test('source-built English frontend preserves compact IPA and word spaces for Kokoro', async () => {
  assert.deepEqual(await phonemize('Hello. It is a beautiful day today.', 'en-us'),
    ['həlˈoʊ', 'ɪɾ ɪz ɐ bjˈuːɾifəl dˈeɪ tədˈeɪ']);
  await assert.rejects(phonemize('こんにちは。', 'ja'), /Unsupported English/);
});

test('TTS staging checks hashes before writing, extracts only allowlisted members and stays outside extension vendor', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, io, tarfile, hashlib
spec = importlib.util.spec_from_file_location('tts', 'scripts/prepare-tts-assets.py')
tts = importlib.util.module_from_spec(spec); spec.loader.exec_module(tts)
assert all(len(digest) == 64 for _, _, digest, _ in tts.PACKAGES)
assert all('/tts-assets/' not in url for _, url, _, _ in tts.PACKAGES)
assert len(tts.ESPEAK_SOURCE[2]) == len(tts.ESPEAK_ENGINE_SHA256) == 64
assert hashlib.sha256((tts.ROOT / 'scripts' / 'tts-phonemizer' / 'phonemizer-engine.mjs').read_bytes()).hexdigest() == tts.ESPEAK_ENGINE_SHA256
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

test('eSpeak staging includes matching downloadable source/build inputs and rejects changed source or engine', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, io, tarfile, hashlib, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('tts', 'scripts/prepare-tts-assets.py')
tts = importlib.util.module_from_spec(spec); spec.loader.exec_module(tts)
source = b'complete pinned upstream source archive'
with tempfile.TemporaryDirectory() as temp:
    tts.ROOT = Path(temp)
    inputs = tts.ROOT / 'scripts' / 'tts-phonemizer'; inputs.mkdir(parents=True)
    for name in ['README.md', 'Dockerfile', 'build.sh', 'phonemizer.js']:
        (inputs / name).write_bytes(name.encode())
    engine = b'source-built engine'
    (inputs / 'phonemizer-engine.mjs').write_bytes(engine)
    tts.ESPEAK_SOURCE = ('source', 'url', hashlib.sha256(source).hexdigest())
    tts.ESPEAK_ENGINE_SHA256 = hashlib.sha256(engine).hexdigest()
    staged = tts.english_frontend(source)
    assert staged['phonemizer-engine.mjs'] == engine
    assert staged['phonemizer.js'] == b'phonemizer.js'
    with tarfile.open(fileobj=io.BytesIO(staged['phonemizer-source.tar.gz'])) as bundle:
        assert set(bundle.getnames()) == {'espeak-ng.tar.gz', 'README.md', 'Dockerfile', 'build.sh', 'phonemizer.js', 'ENGINE-SHA256.txt'}
        assert bundle.extractfile('espeak-ng.tar.gz').read() == source
        assert bundle.extractfile('ENGINE-SHA256.txt').read().decode().startswith(tts.ESPEAK_ENGINE_SHA256)
        assert bundle.getmember('build.sh').mode == 0o755
    assert staged == tts.english_frontend(source)
    for corrupted in [True, False]:
        if not corrupted:
            (inputs / 'phonemizer-engine.mjs').write_bytes(b'untraceable replacement')
        try:
            tts.english_frontend(source + b'changed' if corrupted else source)
        except RuntimeError:
            pass
        else:
            raise AssertionError('unmatched binary/source accepted')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
