#!/usr/bin/env python3
"""Opt-in review of official pinned GGUF, embedded tokenizer and PFML3 metadata.

Downloads 1.81 GB to ignored .cache/, never to an extension/page artifact.
Compares the whole-file upstream LFS digest and every committed 1 MiB digest.
"""
import hashlib
import json
from pathlib import Path
import struct
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = 'pfnet/plamo-3-translate-2b-GGUF'
REVISION = '4f672106b847200bfdc0f6af6c321cd94eba1aed'
SHA256 = '1ffd9073afcc70e35ccc942428aa2b73d7aa2b9ea779bf504b775369e0276c13'


def embedded_chat_template(path):
    """Read GGUF metadata only; never load tensor data into Python memory."""
    with path.open('rb') as source:
        def number(fmt):
            return struct.unpack('<' + fmt, source.read(struct.calcsize('<' + fmt)))[0]

        def string(keep=True):
            length = number('Q')
            if keep:
                return source.read(length).decode('utf-8')
            source.seek(length, 1)

        def value(kind, keep=False):
            if kind == 8:
                return string(keep)
            if kind == 9:
                item_kind, count = number('I'), number('Q')
                for _ in range(count):
                    value(item_kind)
            else:
                source.seek({0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4,
                             7: 1, 10: 8, 11: 8, 12: 8}[kind], 1)

        assert source.read(4) == b'GGUF' and number('I') == 3
        number('Q')  # Tensor count; metadata precedes tensors.
        for _ in range(number('Q')):
            key, kind = string(), number('I')
            if key == 'tokenizer.chat_template':
                assert kind == 8
                return value(kind, keep=True)
            value(kind)
    raise AssertionError('GGUF is missing tokenizer.chat_template')


def main():
    files = json.loads((ROOT / 'extension/plamo-assets.json').read_text())
    assert len(files) == 1
    expected = files[0]
    name = expected['path']
    metadata = json.load(urllib.request.urlopen(f'https://huggingface.co/api/models/{REPO}/revision/{REVISION}?blobs=true'))
    remote = next(file for file in metadata['siblings'] if file['rfilename'] == name)
    assert metadata['sha'] == REVISION and remote['lfs']['sha256'] == SHA256
    assert remote['size'] == expected['bytes']
    cache = ROOT / '.cache/plamo-review'
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / name
    if not target.exists():
        partial = target.with_suffix('.part')
        with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{name}', timeout=120) as response, partial.open('wb') as out:
            while chunk := response.read(1024 * 1024):
                out.write(chunk)
        partial.replace(target)
    whole, chunks, size = hashlib.sha256(), [], 0
    with target.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            whole.update(chunk)
            chunks.append(hashlib.sha256(chunk).hexdigest())
            size += len(chunk)
    assert whole.hexdigest() == SHA256 and size == expected['bytes']
    assert chunks == expected['sha256Chunks']
    assert embedded_chat_template(target) == (ROOT / 'web/plamo-chat-template.jinja').read_text(), 'Embedded GGUF template differs from pinned official template'
    for remote, local in [('LICENSE/en', 'web/licenses/plamo-community-en.txt'),
                          ('LICENSE/ja', 'web/licenses/plamo-community-ja.txt'),
                          ('chat_template.jinja', 'web/plamo-chat-template.jinja')]:
        content = urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{remote}', timeout=60).read()
        assert content == (ROOT / local).read_bytes(), f'Pinned metadata mismatch: {remote}'
    print(f'Verified official {REPO}@{REVISION}: {size:,} bytes, SHA-256 {SHA256}; tokenizer embedded in GGUF; matching template/licenses.')


if __name__ == '__main__':
    main()
