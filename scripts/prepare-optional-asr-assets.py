#!/usr/bin/env python3
"""Package pinned JS/WASM only. Optional ASR weights are prepared after Save."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / 'scripts/optional-asr-runtime.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    specification = json.loads(SPEC.read_text())
    target = ROOT / 'web/vendor/optional-asr'
    staging = target.with_name('optional-asr-staging')
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    spec = importlib.util.spec_from_file_location('moonshine_csp', ROOT/'scripts/moonshine-csp.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    for file in specification['files']:
        source = ROOT / 'node_modules' / file['source']
        if not source.is_file() or digest(source) != file['sha256']:
            raise SystemExit(f'Invalid optional ASR runtime: {file["source"]}. Run npm ci.')
        content = source.read_bytes()
        if file['path'] == 'parakeet/backend.js':
            content = content.replace(b"import('onnxruntime-web')", b"import('../ort/ort.webgpu.min.mjs')")
            # Upstream ignores wasmPaths; eliminate its remote executable fallback.
            content = content.replace(b'`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ver}/dist/`', b"new URL('../ort/', import.meta.url).href")
        elif file['path'] == 'parakeet/parakeet.js':
            # Strict WebGPU also needs sequential ORT backend initialization.
            content = content.replace(b"if (backend === 'webgpu-hybrid') {\r\n      // avoid", b"if (backend.startsWith('webgpu')) {\r\n      // avoid")
        elif file['path'] == 'moonshine/moonshine.mjs':
            content = module.patch(content.decode()).encode()
        output = staging / file['path']
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
        if hashlib.sha256(content).hexdigest() != file['packagedSha256']:
            raise SystemExit(f'Unexpected patched runtime: {file["path"]}')
    (staging/'manifest.json').write_text(json.dumps(specification, indent=2)+'\n')
    if target.exists():
        shutil.rmtree(target)
    staging.rename(target)
    print(f'Staged optional ASR runtimes only: {sum(p.stat().st_size for p in target.rglob("*") if p.is_file()):,} bytes')


if __name__ == '__main__':
    main()
