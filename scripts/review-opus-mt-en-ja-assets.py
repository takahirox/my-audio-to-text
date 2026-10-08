#!/usr/bin/env python3
"""Explicit maintainer verification of the pinned English → Japanese assets.

Not called by build/install. Compare upstream metadata and downloaded bytes with
our reviewed manifest; never silently accept a new revision or changed hashes.
Weights remain in .cache and are not packaged into the extension.
"""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
MODEL = 'Kadonox/opus-tatoeba-en-ja-onnx'
REVISION = '225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e'


def main():
    entries = json.loads((ROOT / 'extension/opus-mt-en-ja-assets.json').read_text())
    with urllib.request.urlopen(f'https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true', timeout=120) as response:
        metadata = json.load(response)
    if metadata['sha'] != REVISION or metadata.get('gated'):
        raise RuntimeError('Unexpected revision or gated distribution')
    upstream = {file['rfilename']: file for file in metadata['siblings']}
    for file in entries:
        name = file['path']
        remote = upstream[name]
        if remote['size'] != file['bytes'] or (remote.get('lfs') and remote['lfs']['sha256'] != file['sha256']):
            raise RuntimeError(f'Upstream metadata mismatch: {name}')
        path = ROOT / '.cache' / 'opus-tatoeba-en-ja' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            temporary = path.with_suffix(path.suffix + '.partial')
            try:
                with urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}', timeout=300) as response, temporary.open('wb') as target:
                    while chunk := response.read(1024 * 1024):
                        target.write(chunk)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        digest, hashes, size = hashlib.sha256(), [], 0
        with path.open('rb') as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
                size += len(chunk)
                hashes.append(hashlib.sha256(chunk).hexdigest())
        if size != file['bytes'] or digest.hexdigest() != file['sha256'] or hashes != file['sha256Chunks']:
            raise RuntimeError(f'Checksum mismatch: {name}; remove corrupt local file before retrying')
        print(f'Verified {name}: {size:,} bytes, SHA-256 {digest.hexdigest()}', flush=True)
    print(f'Verified {MODEL}@{REVISION}: {sum(file["bytes"] for file in entries):,} bytes')


if __name__ == '__main__':
    main()
