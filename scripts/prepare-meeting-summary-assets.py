#!/usr/bin/env python3
"""Package an isolated, integrity-pinned browser runtime. No model downloads."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [
    ('transformers', 'https://registry.npmjs.org/@huggingface/transformers/-/transformers-4.2.0.tgz',
     '0874b37bbeed0441d37e4445f8a543ab37b41c2ba6bb89f37c5474074b34deee',
     {'dist/transformers.min.js': 'transformers.js', 'LICENSE': 'transformers-LICENSE'}),
    ('ort', 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.26.0-dev.20260416-b7804b056c.tgz',
     '8e0d8aae2e88303912e6b51b2b76d71c790821849ad0438d09d5cd3e72dd870e',
     {'dist/ort-wasm-simd-threaded.asyncify.mjs': 'ort-wasm-simd-threaded.asyncify.mjs',
      'dist/ort-wasm-simd-threaded.asyncify.wasm': 'ort-wasm-simd-threaded.asyncify.wasm'}),
]


def main():
    target = ROOT / 'web/vendor/meeting-summary'
    specification = json.loads((ROOT / 'scripts/meeting-summary-runtime.json').read_text())
    staged = {}
    for name, url, digest, members in PACKAGES:
        archive = ROOT / '.cache/meeting-summary' / (name + '.tgz')
        archive.parent.mkdir(parents=True, exist_ok=True)
        data = archive.read_bytes() if archive.exists() else urllib.request.urlopen(url, timeout=180).read()
        if hashlib.sha256(data).hexdigest() != digest:
            raise RuntimeError('Meeting summary runtime archive checksum mismatch: ' + name)
        archive.write_bytes(data)
        with tarfile.open(fileobj=io.BytesIO(data)) as package:
            for source, destination in members.items():
                content = package.extractfile('package/' + source).read()
                pin = next(f for f in specification['files'] if f['path'] == destination)
                if len(content) != pin['bytes'] or hashlib.sha256(content).hexdigest() != pin['sha256']:
                    raise RuntimeError('Meeting summary runtime member checksum mismatch: ' + destination)
                staged[destination] = content
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for destination, content in staged.items():
        (target / destination).write_bytes(content)
    print('Staged isolated Transformers.js 4.2.0 / ORT 1.26 development WebGPU runtime.')


if __name__ == '__main__':
    main()
