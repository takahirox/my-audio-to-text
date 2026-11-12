#!/usr/bin/env python3
"""Maintainer-only reproduction of sherpa-runtime.tar.gz from original pinned releases.

This is deliberately outside setup/build. Original upstream archives contain model
weights; we discard their entire preload images and disable preload invocations.
The JS/WASM bytes and recognizer configurations retain the pinned runtime identity.
"""
import gzip
import hashlib
import io
from pathlib import Path
import re
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    'sherpa-ja-en': ('sherpa-onnx-wasm-main-vad-asr',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-1.13.2-vad-asr-en-moonshine_tiny.tar.bz2',
        'c388d09c952557f0aeaf7a3c796d20143a2bbed7cb0fe2eca656c26dc8beb444'),
    'zipformer-en': ('sherpa-onnx-wasm-main-asr',
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.2/sherpa-onnx-wasm-simd-v1.13.2-en-asr-zipformer.tar.bz2',
        '0ae9f835b956e43200231ad6820e6ce3c8f2225411af55c51f017266d3552caa'),
}


def strip_preload(script):
    pattern = r'loadPackage\(\{files:\[.*?\],remote_package_size:\d+\}\)'
    if len(list(re.finditer(pattern, script))) != 1:
        raise RuntimeError('Unexpected pinned sherpa preload table')
    return re.sub(pattern, '/* Models are loaded from verified Cache Storage. */', script)


def main():
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as result:
        for family, (stem, url, digest) in SOURCES.items():
            cache = ROOT / '.cache' / ('sherpa-runtime.tar.bz2' if family == 'sherpa-ja-en' else 'zipformer-runtime.tar.bz2')
            data = cache.read_bytes() if cache.exists() else urllib.request.urlopen(url, timeout=300).read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise RuntimeError('Upstream runtime archive checksum mismatch')
            names = {stem + '.js', stem + '.wasm', 'sherpa-onnx-asr.js'}
            if family == 'sherpa-ja-en':
                names.add('sherpa-onnx-vad.js')
            with tarfile.open(fileobj=io.BytesIO(data)) as package:
                files = {Path(m.name).name: package.extractfile(m).read() for m in package.getmembers()
                         if m.isfile() and Path(m.name).name in names}
            if set(files) != names:
                raise RuntimeError('Missing runtime members')
            files[stem + '.js'] = strip_preload(files[stem + '.js'].decode()).encode()
            if family == 'sherpa-ja-en':
                files['sherpa-onnx-vad.js'] = b'(function () {\n' + files['sherpa-onnx-vad.js'] + b'\nself.createVad = createVad;\n})();\n'
            for name, content in sorted(files.items()):
                entry = tarfile.TarInfo(f'{family}/{name}'); entry.size = len(content); entry.mode = 0o644
                result.addfile(entry, io.BytesIO(content))
    data = gzip.compress(output.getvalue(), mtime=0)
    # Preserve the same gzip header on Python 3.11/3.12 and 3.13+.
    data = data[:9] + b'\xff' + data[10:]
    (ROOT / 'scripts/sherpa-runtime.tar.gz').write_bytes(data)
    print('Review runtime package SHA-256:', hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    main()
