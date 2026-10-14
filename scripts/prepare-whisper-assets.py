#!/usr/bin/env python3
"""Stage checksum-pinned multilingual Whisper tiny q8 for offline MV3 ASR.

Run after prepare-assets (which resets vendor). Runtime comes from the existing
pinned prepare-translation-assets workflow. No model downloads at session start.
"""
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    spec = json.loads((ROOT / 'scripts/whisper-assets.json').read_text())
    cache = ROOT / '.cache/whisper' / spec['revision']
    for entry in spec['files']:
        target = cache / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            url = f"{spec['source']}/resolve/{spec['revision']}/{entry['path']}"
            print(f"Downloading Whisper: {entry['path']}", flush=True)
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read()
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise RuntimeError(f"Checksum mismatch: {entry['path']}")
            target.write_bytes(data)
        data = target.read_bytes()
        if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise RuntimeError(f"Checksum mismatch: {target}; remove it before retrying")
    target = ROOT / 'web/vendor/whisper/tiny'
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    for entry in spec['files']:
        output = target / entry['path']
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(cache / entry['path'], output)
    (target.parent / 'manifest.json').write_text(json.dumps(spec, indent=2) + '\n')
    print(f"Staged Whisper tiny q8: {sum(e['bytes'] for e in spec['files']):,} bytes")


if __name__ == '__main__':
    main()
