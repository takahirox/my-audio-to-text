#!/usr/bin/env python3
"""Stage checksum-pinned browser TTS runtimes/frontends, never model weights.

Stage tts-assets/ independently of ASR/translation vendor/ and extension packaging.
Archives are read member-by-member, with no install scripts or native addons.
"""
import hashlib
import io
from pathlib import Path
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PACKAGES = [
    ('transformers-3.8.1', 'https://registry.npmjs.org/@huggingface/transformers/-/transformers-3.8.1.tgz',
     '207714c36765b87accfd9b7b0672c3505805af97140990e0d9f8ac6e3cd5471e', {
         'dist/transformers.min.js': 'transformers.js',
         'dist/ort-wasm-simd-threaded.jsep.mjs': 'ort-wasm-simd-threaded.jsep.mjs',
         'dist/ort-wasm-simd-threaded.jsep.wasm': 'ort-wasm-simd-threaded.jsep.wasm',
         'LICENSE': 'transformers-LICENSE',
     }),
    ('ort-1.22.0-dev.20250409-89f8206ba4', 'https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-1.22.0-dev.20250409-89f8206ba4.tgz',
     '9758fa28ba1acc1b5c9ffef8d60c97b56fd2105a9476a690ed4db16a5588ae10', {
         'dist/ort.wasm.min.mjs': 'ort.mjs',
         'dist/ort.bundle.min.mjs': 'ort.bundle.min.mjs',
         'dist/ort-wasm-simd-threaded.mjs': 'ort-wasm-simd-threaded.mjs',
         'dist/ort-wasm-simd-threaded.wasm': 'ort-wasm-simd-threaded.wasm',
     }),
    ('phonemizer-1.2.1', 'https://registry.npmjs.org/phonemizer/-/phonemizer-1.2.1.tgz',
     '12f9f3582f8b5d557a0577180d83ff0458a4a5c15b2efb625ee71c3ebbee22e9', {
         'dist/phonemizer.js': 'phonemizer.js', 'LICENSE': 'phonemizer-LICENSE',
     }),
    ('kokoro-js-jp-0.2.0', 'https://registry.npmjs.org/kokoro-js-jp/-/kokoro-js-jp-0.2.0.tgz',
     '16223a8fae6ae58f84b62ba457463a8369dd84e9f01050be3287b6833096f59e', {
         'dist/openjtalk-wasm-wrapper-D6E3BSJO.js': 'openjtalk-wasm-wrapper-D6E3BSJO.js',
         'dist/openjtalk-wasm.wasm': 'openjtalk-wasm.wasm',
         'dist/open_jtalk_dic_utf_8-1.11.tar.gz': 'open_jtalk_dic_utf_8-1.11.tar.gz',
         'dist/openjtalk-voice.htsvoice': 'openjtalk-voice.htsvoice',
         'THIRD_PARTY_NOTICES.md': 'openjtalk-NOTICES',
     }),
]


def stage(data, digest, members):
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('TTS runtime archive checksum mismatch')
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        return {target: package.extractfile('package/' + source).read()
                for source, target in members.items()}


def main():
    cache = ROOT / '.cache'
    cache.mkdir(exist_ok=True)
    files = {}
    for name, url, digest, members in PACKAGES:
        archive = cache / f'tts-{name}.tgz'
        data = archive.read_bytes() if archive.exists() else urllib.request.urlopen(url, timeout=120).read()
        files.update(stage(data, digest, members))
        if not archive.exists():
            archive.write_bytes(data)
    target = ROOT / 'web' / 'tts-assets'
    target.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (target / name).write_bytes(data)
    print(f'Staged pinned TTS assets: {sum(map(len, files.values())):,} bytes')


if __name__ == '__main__':
    main()
