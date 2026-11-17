#!/usr/bin/env python3
"""Opt-in review of official pinned GGUF, embedded tokenizer and PFML3 metadata.

Downloads 1.81 GB to ignored .cache/, never to an extension/page artifact.
Compares the whole-file upstream LFS digest and every committed 1 MiB digest.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPO = 'pfnet/plamo-3-translate-2b-GGUF'
REVISION = '4f672106b847200bfdc0f6af6c321cd94eba1aed'
SHA256 = '1ffd9073afcc70e35ccc942428aa2b73d7aa2b9ea779bf504b775369e0276c13'


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
    for remote, local in [('LICENSE/en', 'web/licenses/plamo-community-en.txt'),
                          ('LICENSE/ja', 'web/licenses/plamo-community-ja.txt'),
                          ('chat_template.jinja', 'web/plamo-chat-template.jinja')]:
        content = urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{REVISION}/{remote}', timeout=60).read()
        assert content == (ROOT / local).read_bytes(), f'Pinned metadata mismatch: {remote}'
    print(f'Verified official {REPO}@{REVISION}: {size:,} bytes, SHA-256 {SHA256}; tokenizer embedded in GGUF; matching template/licenses.')


if __name__ == '__main__':
    main()
