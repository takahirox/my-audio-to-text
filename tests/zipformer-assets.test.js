import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('runtime reproduction rejects changed preload tables and removes the entire model invocation', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util
spec = importlib.util.spec_from_file_location('review', 'scripts/review-sherpa-runtime.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = 'before;loadPackage({files:[{filename:"/model.onnx",start:0,end:90}],remote_package_size:90});after;'
r = m.strip_preload(s)
assert 'loadPackage(' not in r and 'model.onnx' not in r
assert r.startswith('before;') and r.endswith(';after;')
for changed in ['no table', s+s]:
    try:
        m.strip_preload(changed); raise AssertionError('changed runtime accepted')
    except RuntimeError:
        pass
`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
