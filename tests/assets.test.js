import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('asset preparation replaces obsolete generated bundles and stages only baseline runtime files', () => {
  // Use a tiny local archive to exercise staging and checksums without downloads.
  const result = spawnSync('python3', ['-c', `
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location('prepare_assets', 'scripts/prepare-assets.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
with tempfile.TemporaryDirectory() as temporary:
    prepare.ROOT = root = Path(temporary)
    cache = root / '.cache'
    cache.mkdir()
    vendor = root / 'web' / 'vendor'
    obsolete = vendor / 'obsolete-experiment'
    obsolete.mkdir(parents=True)
    (obsolete / 'model.data').write_bytes(b'obsolete')
    (vendor / 'manifest.json').write_text('obsolete')
    names = {'sherpa-onnx-asr.js', 'sherpa-onnx-vad.js', 'sherpa-onnx-wasm-main-vad-asr.js',
             'sherpa-onnx-wasm-main-vad-asr.wasm', 'sherpa-onnx-wasm-main-vad-asr.data'}
    archive = cache / 'runtime.tar.bz2'
    with tarfile.open(archive, 'w:bz2') as package:
        for name in names | {'unused.html', 'unused.wav'}:
            content = b'baseline'
            entry = tarfile.TarInfo('upstream/' + name)
            entry.size = len(content)
            package.addfile(entry, io.BytesIO(content))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    prepare.ARCHIVE = archive.name
    prepare.URL = 'https://example.invalid/runtime'
    prepare.SHA256 = digest
    prepare.main()
    assert {p.name for p in vendor.iterdir()} == {'sherpa', 'manifest.json'}
    assert {p.name for p in (vendor / 'sherpa').iterdir()} == names
    assert (vendor / 'sherpa' / 'sherpa-onnx-vad.js').read_bytes() == b'(function () {\\nbaseline\\nself.createVad = createVad;\\n})();\\n'
    manifest = json.loads((vendor / 'manifest.json').read_text())
    assert set(manifest) == {'sherpa'}
    assert manifest['sherpa']['sha256'] == digest
    assert manifest['sherpa']['bytes'] == sum(p.stat().st_size for p in (vendor / 'sherpa').iterdir())
    # A failed verification must preserve the previously prepared assets.
    archive.write_bytes(b'corrupt')
    try:
        prepare.main()
    except RuntimeError as error:
        assert 'Checksum mismatch' in str(error)
    else:
        raise AssertionError('Corrupt archive accepted')
    assert (vendor / 'sherpa' / 'sherpa-onnx-asr.js').read_bytes() == b'baseline'
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
