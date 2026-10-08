import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('translation runtime preparation verifies archives before staging and preserves speech assets', () => {
  const result = spawnSync('python3', ['-c', `
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
spec = importlib.util.spec_from_file_location('translation_assets', 'scripts/prepare-translation-assets.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
assert all(len(package[2]) == 64 for package in prepare.PACKAGES)
assert '4.0.0-next.3' in prepare.PACKAGES[0][1]
assert '1.25.0-dev.20260212-1a71a5f46e' in prepare.PACKAGES[1][1]
with tempfile.TemporaryDirectory() as temporary:
    prepare.ROOT = root = Path(temporary)
    cache = root / '.cache'
    cache.mkdir()
    speech = root / 'web' / 'vendor' / 'sherpa-ja-en' / 'model.data'
    speech.parent.mkdir(parents=True)
    speech.write_bytes(b'unchanged speech')
    packages = []
    expected = {}
    for name, url, digest, members in prepare.PACKAGES:
        content = io.BytesIO()
        with tarfile.open(fileobj=content, mode='w:gz') as archive:
            for source, target in members.items():
                data = target.encode()
                expected[target] = data
                entry = tarfile.TarInfo('package/' + source)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        data = content.getvalue()
        (cache / f'translation-{name}.tgz').write_bytes(data)
        packages.append((name, url, hashlib.sha256(data).hexdigest(), members))
    prepare.PACKAGES = packages
    obsolete = root / 'web' / 'vendor' / 'translation' / 'obsolete.wasm'
    obsolete.parent.mkdir(parents=True)
    obsolete.write_bytes(b'obsolete')
    prepare.main()
    target = root / 'web' / 'vendor' / 'translation'
    assert {p.name: p.read_bytes() for p in target.iterdir()} == expected
    assert speech.read_bytes() == b'unchanged speech'
    (cache / 'translation-onnxruntime-web.tgz').write_bytes(b'corrupt')
    try:
        prepare.main()
    except RuntimeError as error:
        assert 'Checksum mismatch' in str(error)
    else:
        raise AssertionError('corrupt archive accepted')
    assert {p.name: p.read_bytes() for p in target.iterdir()} == expected
    assert speech.read_bytes() == b'unchanged speech'
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
