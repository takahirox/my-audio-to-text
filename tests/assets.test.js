import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('weight-free sherpa staging needs no network, model files or cache; invalid packages preserve staged runtimes', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, shutil, tarfile, hashlib
spec = importlib.util.spec_from_file_location('runtime', 'scripts/sherpa-runtime.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
original = pathlib.Path.cwd()
with tempfile.TemporaryDirectory() as d:
    root = pathlib.Path(d); (root / 'scripts').mkdir()
    shutil.copy2('scripts/sherpa-runtime.tar.gz', root / 'scripts/sherpa-runtime.tar.gz')
    for family, names in m.FAMILIES.items():
        target = root / 'web/vendor' / family
        target.mkdir(parents=True); (target / 'old.data').write_bytes(b'old weights')
        m.stage(root, family)
        assert {p.name for p in target.iterdir()} == names
        for p in target.glob('*.js'):
            assert b'loadPackage({files:[' not in p.read_bytes()
    assert not (root / '.cache').exists()
    target = root / 'web/vendor/sherpa-ja-en'
    snapshot = {p.name:p.read_bytes() for p in target.iterdir()}
    (root / 'scripts/sherpa-runtime.tar.gz').write_bytes(b'corrupt')
    try:
        m.stage(root, 'sherpa-ja-en'); raise AssertionError('corrupt archive accepted')
    except RuntimeError:
        pass
    assert {p.name:p.read_bytes() for p in target.iterdir()} == snapshot
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
