#!/usr/bin/env python3
"""Verify immutable remote asset metadata and small tokenizer/config checksums."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    manifest = json.loads((ROOT / 'scripts/correction-assets.json').read_text())
    model, revision = manifest['id'], manifest['revision']
    url = f'https://huggingface.co/api/models/{model}/revision/{revision}?blobs=true'
    with urllib.request.urlopen(url, timeout=120) as response:
        metadata = json.load(response)
    if metadata['sha'] != revision:
        raise RuntimeError('Revision mismatch')
    files = {asset['rfilename']: asset for asset in metadata['siblings']}
    for asset in manifest['assets']:
        remote = files[asset['path']]
        if remote['size'] != asset['bytes']:
            raise RuntimeError(f"Size mismatch: {asset['path']}")
        if asset['path'].startswith('onnx/'):
            # HF immutable LFS object hash; avoid downloading 570 MB for review.
            digest = remote['lfs']['sha256']
        else:
            url = f"https://huggingface.co/{model}/resolve/{revision}/{asset['path']}"
            with urllib.request.urlopen(url, timeout=120) as response:
                digest = hashlib.sha256(response.read()).hexdigest()
        if digest != asset['sha256']:
            raise RuntimeError(f"Checksum mismatch: {asset['path']}")
        print(f"Verified {asset['path']}: {asset['bytes']:,} bytes, sha256 {digest}")


if __name__ == '__main__':
    main()
