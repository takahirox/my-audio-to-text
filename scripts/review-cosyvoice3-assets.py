#!/usr/bin/env python3
"""Reproduce the reviewed CosyVoice3 chunk manifest; explicitly downloads weights.

All sources, byte sizes and full digests must already be reviewed in
docs/cosyvoice3-artifacts.json. Never fetch main or infer runtime readiness.
"""
import hashlib
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CHUNK = 1024 * 1024


def main():
    reviewed = json.loads((ROOT / 'docs/cosyvoice3-artifacts.json').read_text())
    files = []
    for entry in reviewed['files']:
        target = Path(os.environ.get('COSYVOICE3_MODEL_DIR', ROOT / '.cache/cosyvoice3-models')) / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            print(f"Downloading reviewed CosyVoice3 {entry['path']}", flush=True)
            partial = target.with_name(target.name + '.partial')
            with urllib.request.urlopen(entry['sourceURL'], timeout=120) as response, partial.open('wb') as output:
                while chunk := response.read(CHUNK):
                    output.write(chunk)
            partial.replace(target)
        digest, chunks, size = hashlib.sha256(), [], 0
        with target.open('rb') as source:
            while chunk := source.read(CHUNK):
                digest.update(chunk)
                chunks.append(hashlib.sha256(chunk).hexdigest())
                size += len(chunk)
        if size != entry['bytes'] or digest.hexdigest() != entry['sha256']:
            raise RuntimeError(f"Reviewed size/hash mismatch: {entry['path']}; remove the cached file before retrying")
        file = {'path': entry['path'], 'bytes': size, 'sha256Chunks': chunks}
        canonical = f"https://huggingface.co/{reviewed['id']}/resolve/{reviewed['revision']}/{entry['path']}"
        if entry['sourceURL'] != canonical:
            file['sourceURL'] = entry['sourceURL']
        files.append(file)
    manifest = {'id': reviewed['id'], 'revision': reviewed['revision'], 'files': files}
    (ROOT / 'extension/cosyvoice3-assets.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    main()
