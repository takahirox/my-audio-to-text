import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('asset preparation stages only pinned ja-en models and Silero, removing obsolete bundles', () => {
  // Exercise repackaging and verification offline with a tiny bootstrap archive.
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
specification = json.loads((prepare.ROOT / 'scripts' / 'reazon-ja-en-assets.json').read_text())
assert 'ja-zipformer_reazonspeech' not in prepare.URL
assert specification['revision'] == '12b44671ff48b9aed622551d64e02fea9a2cf870'
with tempfile.TemporaryDirectory() as temporary:
    prepare.ROOT = root = Path(temporary)
    cache = root / '.cache'
    cache.mkdir()
    vendor = root / 'web' / 'vendor'
    for name in ['sherpa', 'obsolete-experiment']:
        obsolete = vendor / name
        obsolete.mkdir(parents=True)
        (obsolete / 'model.data').write_bytes(b'Japanese-only weights')
    (vendor / 'manifest.json').write_text('obsolete')
    models = {}
    for entry in specification['models']:
        content = entry['path'].encode()
        entry['sha256'] = hashlib.sha256(content).hexdigest()
        target = cache / 'reazon-ja-en' / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        models[entry['virtualPath']] = content
    (root / 'scripts').mkdir()
    (root / 'scripts' / 'reazon-ja-en-assets.json').write_text(json.dumps(specification))
    stem = prepare.STEM
    loader = b'runtime;loadPackage({files:[{filename:"/bootstrap.onnx",start:0,end:3},{filename:"/silero_vad.onnx",start:3,end:9},{filename:"/tokens.txt",start:9,end:12}],remote_package_size:12});runtime;'
    contents = {name: b'runtime' for name in prepare.RUNTIME_FILES}
    contents[stem + '.js'] = loader
    contents[stem + '.data'] = b'oldSILEROold'
    archive = cache / prepare.ARCHIVE
    with tarfile.open(archive, 'w:bz2') as package:
        for name, content in {**contents, 'unused.wav': b'unused'}.items():
            entry = tarfile.TarInfo('upstream/' + name)
            entry.size = len(content)
            package.addfile(entry, io.BytesIO(content))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    prepare.SHA256 = digest
    prepare.main()
    assert {p.name for p in vendor.iterdir()} == {'sherpa-ja-en', 'manifest.json'}
    bundle = vendor / 'sherpa-ja-en'
    assert {p.name for p in bundle.iterdir()} == prepare.RUNTIME_FILES
    assert (bundle / 'sherpa-onnx-vad.js').read_bytes() == b'(function () {\\nruntime\\nself.createVad = createVad;\\n})();\\n'
    script = (bundle / (stem + '.js')).read_text()
    table = json.loads(script[len('runtime;loadPackage('):-len(');runtime;')])
    data = (bundle / (stem + '.data')).read_bytes()
    assert table['remote_package_size'] == len(data)
    assert {e['filename'] for e in table['files']} == set(models) | {'/silero_vad.onnx'}
    for entry in table['files']:
        assert data[entry['start']:entry['end']] == (b'SILERO' if entry['filename'] == '/silero_vad.onnx' else models[entry['filename']])
    assert '/bootstrap.onnx' not in script and b'old' not in data
    manifest = json.loads((vendor / 'manifest.json').read_text())
    assert set(manifest) == {'sherpa-ja-en'}
    assert manifest['sherpa-ja-en']['sha256'] == hashlib.sha256(data).hexdigest()
    assert manifest['sherpa-ja-en']['runtime']['sha256'] == digest
    assert manifest['sherpa-ja-en']['models'] == specification['models']
    assert manifest['sherpa-ja-en']['bytes'] == sum(p.stat().st_size for p in bundle.iterdir())
    snapshot = {p.name: p.read_bytes() for p in bundle.iterdir()}
    def expect_failure(operation, message):
        try:
            operation()
        except RuntimeError as error:
            assert message in str(error)
        else:
            raise AssertionError('Invalid input accepted')
        assert {p.name: p.read_bytes() for p in bundle.iterdir()} == snapshot
    # Verification failures preserve the prepared bundle.
    model = cache / 'reazon-ja-en' / specification['models'][0]['path']
    model.write_bytes(b'corrupt')
    expect_failure(prepare.main, 'Checksum mismatch')
    model.write_bytes(models[specification['models'][0]['virtualPath']])
    expect_failure(lambda: prepare.prepare_bundle({**contents, stem + '.js': b'bad table'}, models), 'preload table')
    expect_failure(lambda: prepare.prepare_bundle({**contents, stem + '.data': b'bad'}, models), 'Silero preload entry')
    archive.write_bytes(b'corrupt')
    expect_failure(prepare.main, 'Checksum mismatch')
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
