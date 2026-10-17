#!/usr/bin/env python3
"""Opt-in real-model validation downloads. Never used by extension setup/build.

Pins are reviewed in extension/*-assets.json; no mutable catalog resolution.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def verify(path, entry):
    if not path.is_file() or path.stat().st_size != entry['bytes']:
        return False
    hashes, digest = [], hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024 * 1024):
            hashes.append(hashlib.sha256(block).hexdigest())
            digest.update(block)
    return hashes == entry['sha256Chunks'] and digest.hexdigest() == entry['sha256']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['parakeet-v3', 'moonshine-medium-en', 'both'], default='both')
    args = parser.parse_args()
    for key in (['parakeet-v3', 'moonshine-medium-en'] if args.model == 'both' else [args.model]):
        manifest = json.loads((ROOT / f'extension/{key}-assets.json').read_text())
        for entry in manifest['files']:
            target = ROOT / '.cache/new-asr' / key / entry['path']
            if verify(target, entry):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            partial = target.with_suffix(target.suffix + '.partial')
            url = entry.get('sourceURL') or f'{manifest["origin"]}/{manifest["id"]}/resolve/{manifest["revision"]}/{entry["path"]}'
            print(f'{key}: downloading {entry["path"]} ({entry["bytes"]:,} bytes)', flush=True)
            try:
                subprocess.run(['curl', '--fail', '--location', '--output', str(partial), url], check=True)
                if not verify(partial, entry):
                    raise RuntimeError(f'Checksum mismatch: {entry["path"]}; upstream bytes differ from pin')
                partial.replace(target)
            finally:
                partial.unlink(missing_ok=True)
    print('Verified optional ASR test weights. Prepare Zipformer fixtures separately.')


if __name__ == '__main__':
    main()
