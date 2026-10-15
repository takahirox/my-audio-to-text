import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('English online assets verify caches/downloads and repack only selected weights before replacing bundle', () => {
  const result = spawnSync('python3', ['-c', `
import hashlib, importlib.util, json, io, tarfile, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('zipformer', 'scripts/prepare-zipformer-assets.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
    m.ROOT = root = Path(d)
    (root / 'scripts').mkdir()
    cache = root / '.cache'
    cache.mkdir()
    contents = {name: b'runtime' for name in m.RUNTIME_FILES}
    contents[m.STEM + '.js'] = b'before;loadPackage({files:[{filename:"/old.onnx",start:0,end:3}],remote_package_size:3});after;'
    archive = cache / 'zipformer-runtime.tar.bz2'
    with tarfile.open(archive, 'w:bz2') as p:
        for name, content in {**contents, m.STEM + '.data': b'OLD'}.items():
            entry = tarfile.TarInfo('upstream/' + name); entry.size = len(content)
            p.addfile(entry, io.BytesIO(content))
    files = []
    for name in [*m.MODELS, 'README.md', 'test_wavs/0.wav']:
        content = name.encode()
        target = cache / 'zipformer-en' / name
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(content)
        files.append(dict(path=name, bytes=len(content), sha256=hashlib.sha256(content).hexdigest()))
    spec = dict(source='https://fixture.invalid', revision='pin', runtime=dict(url='https://fixture.invalid/archive', sha256=hashlib.sha256(archive.read_bytes()).hexdigest()), files=files)
    prepared = m.prepare_bundle(contents, {virtual: name.encode() for name, virtual in m.MODELS.items()})
    prepared['model-README.md'] = b'README.md'
    spec['bundle'] = [dict(path=name, bytes=len(content), sha256=hashlib.sha256(content).hexdigest()) for name, content in prepared.items()]
    (root / 'scripts/zipformer-assets.json').write_text(json.dumps(spec))
    other = root / 'web/vendor/sherpa-ja-en/weights'
    other.parent.mkdir(parents=True); other.write_bytes(b'untouched')
    m.main()
    bundle = root / 'web/vendor/zipformer-en'
    script = (bundle / (m.STEM + '.js')).read_text()
    table = json.loads(script[len('before;loadPackage('):-len(');after;')])
    data = (bundle / (m.STEM + '.data')).read_bytes()
    for entry in table['files']:
        original = next(name for name, virtual in m.MODELS.items() if virtual == entry['filename'])
        assert data[entry['start']:entry['end']] == original.encode()
    assert b'OLD' not in data and 'old.onnx' not in script
    assert not (bundle / 'test_wavs').exists()
    manifest = json.loads((bundle / 'manifest.json').read_text())
    assert manifest['specification'] == spec
    assert other.read_bytes() == b'untouched'
    snapshot = {p.name: p.read_bytes() for p in bundle.iterdir()}
    cached = cache / 'zipformer-en' / files[0]['path']
    cached.write_bytes(b'corrupt')
    try:
        m.main(); raise AssertionError('Corrupt cache accepted')
    except RuntimeError as error:
        assert 'Checksum mismatch' in str(error)
    cached.unlink()
    class Response:
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def read(self): return b'changed upstream'
    m.urllib.request.urlopen = lambda *args, **kwargs: Response()
    try:
        m.main(); raise AssertionError('Corrupt download accepted')
    except RuntimeError as error:
        assert 'Checksum mismatch' in str(error)
    assert not cached.exists()
    assert {p.name: p.read_bytes() for p in bundle.iterdir()} == snapshot
    try:
        m.prepare_bundle({**contents, m.STEM + '.js': b'changed table'}, {})
        raise AssertionError('Changed loader accepted')
    except RuntimeError:
        pass
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
