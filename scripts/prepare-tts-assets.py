#!/usr/bin/env python3
"""Stage checksum-pinned browser TTS runtimes/frontends, never model weights.

Stage tts-assets/ independently of ASR/translation vendor/ and extension packaging.
Archives are read member-by-member, with no install scripts or native addons.
"""
import hashlib
import io
import gzip
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
    ('kokoro-js-jp-0.2.0', 'https://registry.npmjs.org/kokoro-js-jp/-/kokoro-js-jp-0.2.0.tgz',
     '16223a8fae6ae58f84b62ba457463a8369dd84e9f01050be3287b6833096f59e', {
         'dist/openjtalk-wasm-wrapper-D6E3BSJO.js': 'openjtalk-wasm-wrapper-D6E3BSJO.js',
         'dist/openjtalk-wasm.wasm': 'openjtalk-wasm.wasm',
         'dist/open_jtalk_dic_utf_8-1.11.tar.gz': 'open_jtalk_dic_utf_8-1.11.tar.gz',
         'dist/openjtalk-voice.htsvoice': 'openjtalk-voice.htsvoice',
         'THIRD_PARTY_NOTICES.md': 'openjtalk-NOTICES',
     }),
]
ESPEAK_SOURCE = (
    'espeak-ng-0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582',
    'https://codeload.github.com/espeak-ng/espeak-ng/tar.gz/0dfd1d77dd7f96ef1ea6856c9fa5cfac01599582',
    'e6b84b52a87b3ad72885331bd942b2adecd70c384fa4ecfbe10aae7d9afd5e21',
)
# Generated only by scripts/tts-phonemizer/build.sh from ESPEAK_SOURCE.
ESPEAK_ENGINE_SHA256 = '33c6fbc7c26e4860908909c4375ed836f97d0dad682ba2f5eeba17ef365eb28e'


def verify(data, digest):
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError('TTS runtime archive checksum mismatch')
    return data


def stage(data, digest, members):
    verify(data, digest)
    with tarfile.open(fileobj=io.BytesIO(data)) as package:
        return {target: package.extractfile('package/' + source).read()
                for source, target in members.items()}


def fetch(name, url, digest):
    archive = ROOT / '.cache' / f'tts-{name}.tgz'
    data = verify(archive.read_bytes() if archive.exists()
                  else urllib.request.urlopen(url, timeout=120).read(), digest)
    if not archive.exists():
        archive.write_bytes(data)
    return data


def english_frontend(source):
    # Fail closed: never stage the executable without its matching full source,
    # data, build/installation scripts and adapter on the same Pages origin.
    verify(source, ESPEAK_SOURCE[2])
    inputs = ROOT / 'scripts' / 'tts-phonemizer'
    engine = verify((inputs / 'phonemizer-engine.mjs').read_bytes(), ESPEAK_ENGINE_SHA256)
    members = {'espeak-ng.tar.gz': source}
    for name in ['README.md', 'Dockerfile', 'build.sh', 'phonemizer.js']:
        members[name] = (inputs / name).read_bytes()
    members['ENGINE-SHA256.txt'] = (ESPEAK_ENGINE_SHA256 + '  phonemizer-engine.mjs\n').encode()
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name, data in sorted(members.items()):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o755 if name == 'build.sh' else 0o644
            archive.addfile(entry, io.BytesIO(data))
    return {'phonemizer.js': members['phonemizer.js'], 'phonemizer-engine.mjs': engine,
            'phonemizer-source.tar.gz': gzip.compress(buffer.getvalue(), mtime=0)}


def main():
    (ROOT / '.cache').mkdir(exist_ok=True)
    files = {}
    for name, url, digest, members in PACKAGES:
        files.update(stage(fetch(name, url, digest), digest, members))
    files.update(english_frontend(fetch(*ESPEAK_SOURCE)))
    target = ROOT / 'web' / 'tts-assets'
    target.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        (target / name).write_bytes(data)
    # Remove the former npm wrapper's notice when restaging an existing tree.
    (target / 'phonemizer-LICENSE').unlink(missing_ok=True)
    print(f'Staged pinned TTS assets: {sum(map(len, files.values())):,} bytes')


if __name__ == '__main__':
    main()
