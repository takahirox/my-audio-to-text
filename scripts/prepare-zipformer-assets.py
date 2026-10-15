#!/usr/bin/env python3
"""Verify and stage a concrete English online Zipformer + SIMD WASM bundle."""
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STEM = 'sherpa-onnx-wasm-main-asr'
RUNTIME_FILES = {'sherpa-onnx-asr.js', STEM + '.js', STEM + '.wasm'}
MODELS = {'encoder-epoch-99-avg-1.int8.onnx': '/encoder.onnx',
          'decoder-epoch-99-avg-1.onnx': '/decoder.onnx',
          'joiner-epoch-99-avg-1.int8.onnx': '/joiner.onnx', 'tokens.txt': '/tokens.txt'}


def verified(path, url, sha256):
    if not path.exists():
        print(f'Downloading {path.name}', flush=True)
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != sha256:
            raise RuntimeError(f'Checksum mismatch: {url}')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != sha256:
        raise RuntimeError(f'Checksum mismatch: {path}; remove it before retrying')
    return data


def prepare_bundle(runtime, models):
    script = runtime[STEM + '.js'].decode()
    pattern = r'loadPackage\(\{files:\[.*?\],remote_package_size:\d+\}\)'
    matches = list(re.finditer(pattern, script))
    if len(matches) != 1 or set(models) != set(MODELS.values()):
        raise RuntimeError('Unexpected pinned online runtime preload table or models')
    offset, metadata, chunks = 0, [], []
    for name, data in models.items():
        metadata.append({'filename': name, 'start': offset, 'end': offset + len(data)})
        offset += len(data)
        chunks.append(data)
    table = json.dumps({'files': metadata, 'remote_package_size': offset}, separators=(',', ':'))
    script = script[:matches[0].start()] + f'loadPackage({table})' + script[matches[0].end():]
    return {**runtime, STEM + '.js': script.encode(), STEM + '.data': b''.join(chunks)}


def main():
    spec = json.loads((ROOT / 'scripts/zipformer-assets.json').read_text())
    data = verified(ROOT / '.cache/zipformer-runtime.tar.bz2', spec['runtime']['url'], spec['runtime']['sha256'])
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        runtime = {Path(m.name).name: package.extractfile(m).read() for m in package.getmembers()
                   if m.isfile() and Path(m.name).name in RUNTIME_FILES}
    if set(runtime) != RUNTIME_FILES:
        raise RuntimeError('Missing pinned online runtime files')
    models = {}
    for entry in spec['files']:
        content = verified(ROOT / '.cache/zipformer-en' / entry['path'],
                           f"{spec['source']}/resolve/{spec['revision']}/{entry['path']}", entry['sha256'])
        if entry['path'] in MODELS:
            models[MODELS[entry['path']]] = content
    bundle = prepare_bundle(runtime, models)
    bundle['model-README.md'] = (ROOT / '.cache/zipformer-en/README.md').read_bytes()
    files = [dict(path=name, bytes=len(content), sha256=hashlib.sha256(content).hexdigest()) for name, content in bundle.items()]
    if files != spec['bundle']:
        raise RuntimeError('Prepared online bundle differs from pinned output checksums')
    manifest = {'specification': spec, 'files': files}
    # No writes to the generated bundle until every input has been verified.
    target = ROOT / 'web/vendor/zipformer-en'
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for name, content in bundle.items():
        (target / name).write_bytes(content)
    (target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Staged English online Zipformer: {sum(len(b) for b in bundle.values()):,} bytes')


if __name__ == '__main__':
    main()
